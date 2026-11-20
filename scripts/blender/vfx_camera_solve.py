# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Solve a moving camera from imported 2D feature tracks with Blender's libmv, and export it for Vork.

Intent: a matchmove for inserting 3D elements into live or generated footage whose camera moves with parallax,
where the planar `vork:vfx` solve does not apply. Runs with `blender:run --no-render`; called by `pnpm camera:solve`.

The first script argument is a JSON object or a path to one, with exactly these keys:
  plate (str)            the plate video
  tracks (str)           tracks JSON from scripts/workers/camera-tracks.py (pixels, top-left origin, zero-based frames)
  output (str)           directory for camera.json, bundles.json, solve-report.json and solve.blend
  focal_px (float)       initial focal length in pixels
  sensor_width_mm (float) sensor width used to express the focal length in millimetres (default 36)
  refine (str)           "focal" (default) or "none"; distortion is never refined: the export is undistorted
  max_tracks (int)       longest tracks imported (default 1200)
  min_length (int)       shortest track imported, in frames (default 20)
  target_error_px (float) stop cleaning once the average reprojection error is at or below this (default 0.5)
  clean_rounds (int)     maximum solve-clean rounds (default 5)
  keyframes ([int, int] | null) solver keyframes in plate frames; null lets libmv choose
  min_tracks_per_frame (int) cleaning never leaves a frame with fewer active tracks (default 12)

Outputs (OpenCV conventions, frame indices zero-based from the plate start):
  camera.json  {"K", "image_size", "fps", "frame_start": 0, "dist": [0,0,0,0,0], "frames": [{"R", "t"}]}
               world-to-camera extrinsics per plate frame, the sidecar `src/lib/vork/camera.ts` reads
  bundles.json {"points": [{"id", "xyz", "error", "frames"}]} triangulated track positions in the same world
  solve-report.json  errors, focal, solved/missing frames, rounds and the independent reprojection check
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import bpy
from mathutils import Matrix, Vector

DEFAULTS: dict[str, Any] = {
    "sensor_width_mm": 36.0,
    "refine": "focal",
    "max_tracks": 1200,
    "min_length": 20,
    "target_error_px": 0.5,
    "clean_rounds": 5,
    "keyframes": None,
    "min_tracks_per_frame": 12,
}
REQUIRED = ("plate", "tracks", "output", "focal_px")


def read_params() -> dict[str, Any]:
    """The JSON parameters after "--", checked against the known keys."""
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if not argv:
        msg = "vfx_camera_solve.py needs a JSON object or file as its first argument"
        raise ValueError(msg)
    raw = argv[0]
    params = json.loads(raw) if raw.lstrip().startswith("{") else json.loads(Path(raw).read_text())
    unknown = sorted(set(params) - set(DEFAULTS) - set(REQUIRED))
    if unknown:
        msg = f"Unknown keys: {', '.join(unknown)}"
        raise ValueError(msg)
    missing = [key for key in REQUIRED if key not in params]
    if missing:
        msg = f"Missing keys: {', '.join(missing)}"
        raise ValueError(msg)
    return {**DEFAULTS, **params}


def clip_context(clip: bpy.types.MovieClip) -> dict[str, Any]:
    """A Clip Editor context: the solve operator polls for one, also in background mode."""
    window = bpy.context.window
    if window is None:
        msg = "No window in this Blender session; the camera solve needs one (it exists under factory startup)"
        raise RuntimeError(msg)
    area = window.screen.areas[0]
    area.type = "CLIP_EDITOR"
    space = area.spaces.active
    space.clip = clip
    space.mode = "TRACKING"
    return {"window": window, "area": area, "space_data": space, "edit_movieclip": clip}


