"""Metric scale for a camera solve from a subject of known width (a person's head by default).

Spawned by src/lib/vfx/camera-solve.ts (`pnpm camera:solve --scale-matte`) with one argument, a request JSON file:
{"solve": dir with camera.json, solve-report.json and bundles.json, "output": dir, "matte_dir": str,
 "matte_pattern": "frame-{:05d}.png", "subject_width_m": 0.16}

The subject is the top band of the matte (its top row down 0.9 subject widths). Its centroid gives one camera ray per
solved frame; the least-squares intersection of those rays is the subject centre in solve units. The scale makes the
camera-to-subject distance equal fx * subject_width_m / subject_width_px (median over frames). The output directory
gets camera.json and bundles.json in metres, solve-report.json with scaleMetresPerUnit and subject.json.
Prints one JSON object. Deterministic.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

MIN_PIXELS = 200


def anchor(camera: dict, missing: set[int], request: dict) -> tuple[np.ndarray, float, dict]:
    """Least-squares subject centre from matte rays, and the metres-per-unit scale."""
    K = np.array(camera["K"])  # noqa: N806 - camera matrix notation
    fx, cx, cy = K[0, 0], K[0, 2], K[1, 2]
    width_m = float(request.get("subject_width_m", 0.16))
    directory = Path(request["matte_dir"])
    pattern = request.get("matte_pattern", "frame-{:05d}.png")
    normal = np.zeros((3, 3))
    target = np.zeros(3)
    observations = []
    for index, pose in enumerate(camera["frames"]):
        if index in missing:
            continue
        image = cv2.imread(str(directory / pattern.format(index)), cv2.IMREAD_GRAYSCALE)
        if image is None:
            continue
        mask = image > 128  # noqa: PLR2004
        rows = np.where(mask.any(axis=1))[0]
        if len(rows) == 0 or rows[0] <= 2:  # noqa: PLR2004 - subject cut by the frame edge
            continue
        top = int(rows[0])
        widths = [int(mask[r].sum()) for r in range(top, min(top + 140, mask.shape[0]))]
        width = float(np.median(widths[20:90])) if len(widths) > 90 else float(np.median(widths))  # noqa: PLR2004
        ys, xs = np.nonzero(mask[top : top + int(0.9 * width)])
        if len(xs) < MIN_PIXELS:
            continue
        u, v = xs.mean(), ys.mean() + top
        R, t = np.array(pose["R"]), np.array(pose["t"])  # noqa: N806 - rotation matrix notation
        centre = -R.T @ t
        ray = R.T @ np.array([(u - cx) / fx, (v - cy) / fx, 1.0])
        ray /= np.linalg.norm(ray)
        projector = np.eye(3) - np.outer(ray, ray)
        normal += projector
        target += projector @ centre
        observations.append((width, centre, ray, index))
    if len(observations) < 2:  # noqa: PLR2004
        msg = "too few frames show the subject's top for a scale anchor"
        raise ValueError(msg)
    subject = np.linalg.solve(normal, target)
    ratios, misses = [], []
    for width, centre, ray, _ in observations:
        offset = subject - centre
        units = np.linalg.norm(offset)
        ratios.append(fx * width_m / width / units)
        misses.append(np.linalg.norm(offset - np.dot(offset, ray) * ray) / units)
    scale = float(np.median(ratios))
    # Ray lines can meet behind the cameras when the subject drifts against the solved background (generated plates):
    # report the share of frames that see the point in front, and a per-frame subject track at the metric distance
    # implied by its screen width (always in front, on the matte ray), which inserts and focus pulls can rely on.
    ahead = [float(np.dot(subject - centre, ray) > 0) for _, centre, ray, _ in observations]
    track = {str(index): (centre * scale + ray * (fx * width_m / width)).tolist() for width, centre, ray, index in observations}
    facts = {
        "frames_used": len(observations),
        "subject_width_m": width_m,
        "camera_to_subject_m_median": float(np.median([fx * width_m / o[0] for o in observations])),
        "ray_miss_ratio_median": float(np.median(misses)),
        "scale_spread_p10_p90": [float(np.percentile(ratios, 10)), float(np.percentile(ratios, 90))],
        "subject_in_front_share": float(np.mean(ahead)),
        "subject_track_m": track,
    }
    if facts["subject_in_front_share"] < 0.5:  # noqa: PLR2004
        facts["warning"] = "the least-squares subject point lies behind the camera; use subject_track_m or distances"
    return subject, scale, facts


def main() -> None:
    """Read the request, scale the solve and write the metric copy."""
    request = json.loads(Path(sys.argv[1]).read_text())
    solve, out = Path(request["solve"]), Path(request["output"])
    camera = json.loads((solve / "camera.json").read_text())
    report = json.loads((solve / "solve-report.json").read_text())
    subject, scale, facts = anchor(camera, set(report.get("missingFrames", [])), request)
    out.mkdir(parents=True, exist_ok=True)
    for frame in camera["frames"]:
        frame["t"] = [value * scale for value in frame["t"]]
    (out / "camera.json").write_text(json.dumps(camera))
    bundles_path = solve / "bundles.json"
    if bundles_path.exists():
        bundles = json.loads(bundles_path.read_text())
        for point in bundles["points"]:
            point["xyz"] = [value * scale for value in point["xyz"]]
        (out / "bundles.json").write_text(json.dumps(bundles))
    report["scaleMetresPerUnit"] = scale
    (out / "solve-report.json").write_text(json.dumps(report, indent=1))
    result = {
        "subject_world_units": subject.tolist(),
        "subject_world_m": (subject * scale).tolist(),
        "scale_m_per_unit": scale,
        **facts,
    }
    (out / "subject.json").write_text(json.dumps(result, indent=1))
    sys.stdout.write(json.dumps({"ok": True, "output": str(out), **result}) + "\n")


if __name__ == "__main__":
    main()
