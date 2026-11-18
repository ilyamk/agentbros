"""Optional installed engines only. No package installation or model download."""

from __future__ import annotations

import importlib.metadata
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
from typing import Any, Protocol

CLOCK_TOLERANCE_SEC = 0.001


class Tokenizer(Protocol):
    """Callable Hugging Face tokenizer boundary, with model-specific options."""

    def __call__(self, *args: Any, **kwargs: Any) -> dict[str, Any]:  # noqa: ANN401 -- Forwarded third-party ML/tokenizer values are a dynamic API boundary.
        """Call the tokenizer while checking the complete untruncated input."""
        ...


class EmbeddingModel(Protocol):
    """Prepared sentence-transformer preprocessing required for window checks."""

    default_prompt_name: str | None
    max_seq_length: int

    def _first_module(self) -> Any: ...  # noqa: ANN401 -- Forwarded third-party ML/tokenizer values are a dynamic API boundary.


os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1")


class WindowCheckedTokenizer:
    """Check the exact preprocessed input before the original tokenizer truncates it."""

    def __init__(self, tokenizer: Tokenizer, limit: int) -> None:
        """Keep the original tokenizer and its model sequence limit."""
        self.tokenizer, self.limit = tokenizer, limit

    def __getattr__(self, name: str) -> Any:  # noqa: ANN401 -- Forwarded third-party ML/tokenizer values are a dynamic API boundary.
        """Forward model-specific tokenizer attributes without changing preprocessing."""
        return getattr(self.tokenizer, name)

    def __call__(self, *args: Any, **kwargs: Any) -> dict[str, Any]:  # noqa: ANN401 -- Forwarded third-party ML/tokenizer values are a dynamic API boundary.
        """Call the tokenizer while checking the complete untruncated input."""
        unbounded = dict(kwargs)
        unbounded.pop("return_tensors", None)
        unbounded.pop("max_length", None)
        unbounded.update(truncation=False, padding=False)
        lengths = self.tokenizer(*args, **unbounded)["input_ids"]
        if any(len(tokens) > self.limit for tokens in lengths):
            error_message = "Embedding text exceeds model sequence window; split reviewed source spans explicitly"
            raise ValueError(error_message)
        return self.tokenizer(*args, **kwargs)


def guard_embedding_model(model: EmbeddingModel) -> None:
    """Guard the prepared model against implicit prompts and input truncation."""
    if model.default_prompt_name is not None:
        error_message = "Embedding model with configured default prompt is unsupported"
        raise ValueError(error_message)
    first = model._first_module()  # noqa: SLF001 -- The pinned SDK exposes this required preprocessing/animation hook.
    first.tokenizer = WindowCheckedTokenizer(first.tokenizer, model.max_seq_length)


