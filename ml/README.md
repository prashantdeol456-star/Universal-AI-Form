# ml/ — training pipeline

Full guide: [docs/ML_TRAINING.md](../docs/ML_TRAINING.md).

| Path | What |
|---|---|
| `scripts/ml.mts` | CLI (`npm run ml -- <command>`): dataset, benchmark-dataset, evaluate, register, promote, rollback, list, vector-setup, embed-labels |
| `training/train_lora.py` | LoRA / QLoRA fine-tuning (GPU machine) |
| `inference/predict.py` | predictions for a dataset split → `evaluate --model predictions:<file>` |
| `scripts/export_model.py` | merge adapter → GGUF → Ollama `Modelfile` |
| `requirements.txt` | Python dependencies (training only; the web app never needs Python) |
| `datasets/`, `evaluation/`, `outputs/` | generated, git-ignored |

Datasets contain field structure only (labels, sections, types, options, target keys) — never user values.
