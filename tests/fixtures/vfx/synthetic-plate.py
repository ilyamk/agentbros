"""A synthetic moving-camera plate with a known camera, for the camera:solve test.

Usage: synthetic-plate.py <out-dir>. Writes plate.mp4 (960x540, 30 fps, 72 frames) and truth.json
({K, frames: [{R, t}]}, OpenCV world-to-camera). A seeded cloud of textured blobs on three walls; the camera dollies
sideways 1.2 m while panning 8 degrees. Deterministic.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

W, H, N, F = 960, 540, 72, 800.0
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(7)
walls = [
    np.c_[rng.uniform(-4, 4, 500), rng.uniform(-2.2, 2.2, 500), np.full(500, 7.0)],
    np.c_[np.full(250, -3.5), rng.uniform(-2.2, 2.2, 250), rng.uniform(2.5, 7, 250)],
    np.c_[rng.uniform(-3.5, 3.5, 250), np.full(250, 2.0), rng.uniform(2.5, 7, 250)],
]
points = np.vstack(walls)
sizes = rng.uniform(2.0, 5.0, len(points))
shades = rng.uniform(90, 255, len(points))
K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])
writer = cv2.VideoWriter(str(out / "plate.mp4"), cv2.VideoWriter.fourcc(*"mp4v"), 30, (W, H))
frames = []
for i in range(N):
    s = i / (N - 1)
    centre = np.array([-0.6 + 1.2 * s, 0.05 * np.sin(3 * s), 0.3 * s])
    yaw = np.radians(-4 + 8 * s)
    R = np.array([[np.cos(yaw), 0, -np.sin(yaw)], [0, 1, 0], [np.sin(yaw), 0, np.cos(yaw)]])
    t = -R @ centre
    frames.append({"R": R.tolist(), "t": t.tolist()})
    image = np.full((H, W), 30, np.uint8)
    cam = (R @ points.T).T + t
    for (x, y, z), size, shade in zip(cam, sizes, shades, strict=True):
        if z <= 0.2:
            continue
        u, v = F * x / z + W / 2, F * y / z + H / 2
        radius = max(1, round(size * 4 / z))
        if -10 < u < W + 10 and -10 < v < H + 10:
            cv2.circle(image, (round(u * 16), round(v * 16)), radius * 16, int(shade), -1, cv2.LINE_AA, 4)
    writer.write(cv2.cvtColor(cv2.GaussianBlur(image, (3, 3), 0), cv2.COLOR_GRAY2BGR))
writer.release()
(out / "truth.json").write_text(json.dumps({"K": K.tolist(), "image_size": [W, H], "fps": 30, "frames": frames}))
sys.stdout.write(json.dumps({"ok": True, "plate": str(out / "plate.mp4")}) + "\n")
