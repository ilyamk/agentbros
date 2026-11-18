"""Subject or person alpha mattes with BiRefNet through onnxruntime. Prints one JSON object on stdout.

Usage: frame-matte-onnx.py REQUEST.json

REQUEST holds {"model": absolute .onnx path, "size": 1024, "threads": int, "frames": [{"input": abs, "output": abs.png}]}.
Run through uvx by src/lib/matte/onnx.ts, which pins the packages and checks the model's sha256 first. The session
is created once for the whole batch, on the CPU provider only, so the same frame gives the same matte on every OS.
Each output is an 8-bit grey alpha PNG at the input's pixel size (255 = subject).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def session(model: str, threads: int) -> ort.InferenceSession:
    """One CPU session for the batch; CPU only so results match across operating systems."""
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    return ort.InferenceSession(model, sess_options=options, providers=["CPUExecutionProvider"])


def prepare(image: Image.Image, size: int) -> np.ndarray:
    """RGB resized to the model's square input, ImageNet-normalised, NCHW float32."""
    resized = image.convert("RGB").resize((size, size), Image.Resampling.BILINEAR)
    pixels = (np.asarray(resized, dtype=np.float32) / 255.0 - MEAN) / STD
    return pixels.transpose(2, 0, 1)[None, ...].astype(np.float32)


def alpha(logits: np.ndarray, width: int, height: int) -> np.ndarray:
    """Turn the model's last output (logits) into an 8-bit alpha at the source size: sigmoid, then bilinear."""
    probability = 1.0 / (1.0 + np.exp(-logits[0, 0].astype(np.float64)))
    small = Image.fromarray((np.clip(probability, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8))
    return np.asarray(small.resize((width, height), Image.Resampling.BILINEAR), dtype=np.uint8)


def main(request_file: str) -> dict[str, Any]:
    """Run every frame of the request through one session; progress lines go to stderr."""
    request = json.loads(Path(request_file).read_text(encoding="utf-8"))
    size = int(request.get("size", 1024))
    started = time.perf_counter()
    model = session(request["model"], int(request.get("threads", 4)))
    load_ms = (time.perf_counter() - started) * 1000
    input_name = model.get_inputs()[0].name
    frames = []
    total = len(request["frames"])
    for index, frame in enumerate(request["frames"]):
        begun = time.perf_counter()
        with Image.open(frame["input"]) as source:
            source.load()
            width, height = source.size
            tensor = prepare(source, size)
        logits = model.run(None, {input_name: tensor})[-1]
        if not isinstance(logits, np.ndarray):
            message = "Matte model must return a dense tensor"
            raise ValueError(message)  # noqa: TRY004 -- The worker uses ValueError for invalid protocol/domain values.
        mask = alpha(logits, width, height)
        output = Path(frame["output"])
        temporary = output.with_suffix(".tmp.png")
        Image.fromarray(mask).save(temporary, format="PNG")
        temporary.replace(output)
        elapsed = (time.perf_counter() - begun) * 1000
        frames.append({"output": str(output), "width": width, "height": height, "coverage": float((mask >= 128).mean()), "ms": elapsed})  # noqa: PLR2004
        sys.stderr.write(f"matte {index + 1}/{total} {elapsed:.0f} ms\n")
        sys.stderr.flush()
    return {"version": 1, "runtime": {"engine": "onnxruntime", "onnxruntime": ort.__version__, "provider": "CPUExecutionProvider", "size": size, "loadMs": load_ms}, "frames": frames}


if __name__ == "__main__":
    sys.stdout.write(json.dumps(main(sys.argv[1]), sort_keys=True) + "\n")
