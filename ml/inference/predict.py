"""
Runs a (fine-tuned) model over a dataset split and writes predictions for
`npm run ml -- evaluate --model predictions:<file>`. Uses exactly the prompt
from the dataset's chat records (same as LocalAIProvider in production).

    python ml/inference/predict.py --base Qwen/Qwen2.5-7B-Instruct \
        --adapter ml/outputs/qwen-mapper-v3/adapter \
        --dataset ml/datasets/mapping-v3 --split test \
        --out ml/outputs/qwen-mapper-v3/predictions-test.jsonl

Each output line: {"id": "<split>-<n>", "predicted": "<key>|none", "confidence": 0..1}
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

BATCH = 6  # fields per prompt, like the training records


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", required=True)
    p.add_argument("--adapter", help="PEFT adapter directory (omit to evaluate the base model)")
    p.add_argument("--dataset", required=True)
    p.add_argument("--split", default="test", choices=["validation", "test"])
    p.add_argument("--out", required=True)
    p.add_argument("--max-new-tokens", type=int, default=512)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    ds = Path(args.dataset)
    fields = [json.loads(line) for line in (ds / f"{args.split}-fields.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    system = json.loads((ds / "train.jsonl").read_text(encoding="utf-8").splitlines()[0])["messages"][0]["content"]
    allowed = {line.split(" = ")[0] for line in system.split("Allowed keys:\n", 1)[1].splitlines() if " = " in line}

    tok = AutoTokenizer.from_pretrained(args.adapter or args.base)
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32, device_map="auto" if torch.cuda.is_available() else None)
    if args.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()

    out = []
    for i in range(0, len(fields), BATCH):
        batch = fields[i : i + BATCH]
        user = json.dumps(
            [{"field_id": f"f{j + 1}", "label": f["label"], "section": f["section"], "type": f["type"] or "text", "options": f["options"][:12]} for j, f in enumerate(batch)],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        prompt = tok.apply_chat_template([{"role": "system", "content": system}, {"role": "user", "content": user}], tokenize=False, add_generation_prompt=True)
        inputs = tok(prompt, return_tensors="pt").to(model.device)
        with torch.no_grad():
            gen = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
        text = tok.decode(gen[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True)
        try:
            mappings = {m["field_id"]: m for m in json.loads(text[text.index("{") : text.rindex("}") + 1])["mappings"]}
        except (ValueError, KeyError, TypeError):
            mappings = {}  # unparseable output counts as "none" (abstain), never as a guess
        for j, f in enumerate(batch):
            m = mappings.get(f"f{j + 1}", {})
            key = m.get("profile_field", "none")
            if key not in allowed:
                key = "none"
            out.append({"id": f["id"], "predicted": key, "confidence": float(m.get("confidence", 0) or 0)})
        print(f"\r{min(i + BATCH, len(fields))}/{len(fields)}", end="", flush=True)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text("\n".join(json.dumps(o) for o in out) + "\n", encoding="utf-8")
    print(f"\nWrote {len(out)} predictions to {args.out}")


if __name__ == "__main__":
    main()
