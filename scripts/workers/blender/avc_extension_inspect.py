"""Inspect an extension ZIP without extracting or executing its contents."""

import json
import stat
import sys
import tomllib
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

MAX_MEMBERS = 10000


def inspect_archive(filename: str) -> dict[str, Any]:
    """Return manifest facts and conservative risk flags from a bounded ZIP."""
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        normalised = [unicodedata.normalize("NFC", name).casefold().rstrip("/") for name in names]
        if len(normalised) != len(set(normalised)) or len(names) > MAX_MEMBERS:
            msg = "Duplicate ZIP members or too many members"
            raise ValueError(msg)
        for entry in entries:
            canonical = str(PurePosixPath(entry.filename)) + ("/" if entry.is_dir() else "")
            if canonical != entry.filename:
                msg = "Non-canonical ZIP member"
                raise ValueError(msg)
            parts = PurePosixPath(entry.filename).parts
            if entry.filename.startswith("/") or ".." in parts or "\\" in entry.filename or ":" in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                msg = "Unsafe ZIP member"
                raise ValueError(msg)
        if sum(entry.file_size for entry in entries) > 512 * 1024 * 1024:
            msg = "Unpacked archive exceeds 512 MiB"
            raise ValueError(msg)
        manifest = archive.getinfo("blender_manifest.toml")
        if manifest.file_size > 1024 * 1024:
            msg = "Manifest exceeds 1 MiB"
            raise ValueError(msg)
        data = tomllib.loads(archive.read(manifest).decode("utf8"))
        if data.get("type") != "add-on" or data.get("schema_version") != "1.0.0" or "__init__.py" not in names:
            msg = "Expected a schema 1.0.0 add-on with root manifest and __init__.py"
            raise ValueError(msg)
    return facts(data, names)


def inspect_directory(directory: str) -> dict[str, Any]:
    """Read the installed manifest without importing candidate Python."""
    root = Path(directory)
    manifest = root / "blender_manifest.toml"
    if manifest.stat().st_size > 1024 * 1024 or not (root / "__init__.py").is_file():
        msg = "Missing add-on code or oversized installed manifest"
        raise ValueError(msg)
    with manifest.open("rb") as handle:
        data = tomllib.load(handle)
    return facts(data, [str(file.relative_to(root)) for file in root.rglob("*") if file.is_file()])


def facts(data: dict[str, Any], names: list[str]) -> dict[str, Any]:
    """Describe manifest facts consistently for archives and installed files."""
    if data.get("type") != "add-on" or data.get("schema_version") != "1.0.0":
        msg = "Expected a schema 1.0.0 add-on"
        raise ValueError(msg)
    licences = data["license"]
    permissions = data.get("permissions", {})
    wheels = data.get("wheels", [])
    native = bool(wheels) or any(name.lower().endswith((".so", ".dylib", ".dll", ".pyd")) for name in names)
    compatible = {"SPDX:GPL-2.0-or-later", "SPDX:GPL-3.0-only", "SPDX:GPL-3.0-or-later", "SPDX:MIT", "SPDX:BSD-2-Clause", "SPDX:BSD-3-Clause", "SPDX:Apache-2.0"}
    risks = [f"Permission: {name}" for name in permissions if name in {"network", "files"}]
    if native:
        risks.append("Native code or wheels: review platforms and dependencies")
    if not all(item in compatible for item in licences):
        risks.append("Licence compatibility with GPL is unverified")
    return {
        "id": data["id"],
        "name": data["name"],
        "version": data["version"],
        "maintainer": data["maintainer"],
        "licence": licences,
        "blenderMin": data["blender_version_min"],
        "blenderMax": data.get("blender_version_max"),
        "permissions": permissions,
        "wheels": wheels,
        "platforms": data.get("platforms", []),
        "nativeCode": native,
        "risks": risks,
    }


if __name__ == "__main__":
    result = inspect_directory(sys.argv[2]) if sys.argv[1] == "--directory" else inspect_archive(sys.argv[1])
    sys.stdout.write(json.dumps(result) + "\n")
