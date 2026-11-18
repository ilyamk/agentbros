"""Extract inert library files after validating every ZIP member; never execute contents."""

import json
import shutil
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

MAX_BYTES = 2 * 1024**3
MAX_FILES = 10000
ALLOWED = {".png", ".jpg", ".jpeg", ".exr", ".hdr", ".tif", ".tiff", ".blend", ".glb", ".gltf", ".bin", ".fbx", ".obj", ".mtl", ".mtlx", ".usdc", ".tres", ".ttf", ".otf", ".txt", ".md", ".json"}


def unpack(archive: Path, destination: Path) -> list[str]:
    """Validate the full archive before creating any output."""
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > MAX_FILES or sum(item.file_size for item in members) > MAX_BYTES:
            msg = "Archive exceeds extraction limits"
            raise ValueError(msg)
        names: set[str] = set()
        for item in members:
            name = PurePosixPath(item.filename)
            mode = item.external_attr >> 16
            if name.is_absolute() or ".." in name.parts or "\\" in item.filename or ":" in item.filename or stat.S_ISLNK(mode):
                msg = "Unsafe archive member"
                raise ValueError(msg)
            canonical = str(name).casefold()
            if canonical in names or name.name.casefold() == "asset.json":
                msg = "Duplicate or reserved archive member"
                raise ValueError(msg)
            names.add(canonical)
        files = []
        for item in members:
            if item.is_dir() or PurePosixPath(item.filename).suffix.lower() not in ALLOWED:
                continue
            target = destination / item.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(item) as content, target.open("wb") as output:
                shutil.copyfileobj(content, output, length=1024 * 1024)
            files.append(item.filename)
        return files


if __name__ == "__main__":
    sys.stdout.write(json.dumps(unpack(Path(sys.argv[1]), Path(sys.argv[2]))) + "\n")
