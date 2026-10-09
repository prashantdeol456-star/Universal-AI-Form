# ML training pipeline (implemented — phase 11)

Goal: a small, self-hosted model that maps form fields better than the rules alone — trained only on **confirmed,
anonymised field structure**, evaluated fairly, and promoted by a person. We never train from scratch and never
deploy automatically.

```
learning_examples (phase 9: label, section, type, options, target key — never values)
  │  npm run ml -- dataset            eligible → clean (PII check) → dedupe → conflicts → split → JSONL + manifest
  ▼                                    (training_datasets + training_dataset_examples, status VALIDATED)
ml/datasets/<name>-vN/  train.jsonl validation.jsonl test.jsonl  *-fields.jsonl  manifest.json
  │  python ml/training/train_lora.py  (GPU box: LoRA / QLoRA on e.g. Qwen2.5-7B-Instruct)
  ▼
ml/outputs/<run>/adapter
  │  python ml/inference/predict.py  → predictions-test.jsonl
  │  npm run ml -- register / evaluate          (model_versions, model_evaluations)
  │  npm run ml -- promote --to STAGING | PRODUCTION   (gate: beats production, wrong-rate ≤ 2 %)
  │  python ml/scripts/export_model.py → GGUF + Modelfile → ollama create ufa-mapper:vN
  ▼
you set LOCAL_AI_MODEL=ufa-mapper:vN and restart the web container (rollback: npm run ml -- rollback)
```

## 1. Dataset (`npm run ml -- dataset`)

Code: `packages/ai/src/training/dataset.ts` (unit-tested), CLI `ml/scripts/ml.mts`.

| Step | Rule |
|---|---|
| Eligible | `APPROVED` (admin review, phase 12), or `PENDING` with **consensus**: the same label → key confirmed by ≥ 2 different people (`--min-contributors`). `REJECTED`/`REMOVED` never; users who switched off sharing are excluded |
| Clean | tidy whitespace; drop empty / > 150 chars / unknown profile keys; **drop any example whose label or section looks like personal data** (e-mail, PAN, IFSC, 7+ digit numbers); personal-looking option names are removed |
| Dedupe | same label + section + type + key merged (ids kept for traceability) |
| Conflicts | same field → different keys: keep the majority only with ≥ 80 % of contributors, otherwise drop as ambiguous |
| Split | 80/10/10 by a hash of the **label** (with a seed): the same wording never appears in both train and test |
| Records | chat format in **exactly the prompt `LocalAIProvider` sends** (`providers/prompt.ts`, version 1), small batches of 6 fields, "none" targets for non-profile fields so the model learns to abstain |
| Validate | errors: < 50 examples (override `--allow-small`), PII found, empty train/test; warnings: class > 30 %, keys with < 3 examples, no Hindi, few "none" examples |

`manifest.json` records counts, drops, the validation report, SHA-256 of every file, the seed and prompt version.

`npm run ml -- benchmark-dataset` registers the hand-written benchmark (`packages/ai/src/mapping/benchmark.json`, 105
EN/HI/Hinglish labels incl. traps) as a frozen, locked test set.

## 2. Training (GPU machine)

```bash
python -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
python ml/training/train_lora.py --dataset ml/datasets/mapping-v3 --base Qwen/Qwen2.5-7B-Instruct --out ml/outputs/qwen-mapper-v3 --qlora
```

LoRA r=16/α=32 on all attention + MLP projections, cosine schedule, 2 epochs, loss on the assistant answer only
(prompt/completion format), best checkpoint by validation loss. Refuses datasets with validation errors.
`training_info.json` stores hyper-parameters, dataset version and the train-file hash.

## 3. Evaluation (`npm run ml -- evaluate`)

One metric implementation (`packages/ai/src/training/metrics.ts`) for every model:

- `--model rules` — the deterministic engine alone (baseline)
- `--model ollama:<tag>` — any model served by Ollama, through `LocalAIProvider`
- `--model predictions:<file>` — output of `ml/inference/predict.py`

Metrics: accuracy, **wrong-mapping rate** (the one that matters), abstention, precision, recall, macro-F1, calibration
(ECE, 10 bins), per language and per category, top confusions. Results go to the dataset folder and `model_evaluations`.

## 4. Registry and promotion

| Command | Effect |
|---|---|
| `register --name --base --serving-name --dataset [--adapter --notes]` | `model_versions` row (`EVALUATING`); the dataset becomes `LOCKED` |
| `promote --name X --to STAGING` | needs an evaluation |
| `promote --name X --to PRODUCTION` | gate (`promotionDecision`): test set ≥ 50 (`ML_MIN_TEST_SIZE`), wrong-rate ≤ 2 % (`ML_MAX_WRONG_RATE`), accuracy ≥ production (+`ML_MIN_ACCURACY_GAIN`), not more wrong than production; production must have been evaluated on the **same** dataset. Old production → `RETIRED`; audited |
| `rollback` | previous production back, current → `RETIRED`; audited |
| `list` | datasets, models, recent evaluations |

Only one `PRODUCTION` row can exist (unique index). Promotion changes the registry only: the CLI prints the
`LOCAL_AI_MODEL` value to set — deploying stays a deliberate human step.

## 5. Export to Ollama

`python ml/scripts/export_model.py --base … --adapter … --out … --llama-cpp ~/llama.cpp --quant q4_k_m --tag ufa-mapper:v3`
merges the adapter, converts to GGUF with llama.cpp, quantises, and writes an Ollama `Modelfile` (temperature 0).

## 6. Vector search (pgvector)

No separate vector database: embeddings live in the same PostgreSQL (`label_embeddings`, created by migration 0011 only
where the pgvector extension exists — the production image `pgvector/pgvector:pg16` has it).

- Contents: catalog reference phrasings + **shared, verified** labels (GLOBAL/WEBSITE knowledge) — never values, never a
  user's personal mappings. 768 dimensions (`nomic-embed-text`).
- Fill it: `npm run ml -- embed-labels` (needs `LOCAL_AI_EMBED_MODEL` + Ollama); afterwards the learning job embeds newly
  shared labels automatically.
- Use: the mapping engine's semantic stage searches it next to the in-process phrases (HNSW, cosine); if pgvector is
  missing or fails, search silently stays in-process.
- Installed pgvector later? `npm run ml -- vector-setup`.
