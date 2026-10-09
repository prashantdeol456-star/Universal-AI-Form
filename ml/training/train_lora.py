"""
LoRA / QLoRA fine-tuning of an open instruction model on a dataset built by
`npm run ml -- dataset` (chat records in the exact prompt LocalAIProvider uses).

Never trains from scratch, never sees user values: the dataset contains field
labels, sections, types, option names and target profile keys only.

    python ml/training/train_lora.py \
        --dataset ml/datasets/mapping-v3 \
        --base Qwen/Qwen2.5-7B-Instruct \
        --out ml/outputs/qwen-mapper-v3 \
        [--qlora] [--epochs 2] [--lr 2e-4] [--rank 16]

Output: a PEFT adapter in --out/adapter plus training_info.json. Next steps:
    python ml/inference/predict.py --base ... --adapter --out/adapter --dataset ... --split test
    npm run ml -- evaluate --dataset ... --model predictions:<file> --name <model name>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dataset", required=True, help="dataset directory with train.jsonl / validation.jsonl / manifest.json")
    p.add_argument("--base", required=True, help="Hugging Face model id or local path (an instruction-tuned chat model)")
    p.add_argument("--out", required=True, help="output directory")
    p.add_argument("--qlora", action="store_true", help="4-bit QLoRA (needs bitsandbytes + CUDA)")
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--alpha", type=int, default=32)
    p.add_argument("--batch", type=int, default=4)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--max-len", type=int, default=4096)
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    args = parse_args()
    ds_dir = Path(args.dataset)
    manifest = json.loads((ds_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("report", {}).get("errors"):
        raise SystemExit(f"Dataset has validation errors, refusing to train: {manifest['report']['errors']}")

    # Heavy imports only after argument checks.
    import torch
    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    torch.manual_seed(args.seed)
    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    quant = (
        BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
        if args.qlora
        else None
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=quant,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )

    data = load_dataset(
        "json",
        data_files={"train": str(ds_dir / "train.jsonl"), "validation": str(ds_dir / "validation.jsonl")},
    )

    # Conversational prompt/completion pairs: TRL then computes the loss on the
    # assistant's answer only (not on the long, constant system prompt).
    data = data.map(lambda r: {"prompt": r["messages"][:2], "completion": r["messages"][2:]}, remove_columns=["messages"])

    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    out = Path(args.out)
    cfg = SFTConfig(
        output_dir=str(out / "checkpoints"),
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=2,
        load_best_model_at_end=True,
        bf16=torch.cuda.is_available(),
        max_length=args.max_len,
        completion_only_loss=True,
        seed=args.seed,
        report_to=[],
    )
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=data["train"], eval_dataset=data["validation"], peft_config=lora, processing_class=tokenizer)
    started = time.time()
    trainer.train()
    metrics = trainer.evaluate()

    adapter_dir = out / "adapter"
    trainer.model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))
    info = {
        "base": args.base,
        "dataset": str(ds_dir),
        "dataset_version": manifest.get("version"),
        "prompt_version": manifest.get("promptVersion"),
        "train_sha256": sha256(ds_dir / "train.jsonl"),
        "qlora": args.qlora,
        "hyperparameters": {k: getattr(args, k) for k in ("epochs", "lr", "rank", "alpha", "batch", "grad_accum", "max_len", "seed")},
        "eval": metrics,
        "minutes": round((time.time() - started) / 60, 1),
    }
    (out / "training_info.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    print(f"Adapter saved to {adapter_dir}. Validation loss: {metrics.get('eval_loss')}")


if __name__ == "__main__":
    main()
