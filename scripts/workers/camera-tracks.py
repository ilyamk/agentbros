"""Feature tracks for a camera solve: KLT points outside a holdout matte, forward-backward checked.

Spawned by src/lib/vfx/camera-solve.ts (`pnpm camera:solve`) with one argument, a request JSON file:
{"plate": str, "output": str, "frames": [first, last] | null, "matte_dir": str | null,
 "matte_pattern": "frame-{:05d}.png", "max_points": int, "min_distance": float,
 "fb_max_px": float, "min_length": int, "redetect_every": int, "matte_dilate_px": int}

Prints one JSON object: {"ok": true, "tracks": path, "count": n, "frames": n, "size": [w, h], "stats": {...}}.
Tracks are written as {"size": [w, h], "fps": f, "first": n, "tracks": [{"id": i, "f0": n, "pts": [[x, y], ...]}]}
in pixel coordinates of the plate, origin top-left, frame indices zero-based from the plate start.
Deterministic: no randomness; OpenCV corner detection and pyramidal LK are pure functions of the pixels.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

EDGE = 4  # px kept clear of the frame border while tracking


def load_matte(directory: str | None, pattern: str, index: int, shape: tuple[int, int], dilate: int) -> np.ndarray:
    """Return a boolean holdout (True = exclude) for one frame; empty when no matte is given."""
    if not directory:
        return np.zeros(shape, bool)
    path = Path(directory) / pattern.format(index)
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        message = f"matte frame missing: {path}"
        raise FileNotFoundError(message)
    if image.shape != shape:
        image = cv2.resize(image, (shape[1], shape[0]), interpolation=cv2.INTER_LINEAR)
    hold = image > 32  # noqa: PLR2004 - alpha above 1/8 counts as subject
    if dilate > 0:
        hold = cv2.dilate(hold.astype(np.uint8), np.ones((dilate * 2 + 1, dilate * 2 + 1), np.uint8)) > 0
    return hold


def detect(gray: np.ndarray, hold: np.ndarray, existing: np.ndarray, request: dict) -> np.ndarray:
    """New corners away from the holdout, the frame border and existing points."""
    mask = np.where(hold, 0, 255).astype(np.uint8)
    border = 12
    mask[:border] = 0
    mask[-border:] = 0
    mask[:, :border] = 0
    mask[:, -border:] = 0
    radius = int(request["min_distance"])
    for x, y in existing:
        cv2.circle(mask, (int(x), int(y)), radius, 0, -1)
    room = request["max_points"] - len(existing)
    if room <= 0:
        return np.zeros((0, 2), np.float32)
    corners = cv2.goodFeaturesToTrack(gray, maxCorners=room, qualityLevel=0.005, minDistance=request["min_distance"], mask=mask, blockSize=7)
    if corners is None:
        return np.zeros((0, 2), np.float32)
    return corners.reshape(-1, 2).astype(np.float32)


def epipolar_filter(tracks: list[dict], frames: int, request: dict) -> tuple[list[dict], int]:
    """Drop tracks that disagree with the rigid scene: fundamental-matrix RANSAC over sliding frame pairs.

    A track is an outlier in a window when its point pair lies farther than `epipolar_px` from the epipolar
    line; it is rejected when that happens in more than `epipolar_reject_share` of the windows it spans.
    Moving or wobbling features (generated bubbles, reflections, flicker) fail; static scene features pass.
    """
    gap = int(request.get("epipolar_gap", 6))
    limit = float(request.get("epipolar_px", 1.0))
    share = float(request.get("epipolar_reject_share", 0.3))
    if gap <= 0 or limit <= 0:
        return tracks, 0
    seen = np.zeros(len(tracks))
    bad = np.zeros(len(tracks))
    spans = [(t["f0"], t["f0"] + len(t["pts"]) - 1) for t in tracks]
    for a in range(frames - gap):
        b = a + gap
        members = [i for i, (s, e) in enumerate(spans) if s <= a and e >= b]
        if len(members) < 16:  # noqa: PLR2004 - too few correspondences for a stable fundamental matrix
            continue
        pa = np.array([tracks[i]["pts"][a - spans[i][0]] for i in members], np.float64)
        pb = np.array([tracks[i]["pts"][b - spans[i][0]] for i in members], np.float64)
        _, inliers = cv2.findFundamentalMat(pa, pb, cv2.FM_RANSAC, limit, 0.999, 4000)
        if inliers is None:
            continue
        for i, ok in zip(members, inliers.ravel(), strict=True):
            seen[i] += 1
            bad[i] += int(not ok)
    keep = [t for i, t in enumerate(tracks) if seen[i] == 0 or bad[i] / seen[i] <= share]
    return keep, len(tracks) - len(keep)


def main() -> None:  # noqa: C901, PLR0915 - one pass over the plate keeps the tracker state local
    """Track the plate, filter the tracks and write them."""
    request = json.loads(Path(sys.argv[1]).read_text())
    capture = cv2.VideoCapture(request["plate"])
    if not capture.isOpened():
        message = f"cannot open plate: {request['plate']}"
        raise FileNotFoundError(message)
    fps = capture.get(cv2.CAP_PROP_FPS)
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    first, last = request.get("frames") or [0, total - 1]
    lk = {
        "winSize": (21, 21),
        "maxLevel": 4,
        "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01),
    }
    finished: list[dict] = []
    active: list[dict] = []
    prev = None
    size = None
    next_id = 0
    lost_fb = 0
    for index in range(last + 1):
        ok, frame = capture.read()
        if not ok:
            break
        if index < first:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        size = (gray.shape[1], gray.shape[0])
        hold = load_matte(request.get("matte_dir"), request["matte_pattern"], index, gray.shape, request["matte_dilate_px"])
        local = index - first
        if prev is not None and active:
            p0 = np.array([t["pts"][-1] for t in active], np.float32).reshape(-1, 1, 2)
            p1, st1, _ = cv2.calcOpticalFlowPyrLK(prev, gray, p0, None, **lk)
            p0r, st2, _ = cv2.calcOpticalFlowPyrLK(gray, prev, p1, None, **lk)
            fb = np.linalg.norm((p0 - p0r).reshape(-1, 2), axis=1)
            keep = []
            for track, point, s1, s2, err in zip(active, p1.reshape(-1, 2), st1.ravel(), st2.ravel(), fb, strict=True):
                x, y = float(point[0]), float(point[1])
                inside = EDGE <= x < size[0] - EDGE and EDGE <= y < size[1] - EDGE
                held = inside and hold[int(y), int(x)]
                if s1 and s2 and err <= request["fb_max_px"] and inside and not held:
                    track["pts"].append([x, y])
                    keep.append(track)
                else:
                    lost_fb += int(bool(s1 and s2 and err > request["fb_max_px"]))
                    finished.append(track)
            active = keep
        if prev is None or local % request["redetect_every"] == 0:
            existing = np.array([t["pts"][-1] for t in active], np.float32).reshape(-1, 2)
            for x, y in detect(gray, hold, existing, request):
                active.append({"id": next_id, "f0": local, "pts": [[float(x), float(y)]]})
                next_id += 1
        prev = gray
    finished.extend(active)
    tracks = [t for t in finished if len(t["pts"]) >= request["min_length"]]
    tracks.sort(key=lambda t: t["id"])
    frames = last - first + 1
    tracks, rejected = epipolar_filter(tracks, frames, request)
    coverage = np.zeros(frames, int)
    for t in tracks:
        coverage[t["f0"] : t["f0"] + len(t["pts"])] += 1
    lengths = [len(t["pts"]) for t in tracks]
    out = Path(request["output"])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"size": list(size or (0, 0)), "fps": fps, "first": first, "tracks": tracks}))
    stats = {
        "tracks": len(tracks),
        "median_length": float(np.median(lengths)) if lengths else 0.0,
        "min_per_frame": int(coverage.min()) if frames else 0,
        "median_per_frame": float(np.median(coverage)) if frames else 0.0,
        "dropped_forward_backward": lost_fb,
        "rejected_epipolar": rejected,
    }
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "tracks": str(out),
                "count": len(tracks),
                "frames": frames,
                "size": list(size or (0, 0)),
                "stats": stats,
            }
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
