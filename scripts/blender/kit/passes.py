# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Reference passes for `refs:derive` op `blender-pass` (RFC 0003 §3.7, AC10): control signals from a previs scene.

Run only through `blender:run` with `--blend SCENE --no-render` (src/lib/references/derive/blender.ts does this); the
script renders its own frames because data passes need 16-bit output the runner's 8-bit PNG setting cannot carry.

Argument (JSON object): `pass` (beauty, clay, depth, normal, mist, camera-path), optional `width`, `height` (pixels) and
`frames` (count from the scene's frame_start), and `samples` (beauty only). Writes beside the runner output:

- `sequence/frame-NNNNNN.png` and `pass.json` for image passes;
- `camera.json` for camera-path (`avc_export.export_camera`: location, quaternion, lens, sensor, size and fps per frame).

Conventions, recorded in `pass.json`:

- depth: camera Z distance in metres, 16-bit grey, linear between `nearM` (65535, white) and `farM` (1), normalised
  once over the whole sequence so values never flicker between frames; the background (no surface) is 0.
- normal: camera space (X right, Y up, Z towards the camera), 16-bit RGB as n * 0.5 + 0.5; background (0.5, 0.5, 1).
- mist: Blender's mist pass from the world's mist settings, 16-bit grey, 0 at the start, 1 (white) at the far end.
- clay: Workbench, one matte grey for every surface, 8-bit RGB. beauty: the scene's own engine and look, 8-bit RGB.

Data passes render with Cycles on the CPU, one sample and the narrowest pixel filter, so a value is the surface under
the pixel centre rather than a blend across an edge. Every value is a function of the frame: no clocks, no randomness.
"""

from __future__ import annotations

import json
import struct
import sys
import tempfile
import zlib
from pathlib import Path
from typing import Any, TypeAlias

import avc_export
import bpy
import numpy as np

Params: TypeAlias = dict[str, Any]

PASSES = ("beauty", "clay", "depth", "normal", "mist", "camera-path")
DEFAULTS: Params = {"pass": "depth", "width": None, "height": None, "frames": None, "samples": None}
BACKGROUND_DEPTH = 1e9
CLAY_GREY = (0.6, 0.6, 0.6)
MAX16 = 65535


def parse_args() -> Params:
    """Merge the JSON argument over the defaults; unknown keys and unknown passes are errors."""
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    given: Params = json.loads(argv[0]) if argv else {}
    unknown = sorted(set(given) - set(DEFAULTS))
    if unknown:
        msg = f"Unknown pass arguments: {', '.join(unknown)}. Known: {', '.join(sorted(DEFAULTS))}"
        raise ValueError(msg)
    merged = {**DEFAULTS, **given}
    if merged["pass"] not in PASSES:
        msg = f"Unknown pass {merged['pass']!r}; choose one of {', '.join(PASSES)}"
        raise ValueError(msg)
    return merged


def write_png16(path: Path, pixels: np.ndarray) -> None:
    """Write a 16-bit grey (H x W) or RGB (H x W x 3) PNG, top row first, with fixed zlib settings (stable bytes)."""
    height, width = pixels.shape[:2]
    colour_type = 0 if pixels.ndim == 2 else 2  # PNG colour types: 0 grey, 2 RGB.
    rows = pixels.reshape(height, -1).astype(">u2")
    raw = b"".join(b"\x00" + rows[y].tobytes() for y in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 16, colour_type, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def compositor_output(scene: bpy.types.Scene, socket: str) -> None:
    """Route one render-layer output straight to the compositor's result (Blender 5 node group)."""
    tree = bpy.data.node_groups.new(f"avc-pass-{socket.lower()}", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    layers = tree.nodes.new("CompositorNodeRLayers")
    layers.scene = scene
    out = tree.nodes.new("NodeGroupOutput")
    tree.links.new(layers.outputs[socket], out.inputs[0])
    scene.compositing_node_group = tree
    scene.render.use_compositing = True


def data_render_settings(scene: bpy.types.Scene) -> None:
    """Cycles on the CPU, one sample, the narrowest filter, no blur or denoise: values at the pixel centre."""
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    scene.cycles.filter_width = 0.01
    scene.cycles.seed = 0
    scene.render.use_motion_blur = False
    scene.render.film_transparent = False
    scene.render.dither_intensity = 0
    settings = scene.render.image_settings
    settings.file_format = "OPEN_EXR"
    settings.color_depth = "32"
    settings.exr_codec = "ZIP"
    settings.color_mode = "RGBA"
    scene.render.use_file_extension = True


def render_float(scene: bpy.types.Scene, frame: int, scratch: Path) -> np.ndarray:
    """Render one frame to a 32-bit EXR and return its pixels as H x W x 4 floats, top row first."""
    scene.frame_set(frame)
    target = scratch.joinpath(f"raw-{frame:06d}.exr")
    scene.render.filepath = str(target)
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(str(target))
    try:
        image.colorspace_settings.name = "Non-Color"
        width, height = image.size
        values = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(values)
    finally:
        bpy.data.images.remove(image)
    return np.flipud(values.reshape(height, width, 4))


def render_png8(scene: bpy.types.Scene, frames: range, sequence: Path) -> None:
    """Render 8-bit RGB PNG frames through the scene's own colour management."""
    settings = scene.render.image_settings
    settings.file_format = "PNG"
    settings.color_depth = "8"
    settings.color_mode = "RGB"
    settings.compression = 15
    scene.render.use_file_extension = True
    for frame in frames:
        scene.frame_set(frame)
        scene.render.filepath = str(sequence.joinpath(f"frame-{frame:06d}.png"))
        bpy.ops.render.render(write_still=True)


def depth_pass(scene: bpy.types.Scene, frames: range, sequence: Path, scratch: Path) -> Params:
    """Z distance, normalised once over the sequence: near white, far and background black."""
    bpy.context.view_layer.use_pass_z = True
    compositor_output(scene, "Depth")
    data_render_settings(scene)
    raw = [render_float(scene, frame, scratch)[:, :, 0] for frame in frames]
    clip_end = scene.camera.data.clip_end
    valid = [(z > 0) & (z < min(BACKGROUND_DEPTH, clip_end)) & np.isfinite(z) for z in raw]
    if not any(mask.any() for mask in valid):
        msg = "The camera sees no geometry: the depth pass would be empty."
        raise RuntimeError(msg)
    near = float(min(z[mask].min() for z, mask in zip(raw, valid, strict=True) if mask.any()))
    far = float(max(z[mask].max() for z, mask in zip(raw, valid, strict=True) if mask.any()))
    span = max(far - near, 1e-6)
    for frame, z, mask in zip(frames, raw, valid, strict=True):
        level = np.where(mask, 1 + np.rint(np.clip((far - z) / span, 0.0, 1.0) * (MAX16 - 1)), 0)
        write_png16(sequence.joinpath(f"frame-{frame:06d}.png"), level.astype(np.uint16))
    return {"nearM": round(near, 6), "farM": round(near + span, 6), "bitDepth": 16, "channels": 1, "encoding": "linear camera Z; nearM = 65535 (white), farM = 1, background = 0"}


def normal_pass(scene: bpy.types.Scene, frames: range, sequence: Path, scratch: Path) -> Params:
    """World normals rotated into camera space per frame, encoded n * 0.5 + 0.5."""
    bpy.context.view_layer.use_pass_normal = True
    compositor_output(scene, "Normal")
    data_render_settings(scene)
    for frame in frames:
        world = render_float(scene, frame, scratch)[:, :, :3]
        rotation = scene.camera.matrix_world.to_3x3().normalized()
        to_camera = np.array(rotation.transposed(), dtype=np.float64)
        camera = world.reshape(-1, 3) @ to_camera.T
        length = np.linalg.norm(camera, axis=1, keepdims=True)
        empty = length[:, 0] < 0.5  # Background normals are zero vectors.
        camera = np.where(length > 0, camera / np.maximum(length, 1e-12), 0.0)
        encoded = np.clip(camera * 0.5 + 0.5, 0.0, 1.0)
        encoded[empty] = (0.5, 0.5, 1.0)
        pixels = np.rint(encoded.reshape(world.shape) * MAX16).astype(np.uint16)
        write_png16(sequence.joinpath(f"frame-{frame:06d}.png"), pixels)
    return {"bitDepth": 16, "channels": 3, "encoding": "camera space, X right, Y up, Z towards the camera; n * 0.5 + 0.5; background (0.5, 0.5, 1)"}


def mist_pass(scene: bpy.types.Scene, frames: range, sequence: Path, scratch: Path) -> Params:
    """Blender's mist pass from the world's mist settings (a world is added with defaults when the scene has none)."""
    if scene.world is None:
        scene.world = bpy.data.worlds.new("avc-mist")
    bpy.context.view_layer.use_pass_mist = True
    compositor_output(scene, "Mist")
    data_render_settings(scene)
    for frame in frames:
        mist = np.clip(render_float(scene, frame, scratch)[:, :, 0], 0.0, 1.0)
        write_png16(sequence.joinpath(f"frame-{frame:06d}.png"), np.rint(mist * MAX16).astype(np.uint16))
    settings = scene.world.mist_settings
    return {
        "bitDepth": 16,
        "channels": 1,
        "mistStartM": round(settings.start, 6),
        "mistDepthM": round(settings.depth, 6),
        "mistFalloff": settings.falloff,
        "encoding": "mist 0 at mistStartM, 65535 (white) at mistStartM + mistDepthM",
    }


def clay_pass(scene: bpy.types.Scene, frames: range, sequence: Path) -> Params:
    """Workbench with one matte grey: composition and camera, not a depth map."""
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "SINGLE"
    shading.single_color = CLAY_GREY
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    render_png8(scene, frames, sequence)
    return {"bitDepth": 8, "channels": 3, "encoding": "Workbench studio light, single grey"}


def beauty_pass(scene: bpy.types.Scene, frames: range, sequence: Path, samples: int | None) -> Params:
    """The scene as authored: its engine, lights and look; alpha is dropped."""
    if samples and scene.render.engine == "CYCLES":
        scene.cycles.samples = samples
    scene.render.film_transparent = False
    render_png8(scene, frames, sequence)
    return {"bitDepth": 8, "channels": 3, "encoding": f"{scene.render.engine}, view {scene.view_settings.view_transform}"}


def main() -> None:
    """Render the requested pass and write its receipt beside the frames."""
    args = parse_args()
    scene = bpy.context.scene
    if scene.camera is None:
        msg = "The scene has no active camera."
        raise RuntimeError(msg)
    if args["width"] and args["height"]:
        scene.render.resolution_x, scene.render.resolution_y = int(args["width"]), int(args["height"])
    scene.render.resolution_percentage = 100
    first = scene.frame_start
    count = int(args["frames"]) if args["frames"] else scene.frame_end - scene.frame_start + 1
    frames = range(first, first + count)
    output = Path(avc_export.output_path("pass.json")).parent
    receipt: Params = {
        "schemaVersion": 1,
        "pass": args["pass"],
        "frameStart": first,
        "frameEnd": first + count - 1,
        "frames": count,
        "width": scene.render.resolution_x,
        "height": scene.render.resolution_y,
        "fps": scene.render.fps / scene.render.fps_base,
        "blenderVersion": bpy.app.version_string,
    }
    kind = args["pass"]
    if kind == "camera-path":
        avc_export.export_camera(str(output.joinpath("camera.json")), scene=scene, frames=(first, first + count - 1))
        receipt["camera"] = "camera.json"
    else:
        sequence = output.joinpath("sequence")
        sequence.mkdir(parents=True, exist_ok=False)
        with tempfile.TemporaryDirectory(prefix="avc-pass-") as scratch_dir:
            scratch = Path(scratch_dir)
            data = {"depth": depth_pass, "normal": normal_pass, "mist": mist_pass}
            if kind in data:
                receipt.update(data[kind](scene, frames, sequence, scratch))
            elif kind == "clay":
                receipt.update(clay_pass(scene, frames, sequence))
            else:
                receipt.update(beauty_pass(scene, frames, sequence, args["samples"]))
        receipt["engine"] = scene.render.engine
        receipt["sequence"] = "sequence"
        receipt["files"] = [f"frame-{frame:06d}.png" for frame in frames]
        missing = [name for name in receipt["files"] if not sequence.joinpath(name).is_file()]
        if missing:
            msg = f"Blender did not write {', '.join(missing[:3])}"
            raise RuntimeError(msg)
    with output.joinpath("pass.json").open("w", encoding="utf8") as handle:
        json.dump(receipt, handle, indent=2)


main()
