"""Local speech layers of one 16 kHz mono WAV. Prints one JSON object on stdout.

Usage: speech-local.py asr WAV REQUEST.json
       speech-local.py vad WAV REQUEST.json
       speech-local.py diarize WAV REQUEST.json

Run through uvx by src/lib/speech/local.ts, which pins the packages per operation.
Model weights are downloaded at pinned revisions into the request's cacheDir.
"""

from __future__ import annotations

import json
import os
import sys
import time
import wave
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable

PCM_SAMPLE_BYTES = 2


def read_wav(path: str) -> tuple[Any, int]:
    """Read and validate the worker PCM WAV input."""
    import numpy as np

    with wave.open(path, "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != PCM_SAMPLE_BYTES:
            error_message = "expected 16-bit mono PCM"
            raise RuntimeError(error_message)
        rate = audio.getframerate()
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0, rate


def join_tokens(tokens: list[Any], offset: float, limit: float) -> list[dict[str, Any]]:
    """Join timed model tokens into transcript segments."""
    words: list[dict[str, Any]] = []
    for token in tokens:
        text = token.text
        if not text.strip():
            continue
        start, end = offset + token.start, min(limit, offset + token.end)
        if words and not text.startswith(" "):
            word = words[-1]
            word["text"] += text
            word["end"] = max(word["end"], end)
            word["confidences"].append(token.confidence)
            continue
        words.append({"text": text.strip(), "start": start, "end": max(start, end), "confidences": [token.confidence]})
    for word in words:
        word["confidence"] = min(word.pop("confidences"))
    return words


def asr(media: str, request: dict[str, Any]) -> dict[str, Any]:
    """Transcribe with the explicitly selected local speech model."""
    import mlx.core as mx
    from huggingface_hub import snapshot_download
    from parakeet_mlx import from_pretrained
    from parakeet_mlx.audio import get_logmel, load_audio

    started = time.monotonic()
    model_dir = snapshot_download(request["repo"], revision=request["revision"], cache_dir=request["cacheDir"])
    model = from_pretrained(model_dir)
    loaded = time.monotonic()
    regions = request.get("regions")
    words: list[dict[str, Any]] = []
    if regions is None:
        result = model.transcribe(media, chunk_duration=request["chunkSec"], overlap_duration=request["overlapSec"])
        words = join_tokens(result.tokens, 0.0, float("inf"))
    else:
        rate = model.preprocessor_config.sample_rate
        audio = load_audio(Path(media), rate, mx.bfloat16)
        for region in regions:
            piece = audio[int(region["startSec"] * rate) : int(region["endSec"] * rate)]
            if len(piece) < model.preprocessor_config.hop_length * 4:
                continue
            result = model.generate(get_logmel(piece, model.preprocessor_config))[0]
            words.extend(join_tokens(result.tokens, region["startSec"], region["endSec"]))
    return {"words": words, "downloadSec": round(loaded - started, 3), "inferenceSec": round(time.monotonic() - loaded, 3)}


def vad(media: str, request: dict[str, Any]) -> dict[str, Any]:
    """Measure speech intervals using the local voice activity model."""
    import importlib.metadata

    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    torch.set_num_threads(1)
    samples, rate = read_wav(media)
    model = load_silero_vad()
    spans = get_speech_timestamps(
        torch.from_numpy(samples.copy()),
        model,
        sampling_rate=rate,
        threshold=request["threshold"],
        min_speech_duration_ms=request["minSpeechMs"],
        min_silence_duration_ms=request["minSilenceMs"],
        speech_pad_ms=0,
        return_seconds=False,
    )
    return {
        "version": importlib.metadata.version("silero-vad"),
        "speech": [{"start": span["start"] / rate, "end": span["end"] / rate} for span in spans],
    }


def diarize(media: str, request: dict[str, Any]) -> dict[str, Any]:
    """Assign speaker turns using the prepared diarisation model."""
    from typing import cast

    import torch
    from pyannote.audio import Pipeline
    from pyannote.core import Annotation, Segment

    token = os.environ.get("HF_TOKEN")
    if not token:
        error_message = "HF_TOKEN is not set"
        raise RuntimeError(error_message)
    started = time.monotonic()
    pipeline = Pipeline.from_pretrained(request["repo"], token=token, revision=request["revision"], cache_dir=request["cacheDir"])
    if pipeline is None:
        error_message = f"Could not load {request['repo']}: accept its conditions on Hugging Face first"
        raise RuntimeError(error_message)
    device = "cpu"
    if request.get("device", "auto") != "cpu" and torch.backends.mps.is_available():
        pipeline.to(torch.device("mps"))
        device = "mps"
    loaded = time.monotonic()
    samples, rate = read_wav(media)
    options = {"num_speakers": request["numSpeakers"]} if request.get("numSpeakers") else {}
    audio = {"waveform": torch.from_numpy(samples.copy()).unsqueeze(0), "sample_rate": rate}
    try:
        output = pipeline(audio, **options)
    except RuntimeError:
        if device != "mps":
            raise
        pipeline.to(torch.device("cpu"))
        device = "cpu"
        output = pipeline(audio, **options)
    annotation = getattr(output, "exclusive_speaker_diarization", None) or getattr(output, "speaker_diarization", output)
    if not isinstance(annotation, Annotation):
        message = "Diarisation returned an unsupported annotation"
        raise TypeError(message)
    # pyannote returns triples for yield_label=True; its stub also includes the False case.
    tracks = cast("Iterable[tuple[Segment, str, object]]", annotation.itertracks(yield_label=True))
    turns = [{"start": turn.start, "end": turn.end, "speaker": str(speaker)} for turn, _, speaker in tracks]
    return {"turns": turns, "device": device, "downloadSec": round(loaded - started, 3), "inferenceSec": round(time.monotonic() - loaded, 3)}


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    operation, media, request_file = sys.argv[1], sys.argv[2], sys.argv[3]
    request = json.loads(Path(request_file).read_text())
    handlers = {"asr": asr, "vad": vad, "diarize": diarize}
    if operation not in handlers:
        error_message = f"unknown operation {operation}"
        raise SystemExit(error_message)
    stdout = sys.stdout
    sys.stdout = sys.stderr
    result = handlers[operation](media, request)
    stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
