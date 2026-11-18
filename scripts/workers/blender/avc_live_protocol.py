# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Wire protocol and input checks of the Blender live session. Imports no bpy, so tests run it with plain Python.

One request per TCP connection: a single JSON line `{"v": 1, "token": ..., "op": ..., "params": {...}}`,
answered by one JSON line `{"ok": true, "result": ...}` or `{"ok": false, "error": {"code", "message"}}`.
"""

from __future__ import annotations

import hmac
import json
import math
import os
import re
from typing import TYPE_CHECKING, Any, TypeAlias

MAX_PROPERTY_ARRAY_LENGTH = 16
MAX_PROPERTY_PATH_LENGTH = 512
MAX_PROPERTY_STRING_LENGTH = 256

if TYPE_CHECKING:
    from collections.abc import Callable

Params: TypeAlias = dict[str, Any]

PROTOCOL = 1
MAX_REQUEST_BYTES = 1024 * 1024
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# Datablock names agents may create or address: printable, no path separators or control characters.
DATABLOCK_NAME = re.compile(r"^[A-Za-z0-9 _.\-]{1,63}$")
IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
SUBSCRIPT = re.compile(r'\[(?:"([^"\\\]]{1,63})"|(\d{1,6}))\]')
MAX_PATH_SEGMENTS = 12

# Property names a `set` path may never touch: Python-running drivers and scripts, files, libraries, internals.
FORBIDDEN_NAMES = frozenset(
    {
        "animation_data",
        "driver",
        "drivers",
        "expression",
        "script",
        "scripts",
        "text",
        "texts",
        "filepath",
        "filepath_raw",
        "filepath_from_user",
        "directory",
        "library",
        "library_weak_reference",
        "override_library",
        "id_data",
        "rna_type",
        "users",
        "use_fake_user",
        "use_extra_user",
        "is_library_indirect",
        "packed_file",
        "packed_files",
        "use_autopack",
        "frame_path",
        "use_scripts_auto_execute",
        "handlers",
        "preferences",
    }
)


class LiveError(Exception):
    """An error with a CLI contract code (INVALID_INPUT, VALIDATION, AUTH, NOT_FOUND, INTERNAL)."""

    def __init__(self, code: str, message: str) -> None:
        """Carry a protocol error code and its human-readable message."""
        super().__init__(message)
        self.code = code
        self.message = message


def check_token(expected: str, given: object) -> bool:
    """Constant-time comparison; an empty expected token never matches."""
    if not expected or not isinstance(given, str):
        return False
    return hmac.compare_digest(expected.encode(), given.encode())


def read_line(receive: Callable[[int], bytes], limit: int = MAX_REQUEST_BYTES) -> bytes:
    """Reads bytes from `receive(n)` until a newline. Refuses more than `limit` bytes or a connection closed early."""
    data = bytearray()
    while True:
        chunk = receive(65536)
        if not chunk:
            error_message = "Connection closed before a complete request line."
            raise LiveError("INVALID_INPUT", error_message)
        data.extend(chunk)
        end = data.find(b"\n")
        if end >= 0:
            if end > limit:
                break
            return bytes(data[:end])
        if len(data) > limit:
            break
    error_message = f"Request exceeds {limit} bytes."
    raise LiveError("INVALID_INPUT", error_message)


def parse_request(line: bytes, token: str) -> tuple[str, Params]:
    """Parses and authenticates one request line; returns (op, params)."""
    try:
        request = json.loads(line.decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        error_message = "Request is not one JSON line."
        raise LiveError("INVALID_INPUT", error_message) from error
    if not isinstance(request, dict):
        error_message = "Request must be a JSON object."
        raise LiveError("INVALID_INPUT", error_message)
    if not check_token(token, request.get("token")):
        error_message = "Missing or wrong session token."
        raise LiveError("AUTH", error_message)
    if type(request.get("v")) is not int or request.get("v") != PROTOCOL:
        error_message = f"Protocol version must be {PROTOCOL}."
        raise LiveError("INVALID_INPUT", error_message)
    op, params = request.get("op"), request.get("params", {})
    if not isinstance(op, str) or not NAME.fullmatch(op.replace("_", "-")):
        error_message = "op must be a short name."
        raise LiveError("INVALID_INPUT", error_message)
    if not isinstance(params, dict):
        error_message = "params must be a JSON object."
        raise LiveError("INVALID_INPUT", error_message)
    return op, params


def encode_response(ok: bool, payload: object) -> bytes:
    """Encode one finite JSON response line."""
    body = {"ok": True, "result": payload} if ok else {"ok": False, "error": payload}
    return (json.dumps(body, separators=(",", ":"), allow_nan=False) + "\n").encode("utf8")


def check_name(value: object, what: str = "name") -> str:
    """A caller-chosen file or label name: lower-case letters, digits and hyphens; never a path."""
    if not isinstance(value, str) or not NAME.fullmatch(value):
        error_message = f"{what} must match [a-z0-9][a-z0-9-]{{0,63}}; got {value!r}."
        raise LiveError("INVALID_INPUT", error_message)
    return value


def check_datablock_name(value: object, what: str = "name") -> str:
    """Validate a Blender datablock name before lookup."""
    if not isinstance(value, str) or not DATABLOCK_NAME.fullmatch(value):
        error_message = f"{what} must be 1-63 letters, digits, spaces, '_', '.' or '-'; got {value!r}."
        raise LiveError("INVALID_INPUT", error_message)
    return value


def contained(root: str | os.PathLike[str], path: str) -> str:
    """The canonical path, refused unless it stays inside the canonical root (symlinks resolved)."""
    real_root = os.path.realpath(root)
    real = os.path.realpath(path)
    if real != real_root and not real.startswith(real_root + os.sep):
        error_message = f"Path escapes {real_root}: {path}"
        raise LiveError("VALIDATION", error_message)
    return real


def parse_property_path(path: str) -> list[tuple[str, str | int]]:  # noqa: C901 -- Keep the ordered validation or native transaction together.
    """Splits `data.node_tree.nodes["Principled BSDF"].inputs[0].default_value` into ("attr", name) and ("key", str|int).

    Only plain attribute names and literal subscripts: no calls, no expressions, no private or forbidden names.
    """
    if not isinstance(path, str) or not path or len(path) > MAX_PROPERTY_PATH_LENGTH:
        error_message = "path must be a non-empty string of at most 512 characters."
        raise LiveError("INVALID_INPUT", error_message)
    segments, position = [], 0
    while position < len(path):
        if path[position] == "[":
            match = SUBSCRIPT.match(path, position)
            if not match:
                error_message = f'Bad subscript at {position} in {path!r}; use ["Name"] or [0].'
                raise LiveError("INVALID_INPUT", error_message)
            segments.append(("key", match.group(1) if match.group(1) is not None else int(match.group(2))))
            position = match.end()
            continue
        if segments:
            if path[position] != ".":
                error_message = f"Expected '.' or '[' at {position} in {path!r}."
                raise LiveError("INVALID_INPUT", error_message)
            position += 1
        match = IDENTIFIER.match(path, position)
        if not match:
            error_message = f"Expected a property name at {position} in {path!r}."
            raise LiveError("INVALID_INPUT", error_message)
        name = match.group(0)
        if name.startswith("bl_") or name in FORBIDDEN_NAMES:
            error_message = f"Property {name!r} cannot be set through the live session."
            raise LiveError("VALIDATION", error_message)
        segments.append(("attr", name))
        position = match.end()
    if len(segments) > MAX_PATH_SEGMENTS:
        error_message = f"path has more than {MAX_PATH_SEGMENTS} segments."
        raise LiveError("INVALID_INPUT", error_message)
    if segments[-1][0] != "attr":
        error_message = "path must end with a property name."
        raise LiveError("INVALID_INPUT", error_message)
    return segments


def check_json_value(value: object, depth: int = 0) -> object:
    """Values a property may take: numbers, booleans, strings and short flat lists of numbers."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            error_message = "Numbers must be finite."
            raise LiveError("INVALID_INPUT", error_message)
        return value
    if isinstance(value, str):
        if len(value) > MAX_PROPERTY_STRING_LENGTH:
            error_message = "String values are limited to 256 characters."
            raise LiveError("INVALID_INPUT", error_message)
        return value
    if isinstance(value, list) and depth == 0 and 0 < len(value) <= MAX_PROPERTY_ARRAY_LENGTH:
        return [check_json_value(item, 1) for item in value]
    error_message = "value must be a number, boolean, string or a list of at most 16 numbers."
    raise LiveError("INVALID_INPUT", error_message)
