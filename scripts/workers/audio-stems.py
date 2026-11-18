"""Splits a track into drums, bass, other and vocals with Demucs. Prints one JSON object on stdout.

Usage: audio-stems.py WAV OUT_DIR MODEL

WAV is 44.1 kHz stereo, decoded by src/lib/audio-map/stems.ts, which also pins the packages
and caches OUT_DIR by the audio's hash. No random shifts and a fixed overlap, so a rerun
gives the same stems. Runs on the CPU: MPS results differ from run to run.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model


def main() -> None:
    """Split WAV into the model's stems under OUT_DIR and print one JSON line."""
    source, out_dir, name = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    started = time.monotonic()
    torch.manual_seed(0)
    model = get_model(name)
    model.eval()
    samples, rate = soundfile.read(source, dtype="float32", always_2d=True)
    if rate != model.samplerate:
        msg = f"Expected {model.samplerate} Hz, got {rate}"
        raise SystemExit(msg)
    mix = torch.from_numpy(np.ascontiguousarray(samples.T))
    if mix.shape[0] == 1:
        mix = mix.repeat(2, 1)
    reference = mix.mean(0)
    mean, std = reference.mean(), reference.std().clamp_min(1e-8)
    with torch.no_grad():
        stems = apply_model(model, ((mix - mean) / std)[None], shifts=0, split=True, overlap=0.25, progress=False, device="cpu")[0]
    stems = stems * std + mean
    out_dir.mkdir(parents=True, exist_ok=True)
    written = {}
    for stem_name, stem in zip(model.sources, stems, strict=True):
        target = out_dir / f"{stem_name}.wav"
        soundfile.write(target, stem.numpy().T, model.samplerate, subtype="PCM_16")
        written[stem_name] = str(target)
    sys.stdout.write(json.dumps({"model": name, "sources": list(model.sources), "stems": written, "elapsedSec": round(time.monotonic() - started, 2)}) + "\n")


if __name__ == "__main__":
    main()
