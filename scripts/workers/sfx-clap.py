"""Embeds audio and text with a local CLAP model. Prints one JSON object on stdout.

Usage: sfx-clap.py REQUEST.json

REQUEST holds {"model": str, "audio": [absolute paths], "text": [str], "labels": [str]}.
Audio is decoded by ffmpeg to 48 kHz mono and cut into fixed 10 s windows from the start (no random
crop), whose embeddings are averaged; a shorter clip is repeat-padded by the processor. Each audio
gets its unit embedding and, when labels are given, the cosine similarity to every label prompt.
Run through uv by src/lib/audio/sfx-clap.ts, which pins the packages. Weights live in the Hugging
Face cache (HF_HOME), outside the repository.
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch
from transformers import ClapModel, ClapProcessor

RATE = 48000
WINDOW = 10 * RATE
MAX_WINDOWS = 6


def decode(path: str) -> np.ndarray:
    """Decode the input audio into the worker sample format."""
    raw = subprocess.run(  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
        ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],  # noqa: S607 -- Fixed local media tool resolved through the caller environment.
        capture_output=True,
        check=True,
        timeout=300,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def windows(signal: np.ndarray) -> list[np.ndarray]:
    """Split audio into bounded analysis windows."""
    if len(signal) <= WINDOW:
        return [signal if len(signal) else np.zeros(RATE // 10, dtype=np.float32)]
    count = min(MAX_WINDOWS, len(signal) // WINDOW)
    starts = np.linspace(0, len(signal) - WINDOW, count).astype(int)
    return [signal[start : start + WINDOW] for start in starts]


def features(output: Any) -> torch.Tensor:  # noqa: ANN401 -- Forwarded third-party ML/tokenizer values are a dynamic API boundary.
    # transformers 5 returns an output object whose pooler_output is the projected embedding.
    """Extract the model audio or text feature vectors."""
    return output if isinstance(output, torch.Tensor) else output.pooler_output


def unit(vectors: torch.Tensor) -> torch.Tensor:
    """Normalise a feature vector to unit length."""
    return vectors / vectors.norm(dim=-1, keepdim=True).clamp_min(1e-9)


def pack(vector: np.ndarray) -> str:
    """Convert the model result to serialisable vectors."""
    return base64.b64encode(vector.astype("<f4").tobytes()).decode("ascii")


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    request = json.loads(Path(sys.argv[1]).read_text())
    torch.manual_seed(0)
    model = ClapModel.from_pretrained(request["model"]).eval()
    processor = ClapProcessor.from_pretrained(request["model"])
    texts: list[str] = request.get("text", [])
    labels: list[str] = request.get("labels", [])
    with torch.no_grad():

        def embed_text(items: list[str]) -> torch.Tensor:
            if not items:
                return torch.zeros((0, model.config.projection_dim))
            inputs = processor(text=items, return_tensors="pt", padding=True)
            return unit(features(model.get_text_features(**inputs)))

        text_vectors = embed_text(texts)
        label_vectors = embed_text(labels)
        audio: dict[str, Any] = {}
        for path in request.get("audio", []):
            try:
                chunks = windows(decode(path))
                inputs = processor(audio=chunks, sampling_rate=RATE, return_tensors="pt")
                vector = unit(unit(features(model.get_audio_features(**inputs))).mean(dim=0, keepdim=True))
                item: dict[str, Any] = {"embedding": pack(vector[0].numpy())}
                if labels:
                    item["labelScores"] = [round(float(score), 4) for score in (vector @ label_vectors.T)[0]]
                audio[path] = item
            except Exception as error:  # noqa: BLE001 - one bad file must not sink the batch
                audio[path] = {"error": str(error)[:300]}
    json.dump(
        {
            "model": request["model"],
            "dims": int(model.config.projection_dim),
            "logitScale": float(model.logit_scale_a.exp()) if hasattr(model, "logit_scale_a") else None,
            "text": [pack(vector.numpy()) for vector in text_vectors],
            "audio": audio,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