def import_tracks(clip: bpy.types.MovieClip, data: dict[str, Any], params: dict[str, Any]) -> int:
    """Add the worker tracks as clip markers; returns how many were imported."""
    width, height = data["size"]
    tracks = [t for t in data["tracks"] if len(t["pts"]) >= params["min_length"]]
    tracks.sort(key=lambda t: (-len(t["pts"]), t["id"]))
    tracks = tracks[: params["max_tracks"]]
    collection = clip.tracking.tracks
    for track in tracks:
        start = track["f0"] + 1  # clip frames are one-based
        item = collection.new(name=f"k{track['id']}", frame=start)
        for offset, (x, y) in enumerate(track["pts"]):
            item.markers.insert_frame(start + offset, co=(x / width, 1.0 - y / height))
        end = item.markers.insert_frame(start + len(track["pts"]), co=tuple(item.markers[-1].co))
        end.mute = True
    return len(tracks)


def configure(clip: bpy.types.MovieClip, params: dict[str, Any], width: int) -> None:
    """Set the camera intrinsics, keyframes and refinement for the solve."""
    camera = clip.tracking.camera
    camera.sensor_width = params["sensor_width_mm"]
    camera.pixel_aspect = 1.0
    camera.units = "PIXELS"
    camera.focal_length_pixels = params["focal_px"]
    camera.distortion_model = "POLYNOMIAL"
    camera.k1 = camera.k2 = camera.k3 = 0.0
    if hasattr(camera, "principal_point"):
        camera.principal_point = (0.0, 0.0)  # normalised, centre of the frame
    settings = clip.tracking.settings
    settings.refine_intrinsics_focal_length = params["refine"] == "focal"
    settings.refine_intrinsics_principal_point = False
    settings.refine_intrinsics_radial_distortion = False
    settings.refine_intrinsics_tangential_distortion = False
    tracking_object = clip.tracking.objects.active
    if params["keyframes"]:
        settings.use_keyframe_selection = False
        tracking_object.keyframe_a = params["keyframes"][0] + 1
        tracking_object.keyframe_b = params["keyframes"][1] + 1
    else:
        settings.use_keyframe_selection = True
    del width


def solve(context: dict[str, Any], clip: bpy.types.MovieClip) -> float:
    """Run the libmv solve; returns the average reprojection error in pixels."""
    with bpy.context.temp_override(**context):
        bpy.ops.clip.solve_camera()
    reconstruction = clip.tracking.objects.active.reconstruction
    if not reconstruction.is_valid:
        msg = "Camera solve failed"
        raise RuntimeError(msg)
    return float(reconstruction.average_error)


def clean(context: dict[str, Any], clip: bpy.types.MovieClip, limit: float, min_per_frame: int) -> int:
    """Delete tracks above the error limit (worst first) unless that leaves a frame under `min_per_frame` tracks.

    Tracks without a bundle are always removed. Returns how many tracks were deleted.
    """
    coverage: dict[int, int] = {}
    spans = {}
    for track in clip.tracking.tracks:
        frames = [m.frame for m in track.markers if not m.mute]
        spans[track.name] = frames
        for frame in frames:
            coverage[frame] = coverage.get(frame, 0) + 1
    candidates = sorted(
        (t for t in clip.tracking.tracks if (not t.has_bundle) or t.average_error > limit),
        key=lambda t: -(t.average_error if t.has_bundle else 1e9),
    )
    chosen = set()
    for track in candidates:
        frames = spans[track.name]
        if track.has_bundle and any(coverage[f] - 1 < min_per_frame for f in frames):
            continue
        chosen.add(track.name)
        for frame in frames:
            coverage[frame] -= 1
    for track in clip.tracking.tracks:
        track.select = track.name in chosen
    if chosen:
        with bpy.context.temp_override(**context):
            bpy.ops.clip.delete_track(confirm=False)
    return len(chosen)


