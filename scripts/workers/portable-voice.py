"""Prepare pinned voice models, or synthesise and read back local draft takes."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import wave
from pathlib import Path
from typing import TypedDict, cast

import numpy as np
import sherpa_onnx as sherpa

ASR_RATE = 16_000
SPEECH_TAIL_SECONDS = 0.08
MAX_CHUNK = 1024 * 1024
MINIMUM_PEAK = 1e-5
EDGE_PUNCTUATION = '.,;:!?…()«»"'


class Model(TypedDict):
    """A reviewed archive and exact files shipped in it."""

    name: str
    bytes: int
    url: str
    sha256: str
    files: dict[str, str]


class Unit(TypedDict):
    """One requested take."""

    id: str
    text: str


class Request(TypedDict):
    """Trusted argument payload from the owning CLI."""

    language: str
    speaker: int
    units: list[Unit]


class Word(TypedDict):
    """Word timestamps in seconds relative to the take."""

    text: str
    start: float
    end: float


def checksum(path: Path) -> str:
    """Hash a model file without reading it all into memory."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked(directory: Path, model: Model) -> bool:
    """Verify the exact files the worker will open."""
    return (
        directory.is_dir()
        and not directory.is_symlink()
        and all((file := directory / name).is_file() and not file.is_symlink() and checksum(file) == digest for name, digest in model["files"].items())
    )


def prepare(root: Path, model: Model) -> None:
    """Fetch and extract only the exact pinned regular files."""
    destination = root / model["name"]
    if checked(destination, model):
        return
    if destination.exists() or destination.is_symlink():
        message = f"Model directory is incomplete or corrupt: {destination}. Move it aside and prepare again."
        raise ValueError(message)
    with tempfile.TemporaryDirectory(prefix=".model-", dir=root) as work:
        temporary = Path(work)
        archive = temporary / "model.tar.bz2"
        # The URL is a checked-in HTTPS release asset and the bytes are independently pinned.
        with urllib.request.urlopen(model["url"], timeout=60) as source, archive.open("xb") as target:  # noqa: S310
            size = 0
            while chunk := source.read(MAX_CHUNK):
                size += len(chunk)
                if size > model["bytes"]:
                    message = "Model download exceeds its pinned size"
                    raise ValueError(message)
                target.write(chunk)
        if size != model["bytes"] or checksum(archive) != model["sha256"]:
            message = "Model download size or SHA-256 mismatch"
            raise ValueError(message)
        stage = temporary / "files"
        stage.mkdir()
        with tarfile.open(archive, "r:bz2") as bundle:
            for member in bundle:
                name = Path(member.name)
                if name.parent.as_posix() != model["name"] or name.name not in model["files"]:
                    continue
                if not member.isfile() or (stream := bundle.extractfile(member)) is None:
                    message = "Expected a regular model file"
                    raise ValueError(message)
                with stream, (stage / name.name).open("xb") as target:
                    shutil.copyfileobj(stream, target)
        if not checked(stage, model):
            message = "Extracted model files differ from their SHA-256 pins"
            raise ValueError(message)
        stage.rename(destination)


def engines(voice: Path, asr: Path) -> tuple[sherpa.OfflineTts, sherpa.OfflineRecognizer]:
    """Open the prepared CPU runtimes once per batch."""
    tts = sherpa.OfflineTtsSupertonicModelConfig(
        duration_predictor=str(voice / "duration_predictor.int8.onnx"),
        text_encoder=str(voice / "text_encoder.int8.onnx"),
        vector_estimator=str(voice / "vector_estimator.int8.onnx"),
        vocoder=str(voice / "vocoder.int8.onnx"),
        tts_json=str(voice / "tts.json"),
        unicode_indexer=str(voice / "unicode_indexer.bin"),
        voice_style=str(voice / "voice.bin"),
    )
    recogniser = sherpa.OfflineRecognizer.from_transducer(
        encoder=str(asr / "encoder.int8.onnx"),
        decoder=str(asr / "decoder.int8.onnx"),
        joiner=str(asr / "joiner.int8.onnx"),
        tokens=str(asr / "tokens.txt"),
        model_type="nemo_transducer",
        num_threads=2,
    )
    return sherpa.OfflineTts(sherpa.OfflineTtsConfig(sherpa.OfflineTtsModelConfig(supertonic=tts, num_threads=2))), recogniser


