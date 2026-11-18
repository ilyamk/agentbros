"""Constrained planar camera estimation with genuinely held-out image tracks."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from scipy.spatial.transform import Rotation

HOLDOUT_THRESHOLD = 128


def initial_world(points: np.ndarray, calibration: dict[str, Any], mapping: np.ndarray, size: tuple[int, int], focal: float) -> np.ndarray:
    """Bind initial tracks to an explicitly calibrated reference plane."""
    width, height = size
    if calibration.get("initialPose"):
        pose = calibration["initialPose"]
        origin = np.asarray(pose["translation"])
        orientation = Rotation.from_quat(pose["rotation"]).as_matrix()
        rays = np.c_[(points[:, 0, 0] - width / 2) / focal, -(points[:, 0, 1] - height / 2) / focal, -np.ones(len(points))] @ orientation.T
        distances = -origin[1] / rays[:, 1]
        if not np.isfinite(distances).all() or (distances <= 0).any():
            message = "Initial camera rays must intersect the plane in front of the camera"
            raise RuntimeError(message)
        return origin + rays * distances[:, None]
    world2 = cv2.perspectiveTransform(points, mapping)[:, 0]
    return np.c_[world2[:, 0], np.zeros(len(world2)), world2[:, 1]]


def solve_pose(world: np.ndarray, points: np.ndarray, intrinsic: np.ndarray, minimum: int) -> tuple[np.ndarray, np.ndarray]:
    """Fit robustly using only the training partition, never held-out residuals."""
    _, inliers = cv2.findHomography(world[:, [0, 2]], points, cv2.RANSAC, 1.5)
    if inliers is None or np.count_nonzero(inliers) < minimum:
        message = "Insufficient rigid training inliers for the planar pose"
        raise RuntimeError(message)
    selected = inliers[:, 0].astype(bool)
    success, rotation, translation = cv2.solvePnP(world[selected], points[selected], intrinsic, np.zeros((4, 1)), flags=cv2.SOLVEPNP_ITERATIVE)
    if not success:
        message = "Planar training pose solve failed"
        raise RuntimeError(message)
    return cv2.solvePnPRefineLM(world[selected], points[selected], intrinsic, np.zeros((4, 1)), rotation, translation)


def foreground(request: dict[str, Any], index: int, size: tuple[int, int]) -> np.ndarray:
    """Exclude explicitly supplied foreground holdouts without using fit residuals."""
    if not request.get("matte"):
        return np.zeros(size[::-1], dtype=np.uint8)
    filename = request["matte"] % index if "%" in request["matte"] else request["matte"]
    matte = cv2.imread(filename, cv2.IMREAD_GRAYSCALE)
    if matte is None or matte.shape != size[::-1]:
        message = "Tracking holdout is missing or differs from the plate raster"
        raise RuntimeError(message)
    return cv2.dilate(matte, np.ones((7, 7), dtype=np.uint8))


def main() -> None:  # noqa: PLR0915 - one bounded sequential tracking transaction
    """Estimate only an explicitly calibrated rigid plane; preserve fit evidence."""
    request = json.loads(Path(sys.argv[1]).read_text())
    output = Path(sys.argv[2])
    minimum_features, minimum_partition, maximum_initial_error_px = 20, 8, 2.0
    calibration = request["calibration"]
    width, height = request["width"], request["height"]
    focal = calibration["focalPx"]
    intrinsic = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.0]])
    corners = np.array(calibration["corners"], dtype=np.float32)
    w, h = calibration["planeWidthM"] / 2, calibration["planeHeightM"] / 2
    plane = np.array([[-w, -h], [w, -h], [w, h], [-w, h]], dtype=np.float32)
    image_to_plane = cv2.getPerspectiveTransform(corners, plane)
    capture = cv2.VideoCapture(request["plate"])
    ok, frame = capture.read()
    if not ok:
        message = "Cannot decode the original plate"
        raise RuntimeError(message)
    mask = np.zeros((height, width), np.uint8)
    cv2.fillConvexPoly(mask, corners.astype(np.int32), 255)
    mask[foreground(request, 0, (width, height)) > HOLDOUT_THRESHOLD] = 0
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    points = cv2.goodFeaturesToTrack(gray, 500, 0.01, 4, mask=mask)
    if points is None or len(points) < minimum_features:
        message = "At least twenty rigid planar features are required"
        raise RuntimeError(message)
    reference_gray, reference_points = gray.copy(), points.copy()
    world = initial_world(points, calibration, image_to_plane, (width, height), focal)
    fit = np.arange(len(points)) % 2 == 0
    alive = np.ones(len(points), dtype=bool)
    poses, errors = [], []
    writer = cv2.VideoWriter(str(output / "tracking-preview.mp4"), cv2.VideoWriter.fourcc(*"mp4v"), request["fps"], (width, height))
    limit = int(np.ceil(request["duration"] * request["fps"]))
    for index in range(limit):
        if index:
            ok, frame = capture.read()
            if not ok:
                message = "Plate ended during the requested solve"
                raise RuntimeError(message)
            following = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            tracked, status, _ = cv2.calcOpticalFlowPyrLK(reference_gray, following, reference_points, points.copy(), flags=cv2.OPTFLOW_USE_INITIAL_FLOW)
            back, reverse_status, _ = cv2.calcOpticalFlowPyrLK(following, reference_gray, tracked, np.empty_like(tracked))
            alive = (status[:, 0] > 0) & (reverse_status[:, 0] > 0) & (np.linalg.norm(back - reference_points, axis=2)[:, 0] < 1.0)
            points, gray = tracked, following
        current_holdout = foreground(request, index, (width, height))
        pixels = np.round(points[:, 0]).astype(int)
        inside = (pixels[:, 0] >= 0) & (pixels[:, 0] < width) & (pixels[:, 1] >= 0) & (pixels[:, 1] < height)
        safe = np.clip(pixels, [0, 0], [width - 1, height - 1])
        alive &= inside & (current_holdout[safe[:, 1], safe[:, 0]] <= HOLDOUT_THRESHOLD)
        train, held = alive & fit, alive & ~fit
        if train.sum() < minimum_partition or held.sum() < minimum_partition:
            message = "Insufficient surviving fit or held-out tracks; choose another plane"
            raise RuntimeError(message)
        rotation, translation = solve_pose(world[train], points[train, 0], intrinsic, minimum_partition)
        matrix = cv2.Rodrigues(rotation)[0]
        projected = cv2.projectPoints(world[held], rotation, translation, intrinsic, np.zeros((4, 1)))[0][:, 0]
        residual = np.linalg.norm(projected - points[held, 0], axis=1)
        if index == 0 and np.quantile(residual, 0.95) > maximum_initial_error_px:
            message = "Initial rectangle, scale and focal length disagree; supply a consistent calibration or initial camera pose"
            raise RuntimeError(message)
        errors.append(
            {"frame": index, "fitCount": int(train.sum()), "heldOutCount": int(held.sum()), "heldOutRmsPx": float(np.sqrt(np.mean(residual**2))), "heldOutP95Px": float(np.quantile(residual, 0.95))}
        )
        position = (-matrix.T @ translation).ravel()
        orientation = Rotation.from_matrix(matrix.T @ np.diag([1.0, -1.0, -1.0])).as_quat()
        poses.append(
            {
                "translation": position.tolist(),
                "rotation": orientation.tolist(),
                "R": matrix.ravel().tolist(),
                "t": translation.ravel().tolist(),
                "time": request.get("pts", [i / request["fps"] for i in range(limit)])[index],
            }
        )
        for point in points[held, 0]:
            cv2.circle(frame, tuple(np.round(point).astype(int)), 3, (60, 220, 60), 1)
        writer.write(frame)
    capture.release()
    writer.release()
    camera = {"version": 2, "fps": request["fps"], "image_size": [width, height], "K": intrinsic.ravel().tolist(), "dist": [0] * 5, "frames": poses}
    (output / "camera.json").write_text(json.dumps(camera) + "\n")
    report = {
        "schemaVersion": 1,
        "source": {"plateSha256": hashlib.sha256(Path(request["plate"]).read_bytes()).hexdigest(), "cameraSha256": hashlib.sha256((output / "camera.json").read_bytes()).hexdigest()},
        "frames": errors,
        "assumptions": [
            "Rigid plane",
            "Provided focal length and scale/initial pose",
            "Zero lens distortion",
            "No rolling-shutter solution",
            "Foreground holdouts exclude occluded features independently of fit residuals",
            "RANSAC only uses the training partition",
            "Tracks match the initial frame directly, avoiding incremental drift",
        ],
        "visualAcceptance": "pending",
    }
    (output / "tracking-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"frames": len(poses), "maximumHeldOutP95Px": max(row["heldOutP95Px"] for row in errors)}))  # noqa: T201 - worker JSON protocol


if __name__ == "__main__":
    main()
