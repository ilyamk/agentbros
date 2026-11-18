"""Generate original planar footage with a known pinhole camera and pixel motion."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    """Write a deterministic 24-frame test plate and its ground-truth trajectory."""
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)
    texture = rng.integers(40, 210, (360, 640, 3), dtype=np.uint8)
    texture = cv2.GaussianBlur(texture, (5, 5), 0)
    for x in range(40, 640, 40):
        for y in range(30, 360, 30):
            cv2.rectangle(texture, (x, y), (x + 14, y + 14), (230, 220, 200), -1)
    writer = cv2.VideoWriter(str(directory / "plate.mp4"), cv2.VideoWriter.fourcc(*"mp4v"), 24, (640, 360))
    for index in range(24):
        transform = np.array([[1.0, 0, index * 0.2], [0, 1.0, 0]])
        writer.write(cv2.warpAffine(texture, transform, (640, 360), borderMode=cv2.BORDER_REFLECT))
    writer.release()
    request = {
        "schemaVersion": 1,
        "plate": "plate.mp4",
        "width": 640,
        "height": 360,
        "fps": 24,
        "duration": 1,
        "calibration": {"focalPx": 320, "planeWidthM": 2.5, "planeHeightM": 1.5, "corners": [[120, 60], [520, 60], [520, 300], [120, 300]]},
    }
    (directory / "request.json").write_text(json.dumps(request, indent=2) + "\n")
    truth = {"cameraHeightM": 2, "cameraXPerFrameM": -0.00125, "pixelShiftPerFrame": 0.2, "licence": "Original synthetic fixture"}
    (directory / "truth.json").write_text(json.dumps(truth, indent=2) + "\n")


if __name__ == "__main__":
    main()