def tokens_to_words(tokens: list[str], times: list[float], duration: float) -> list[Word]:
    """Join SentencePiece tokens, keeping estimated onsets on the audio clock."""
    segments: list[tuple[str, float, float]] = []
    for token, time in zip(tokens, times, strict=True):
        part = token.lstrip(" ▁")
        if not part or not part.strip(EDGE_PUNCTUATION):
            continue
        if not segments or part != token:
            segments.append((part, time, time))
        else:
            word, start, _ = segments[-1]
            segments[-1] = (word + part, start, time)
    words: list[Word] = []
    for index, (term, start, last) in enumerate(segments):
        text = term.strip(EDGE_PUNCTUATION)
        next_start = segments[index + 1][1] if index + 1 < len(segments) else duration
        if text and 0 <= start < duration:
            words.append(Word(text=text, start=start, end=min(duration, max(start, min(last + SPEECH_TAIL_SECONDS, next_start)))))
    return words


def lexical(text: str) -> list[str]:
    """Extract captionable words while retaining internal apostrophes and hyphens."""
    return re.findall(r"[^\W_]+(?:['\u2019\-][^\W_]+)*", text)


def normalise(text: str) -> str:
    """Treat case, typographic apostrophes and the Russian yo variant as equivalent."""
    return text.casefold().replace("\u0451", "\u0435").replace("\u2019", "'")


def synthesise(
    request: Request,
    output: Path,
    tts: sherpa.OfflineTts,
    recogniser: sherpa.OfflineRecognizer,
) -> list[dict[str, object]]:
    """Write a WAV per unit and return aligned words only for matching readback."""
    generation = sherpa.GenerationConfig()
    if not 0 <= request["speaker"] < tts.num_speakers:
        message = "The prepared model does not provide the requested speaker"
        raise ValueError(message)
    generation.sid = request["speaker"]
    generation.num_steps = 8
    generation.extra = {"lang": request["language"]}
    results: list[dict[str, object]] = []
    for unit in request["units"]:
        audio = tts.generate(unit["text"], generation)
        samples = np.asarray(audio.samples, dtype=np.float32)
        rate = audio.sample_rate
        if len(samples) == 0 or rate <= 0 or not np.all(np.isfinite(samples)):
            message = "Synthesis produced no usable audio"
            raise ValueError(message)
        duration = len(samples) / rate
        peak = float(np.max(np.abs(samples)))
        if peak <= MINIMUM_PEAK:
            message = "Synthesis produced no audible audio"
            raise ValueError(message)
        pcm = (samples * (32767 * min(1.0, 0.98 / peak))).astype("<i2")
        with wave.open(str(output / (unit["id"] + ".wav")), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(pcm.tobytes())
        wave16k = np.interp(np.arange(int(duration * ASR_RATE)) * (rate / ASR_RATE), np.arange(len(samples)), samples)
        stream = recogniser.create_stream()
        stream.accept_waveform(ASR_RATE, wave16k.astype(np.float32))
        recogniser.decode_stream(stream)
        result = stream.result
        words = tokens_to_words(list(result.tokens), list(result.timestamps), duration)
        expected = lexical(unit["text"])
        matched = bool(expected) and list(map(normalise, expected)) == [normalise(word["text"]) for word in words]
        if matched:
            for word, text in zip(words, expected, strict=True):
                word["text"] = text
        results.append(
            {
                "id": unit["id"],
                "durationSec": duration,
                "sampleRate": rate,
                "words": words if matched else [],
                "heard": result.text,
                "matched": matched,
            }
        )
    return results


def main() -> None:
    """Read one bounded request and emit private JSON for the CLI."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "synthesise"])
    parser.add_argument("cache", type=Path)
    parser.add_argument("request", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    args = parser.parse_args()
    models = cast("list[Model]", json.loads(Path(__file__).with_name("portable-voice-models.json").read_text(encoding="utf-8")))
    if args.action == "prepare":
        args.cache.mkdir(parents=True, exist_ok=True)
        for model in models:
            prepare(args.cache, model)
        sys.stdout.write(json.dumps({"models": [model["name"] for model in models]}) + "\n")
        return
    if not all(checked(args.cache / model["name"], model) for model in models):
        message = "Voice models are missing or corrupt. Run voiceover:local --engine portable --prepare."
        raise ValueError(message)
    request = cast("Request", json.loads(args.request.read_text(encoding="utf-8")))
    tts, recognise = engines(*(args.cache / model["name"] for model in models))
    sys.stdout.write(json.dumps(synthesise(request, args.output, tts, recognise), ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