def export(clip: bpy.types.MovieClip, data: dict[str, Any], history: list[dict], directory: Path) -> dict[str, Any]:  # noqa: C901
    """Write camera.json, bundles.json and solve-report.json for the current solve."""
    width, height = data["size"]
    frames = 1 + max(t["f0"] + len(t["pts"]) - 1 for t in data["tracks"])
    camera = clip.tracking.camera
    fx = float(camera.focal_length_pixels)
    k = [[fx, 0.0, width / 2.0], [0.0, fx, height / 2.0], [0.0, 0.0, 1.0]]
    reconstruction = clip.tracking.objects.active.reconstruction
    solved = {c.frame - 1: c for c in reconstruction.cameras}
    flip = Matrix(((1, 0, 0), (0, -1, 0), (0, 0, -1)))
    poses: list[dict[str, Any]] = []
    missing = []
    for index in range(frames):
        cam = solved.get(index)
        if cam is None:
            missing.append(index)
            poses.append({})
            continue
        world = cam.matrix  # camera to world, Blender camera axes (looks down -Z, Y up)
        rotation = world.to_3x3().normalized()
        centre = world.to_translation()
        r_cv = flip @ rotation.transposed()
        t_cv = -(r_cv @ centre)
        poses.append({"R": [list(row) for row in r_cv], "t": list(t_cv)})
    # hold the nearest solved pose for unsolved frames at the ends (reported as missing)
    for index in missing:
        near = min(solved, key=lambda f: abs(f - index))
        poses[index] = poses[near]
    out = directory
    out.mkdir(parents=True, exist_ok=True)
    fps = data["fps"]
    (out / "camera.json").write_text(
        json.dumps(
            {
                "K": k,
                "image_size": [width, height],
                "fps": fps,
                "frame_start": 0,
                "dist": [0.0, 0.0, 0.0, 0.0, 0.0],
                "frames": poses,
            }
        )
    )
    points: list[dict[str, Any]] = []
    for track in clip.tracking.tracks:
        if not track.has_bundle:
            continue
        markers = [m for m in track.markers if not m.mute]
        points.append(
            {
                "id": track.name,
                "xyz": list(track.bundle),
                "error": float(track.average_error),
                "frames": [m.frame - 1 for m in markers],
                "uv": [[m.co[0] * width, (1.0 - m.co[1]) * height] for m in markers],
            }
        )
    (out / "bundles.json").write_text(json.dumps({"points": points}))
    # independent check: reproject bundles with the exported OpenCV pose, against the imported markers
    errors = []
    per_frame: dict[int, list[float]] = {}
    for point in points:
        xyz = Vector(point["xyz"])
        for frame, (u, v) in zip(point["frames"], point["uv"], strict=True):
            pose = poses[frame]
            if frame in missing:
                continue
            r = Matrix(pose["R"])
            c = r @ xyz + Vector(pose["t"])
            if c.z <= 0:
                continue
            pu = fx * c.x / c.z + width / 2.0
            pv = fx * c.y / c.z + height / 2.0
            e = math.hypot(pu - u, pv - v)
            errors.append(e)
            per_frame.setdefault(frame, []).append(e)
    errors.sort()
    # geometric sanity: a collapsed solve puts the points on the camera with a low error
    centres = [Matrix(p["R"]).transposed() @ -Vector(p["t"]) for i, p in enumerate(poses) if i not in missing]
    lows = Vector([min(c[i] for c in centres) for i in range(3)])
    highs = Vector([max(c[i] for c in centres) for i in range(3)])
    span = (highs - lows).length
    depths = []
    for point in points:
        xyz = Vector(point["xyz"])
        for frame in point["frames"][::5]:
            if frame in missing:
                continue
            depths.append((Matrix(poses[frame]["R"]) @ xyz + Vector(poses[frame]["t"])).z)
    depths.sort()
    median_depth = depths[len(depths) // 2] if depths else 0.0
    behind = sum(1 for d in depths if d <= 0) / len(depths) if depths else 1.0
    ratio = median_depth / span if span > 0 else 0.0
    geometry = {
        "cameraSpan": span,
        "medianDepth": median_depth,
        "depthToSpan": ratio,
        "behindShare": behind,
        "sane": ratio >= 0.3 and behind <= 0.01,
    }
    frame_means = {f: sum(v) / len(v) for f, v in per_frame.items()}
    worst = sorted(frame_means.items(), key=lambda kv: -kv[1])[:5]
    report = {
        "averageErrorPx": float(reconstruction.average_error),
        "focalPx": fx,
        "focalMm": float(camera.focal_length),
        "sensorWidthMm": float(camera.sensor_width),
        "imageSize": [width, height],
        "frames": frames,
        "solvedFrames": len(solved),
        "missingFrames": missing,
        "bundles": len(points),
        "minTracksPerFrame": min((len(v) for v in per_frame.values()), default=0),
        "rounds": history,
        "geometry": geometry,
        "check": {
            "observations": len(errors),
            "meanPx": sum(errors) / len(errors) if errors else None,
            "medianPx": errors[len(errors) // 2] if errors else None,
            "p95Px": errors[int(len(errors) * 0.95)] if errors else None,
            "worstFrames": [{"frame": f, "meanPx": e} for f, e in worst],
        },
    }
    (out / "solve-report.json").write_text(json.dumps(report, indent=1))
    return report


def main() -> None:
    """Solve, clean in rounds, export every round and keep the best sane one."""
    params = read_params()
    data = json.loads(Path(params["tracks"]).read_text())
    clip = bpy.data.movieclips.load(params["plate"])
    clip.frame_start = 1
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = clip.frame_duration
    scene.render.fps = round(data["fps"]) if abs(data["fps"] - round(data["fps"])) < 1e-3 else scene.render.fps
    imported = import_tracks(clip, data, params)
    configure(clip, params, data["size"][0])
    context = clip_context(clip)
    history: list[dict[str, Any]] = []
    out = Path(params["output"])
    error = solve(context, clip)
    focal = clip.tracking.camera.focal_length_pixels
    history.append({"round": 0, "tracks": imported, "errorPx": error, "focalPx": focal})
    sys.stderr.write(f"camera-solve round 0: error {error:.3f} px, focal {focal:.1f} px" + "\n")
    reports = [export(clip, data, history, out / "rounds" / "0")]
    for round_index in range(1, params["clean_rounds"] + 1):
        if error <= params["target_error_px"]:
            break
        errors = sorted(t.average_error for t in clip.tracking.tracks if t.has_bundle)
        median = errors[len(errors) // 2]
        limit = max(params["target_error_px"], min(3.0 * median, errors[int(len(errors) * 0.85)]))
        removed = clean(context, clip, limit, params["min_tracks_per_frame"])
        if removed == 0:
            break
        try:
            error = solve(context, clip)
        except RuntimeError as failure:
            history.append({"round": round_index, "removed": removed, "limitPx": limit, "failed": str(failure)})
            sys.stderr.write(f"camera-solve round {round_index}: solve failed, keeping earlier rounds" + "\n")
            break
        history.append(
            {
                "round": round_index,
                "removed": removed,
                "limitPx": limit,
                "tracks": len(clip.tracking.tracks),
                "errorPx": error,
                "focalPx": clip.tracking.camera.focal_length_pixels,
            }
        )
        sys.stderr.write(f"camera-solve round {round_index}: removed {removed}, error {error:.3f} px" + "\n")
        reports.append(export(clip, data, history, out / "rounds" / str(round_index)))
    # best round: the lowest error, penalised by the share of unsolved frames (5x weight)
    frames_total = max(r["frames"] for r in reports)

    def score(i: int) -> float:
        return reports[i]["averageErrorPx"] * (1 + 5 * len(reports[i]["missingFrames"]) / frames_total)

    sane = [i for i in range(len(reports)) if reports[i]["geometry"]["sane"]]
    best = min(sane or range(len(reports)), key=score)
    for name in ("camera.json", "bundles.json"):
        (out / name).write_bytes((out / "rounds" / str(best) / name).read_bytes())
    report = {**reports[best], "rounds": history, "bestRound": best, "saneRounds": sane}
    (out / "solve-report.json").write_text(json.dumps(report, indent=1))
    sys.stderr.write(f"camera-solve best round {best}: error {reports[best]['averageErrorPx']:.3f} px" + "\n")
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "solve.blend"))


main()
