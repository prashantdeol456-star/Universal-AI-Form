"""
Merges a LoRA adapter into its base model and prepares it for Ollama (the
runtime LocalAIProvider talks to). Conversion to GGUF uses llama.cpp's
converter, which you clone once on the GPU box.

    python ml/scripts/export_model.py \
        --base Qwen/Qwen2.5-7B-Instruct \
        --adapter ml/outputs/qwen-mapper-v3/adapter \
        --out ml/outputs/qwen-mapper-v3/export \
        --llama-cpp ~/llama.cpp --quant q4_k_m \
        --tag ufa-mapper:v3

Then, on the machine running Ollama:
    ollama create ufa-mapper:v3 -f ml/outputs/qwen-mapper-v3/export/Modelfile
and register / evaluate / promote it with `npm run ml -- ...`. Promotion never
deploys: you set LOCAL_AI_MODEL=ufa-mapper:v3 yourself after it passes the gate.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

MODELFILE = """FROM ./{gguf}
# Deterministic answers for field mapping (LocalAIProvider also sends temperature 0).
PARAMETER temperature 0
PARAMETER num_ctx 8192
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", required=True)
    p.add_argument("--adapter", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--llama-cpp", help="path to a llama.cpp checkout (for convert_hf_to_gguf.py and llama-quantize)")
    p.add_argument("--quant", default="q4_k_m")
    p.add_argument("--tag", default="ufa-mapper:latest")
    args = p.parse_args()

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    out = Path(args.out)
    merged = out / "merged"
    merged.mkdir(parents=True, exist_ok=True)
    base = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.float16)
    model = PeftModel.from_pretrained(base, args.adapter).merge_and_unload()
    model.save_pretrained(str(merged), safe_serialization=True)
    AutoTokenizer.from_pretrained(args.adapter).save_pretrained(str(merged))
    print(f"Merged model saved to {merged}")

    if not args.llama_cpp:
        print("No --llama-cpp given: stopping after the merge. Convert to GGUF with llama.cpp's convert_hf_to_gguf.py.")
        return
    llama = Path(args.llama_cpp).expanduser()
    f16 = out / "model-f16.gguf"
    final = out / f"model-{args.quant}.gguf"
    subprocess.run([sys.executable, str(llama / "convert_hf_to_gguf.py"), str(merged), "--outfile", str(f16), "--outtype", "f16"], check=True)
    quantize = next((q for q in [llama / "build/bin/llama-quantize", llama / "llama-quantize"] if q.exists()), None)
    if quantize:
        subprocess.run([str(quantize), str(f16), str(final), args.quant.upper()], check=True)
    else:
        final = f16
        print("llama-quantize not found: using the f16 GGUF (larger, slower).")
    (out / "Modelfile").write_text(MODELFILE.format(gguf=final.name), encoding="utf-8")
    print(f"GGUF ready: {final}\nCreate the Ollama model:  ollama create {args.tag} -f {out / 'Modelfile'}")


if __name__ == "__main__":
    main()
