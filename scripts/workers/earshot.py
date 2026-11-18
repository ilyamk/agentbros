"""Run the prepared, pinned Earshot API through a bounded JSON-only interface."""

from __future__ import annotations

import contextlib
import importlib.metadata
import json
import math
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

CLAP = "laion/larger_clap_general"
REVISION = "16c8cc3159a3c8a31e8ff5ef1f66b0d9ab3667db"
SHA = "4ac3d2ac2b151e1c23376f9ce7f3047a17050013"


def clean(value: Any) -> Any:  # noqa: ANN401
    """Normalise NumPy scalars and non-finite readings for strict JSON."""
    if isinstance(value, dict):
        return {str(key): clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    if hasattr(value, "item"):
        return clean(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def pcm_input(value: str) -> str:
    """Earshot sees only our decoded PCM WAV, never an external playlist."""
    source = Path(value)
    if source.is_symlink() or not source.is_file():
        msg = "Expected a regular analysis WAV"
        raise ValueError(msg)
    with source.open("rb") as stream:
        header = stream.read(12)
    if header[:4] != b"RIFF" or header[8:] != b"WAVE":
        msg = "Only decoded PCM WAV input is accepted"
        raise ValueError(msg)
    return str(source)


def execute(request: Mapping[str, Any]) -> dict[str, Any]:
    """Dispatch only fixed API operations and shipped sound identifiers."""
    allowed = {"action", "input", "output", "sound", "seed", "duration", "apex", "pitch", "query", "top", "start", "end", "kind", "semantic"}
    if set(request) - allowed:
        msg = "Unknown Earshot request fields"
        raise ValueError(msg)
    from earshot.forge import bank
    from earshot.models import hub

    from earshot import api

    action = request.get("action")
    if action == "prepare":
        direct = json.loads(importlib.metadata.distribution("earshot").read_text("direct_url.json") or "{}")
        if direct.get("vcs_info", {}).get("commit_id") != SHA:
            msg = "Earshot installation does not match the reviewed source commit"
            raise ValueError(msg)
        spec = hub.ensure(CLAP, REVISION) if request.get("semantic") else hub.resolve(CLAP, REVISION)
        return {
            "packageVersion": importlib.metadata.version("earshot"),
            "packageSha": SHA,
            "bankVersion": bank.VERSION,
            "bankCount": len(bank.ids()),
            "modelState": spec.state,
            "modelSnapshot": spec.snapshot,
            "weights": spec.weights,
        }
    if action == "list":
        return api.sfx_list()
    if action == "render":
        sound = request.get("sound")
        if not isinstance(sound, str) or sound not in bank.ids():
            msg = "Choose an identifier from the shipped Earshot bank"
            raise ValueError(msg)
        result = api.sfx_render(sound, out=request["output"], seed=request.get("seed", 1), dur=request.get("duration"), apex=request.get("apex"), pitch=request.get("pitch"), sr=48000, peak_db=-1.5)
        return {**result, "bankVersion": bank.VERSION, "source": bank.get(sound).get("source")}
    if action == "check":
        return api.sfx_check(pcm_input(request["input"]))
    if action == "find":
        spec = hub.resolve(CLAP, REVISION)
        if spec.state != "cached" or spec.weights != "model.safetensors" or spec.folder or spec.sha != REVISION:
            msg = "Pinned CLAP safetensors are not prepared; run media:prepare --engines earshot-find"
            raise ValueError(msg)
        return api.find(pcm_input(request["input"]), request["query"], top=request.get("top", 5), start=request.get("start"), end=request.get("end"), kind=request.get("kind", "auto"))
    msg = "Unsupported Earshot operation"
    raise ValueError(msg)


def main() -> None:
    """Keep upstream progress off stdout and return one JSON result."""
    if any(key in os.environ for key in ("EARSHOT_BANK", "EARSHOT_REFS", "EARSHOT_REFSETS")):
        msg = "External Earshot bank/reference overrides are forbidden"
        raise ValueError(msg)
    request_file = Path(sys.argv[1])
    if request_file.stat().st_size > 64 * 1024:
        msg = "Earshot request exceeds its byte bound"
        raise ValueError(msg)
    request = json.loads(request_file.read_text())
    with contextlib.redirect_stdout(sys.stderr):
        result = execute(request)
    print(json.dumps({"ok": True, "result": clean(result)}, ensure_ascii=False, allow_nan=False, separators=(",", ":")))  # noqa: T201 -- one-line worker protocol


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, ImportError, KeyError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, separators=(",", ":")))  # noqa: T201 -- one-line worker protocol
        sys.exit(1)