def main() -> None:  # noqa: C901, PLR0912, PLR0915 -- Keep the ordered validation or native transaction together. Each branch validates one supported contract variant. Ordered native mutations and their validation form one operation.
    """Run the fixed worker operation selected by its owning command."""
    line = sys.stdin.buffer.readline(16 * 1024 * 1024 + 1)
    if len(line) > 16 * 1024 * 1024:
        error_message = "Request exceeds 16 MiB"
        raise ValueError(error_message)
    request = json.loads(line)
    if "--probe" in sys.argv:
        config = request["config"]
        if config["engine"] == "sentence-transformers":
            versions = {name: importlib.metadata.version(name) for name in ["sentence-transformers", "transformers", "torch", "huggingface-hub"]}
        else:
            probe = subprocess.run([config["engineExecutable"], "--help"], capture_output=True, timeout=5, check=False)  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
            help_text = (probe.stdout + probe.stderr).decode(errors="replace")
            if probe.returncode != 0 or not all(flag in help_text for flag in ["--model", "--file", "--output-json"]):
                error_message = "Installed executable does not expose the supported whisper.cpp CLI"
                raise ValueError(error_message)
            versions = {"whisper.cpp": help_text[:1000]}
            if config.get("wordTimingMethod"):
                versions["native-word-timings"] = "available" if all(flag in help_text for flag in ["--max-len", "--split-on-word"]) else "unavailable"
        print(json.dumps({"available": True, "engine": config["engine"], "versions": versions}))  # noqa: T201 -- The owning Node caller consumes this worker output.
        return
    if request.get("version") != 1 or request.get("offline") is not True:
        error_message = "Offline v1 protocol required"
        raise ValueError(error_message)
    config, payload = request["config"], request["payload"]
    if payload["operation"] == "embed":
        # local_files_only never resolves a Hub model ID; remote code is disabled.
        import torch
        from sentence_transformers import SentenceTransformer
        from sentence_transformers.models import Transformer

        torch.set_num_threads(config.get("threads", 2))
        model = SentenceTransformer(config["modelPath"], local_files_only=True, trust_remote_code=False, device="cpu", model_kwargs={"use_safetensors": True})
        if type(model._first_module()) is not Transformer:  # noqa: SLF001 -- The pinned SDK exposes this required preprocessing/animation hook.
            error_message = "Embedding requires the standard Transformer tokenizer preprocessing"
            raise ValueError(error_message)
        guard_embedding_model(model)
        vectors = model.encode(payload["texts"], normalize_embeddings=True, show_progress_bar=False, batch_size=16).tolist()
        output: dict[str, Any] = {"vectors": vectors}
    elif payload["operation"] == "asr":
        source_fd = os.open(payload["sourceFile"], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        try:
            source_stat = os.fstat(source_fd)
            if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_size > 32 * 1024**3:
                error_message = "ASR requires a bounded regular local source"
                raise ValueError(error_message)
        finally:
            os.close(source_fd)
        native_supported = False
        if config.get("wordTimingMethod"):
            native_help = subprocess.run([config["engineExecutable"], "--help"], capture_output=True, check=True, timeout=5)  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
            help_text = (native_help.stdout + native_help.stderr).decode(errors="replace")
            native_supported = all(flag in help_text for flag in ["--max-len", "--split-on-word"])
        # Reject mismatched stream origins: ASR seconds must refer to source zero.
        probe = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", payload["sourceFile"]], capture_output=True, check=True, timeout=30)  # noqa: S603, S607 -- Arguments are a literal vector; the worker never invokes a shell. Fixed local media tool resolved through the caller environment.
        streams = json.loads(probe.stdout)["streams"]
        audio = next(s for s in streams if s["codec_type"] == "audio")
        if abs(float(audio.get("start_time", 0))) > CLOCK_TOLERANCE_SEC:
            error_message = "ASR requires explicit normalization of nonzero audio origin"
            raise ValueError(error_message)
        if any(s["codec_type"] == "video" and abs(float(s.get("start_time", 0))) > CLOCK_TOLERANCE_SEC for s in streams):
            error_message = "ASR requires explicit normalization of nonzero video origin"
            raise ValueError(error_message)
        with tempfile.TemporaryDirectory(prefix="video-local-asr-") as directory:
            wav, prefix = str(pathlib.Path(directory) / "source.wav"), str(pathlib.Path(directory) / "transcript")
            subprocess.run(  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
                ["ffmpeg", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", payload["sourceFile"], "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],  # noqa: S607 -- Fixed local media tool resolved through the caller environment.
                check=True,
                timeout=config["timeoutMs"] / 1000,
                stdout=sys.stderr,
                stderr=sys.stderr,
            )
            subprocess.run(  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
                [config["engineExecutable"], "-m", config["modelPath"], "-f", wav, "-l", config["language"], "-t", str(config.get("threads", 2)), "-ng", "-oj", "-of", prefix]
                + (["-ml", "1", "-sow"] if native_supported else []),
                check=True,
                timeout=config["timeoutMs"] / 1000,
                stdout=sys.stderr,
                stderr=sys.stderr,
            )
            result = pathlib.Path(prefix + ".json")
            result_fd = os.open(result, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
            with os.fdopen(result_fd, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 16 * 1024 * 1024:
                    error_message = "ASR response requires bounded regular JSON"
                    raise ValueError(error_message)
                raw = stream.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    error_message = "ASR response exceeds 16 MiB"
                    raise ValueError(error_message)
            # whisper.cpp times its last rows to the end of a 30 s window, which can pass the end of the audio.
            end_ms = int(float(payload["durationSec"]) * 1000)
            rows: list[dict[str, Any]] = [{**r, "offsets": {**r["offsets"], "to": min(r["offsets"]["to"], end_ms)}} for r in json.loads(raw)["transcription"] if r["offsets"]["from"] < end_ms]
            output: dict[str, Any] = {"segments": [{"text": r["text"].strip(), "startSec": r["offsets"]["from"] / 1000, "endSec": r["offsets"]["to"] / 1000} for r in rows if r["text"].strip()]}
            if config.get("wordTimingMethod"):
                lexical = [r for r in rows if r["text"].strip()]
                invalid_words = not native_supported or any(r["offsets"]["to"] <= r["offsets"]["from"] or len(r["text"].strip().split()) != 1 for r in lexical)
                if invalid_words and lexical:
                    output["segments"] = [{"text": " ".join(r["text"].strip() for r in lexical), "startSec": lexical[0]["offsets"]["from"] / 1000, "endSec": lexical[-1]["offsets"]["to"] / 1000}]
                output["wordTimings"] = {
                    "status": "unavailable" if invalid_words else "available",
                    **({"reason": "Native lexical rows are collapsed or ambiguous"} if invalid_words else {}),
                    "version": 1,
                    "method": "native-word-segments-v1",
                    "estimated": True,
                    "reviewRequired": True,
                    "rawRows": [{"text": r["text"], "offsets": r["offsets"]} for r in rows],
                }
    else:
        error_message = "Unsupported operation"
        raise ValueError(error_message)
    print(json.dumps({"version": 1, "key": request["key"], "offline": True, "output": output}, allow_nan=False))  # noqa: T201 -- The owning Node caller consumes this worker output.


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- The subprocess boundary serialises every failure for its caller.
        print(f"Local engine unavailable/failed: {error}", file=sys.stderr)  # noqa: T201 -- The owning Node caller consumes this worker output.
        sys.exit(1)
