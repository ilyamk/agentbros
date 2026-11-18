# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
# ruff: noqa: PLR0912
"""Bake Mantaflow once, publish verified mesh/VDB snapshots, render without a live solver."""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import time
from pathlib import Path
from typing import Any

from avc_arsenal import paths, repo_root
from avc_live_protocol import contained

from _common import cache_hash


def remap_frame(frame: float, freeze: float = 18, hold: float = 12, slow: float = 0.12) -> float:
    """Continuous freeze ramp; a held interval advances slowly and resumes without a jump."""
    if frame <= freeze:
        return frame
    if frame <= freeze + hold:
        return freeze + (frame - freeze) * slow
    return frame - hold * (1 - slow)


def _cube(name: str, location: tuple[float, ...], scale: tuple[float, ...]) -> Any:
    import bpy

    bpy.ops.mesh.primitive_cube_add(size=2, location=location)
    obj = bpy.context.object
    obj.name = "AVC " + name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def _digest(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def valid_receipt(directory: Path, receipt: dict[str, Any]) -> bool:
    """Partial or altered cache payloads cannot be reused as completed bakes."""
    try:
        return bool(receipt["files"]) and all(
            Path(name).name == name and not (directory / name).is_symlink() and (directory / name).is_file() and _digest(directory / name) == digest for name, digest in receipt["files"].items()
        )
    except (KeyError, OSError, TypeError, AttributeError):
        return False


def _simulate(scene: Any, p: dict[str, Any], mode: str, directory: Path) -> dict[str, Any]:
    import bpy

    old_range = scene.frame_start, scene.frame_end, scene.frame_current
    owned_objects, owned_meshes = set(bpy.data.objects), set(bpy.data.meshes)
    collection = None
    try:
        scene.frame_start, scene.frame_end = 1, p["simulation_frames"]
        collection = bpy.data.collections.new("AVC Isolated fluid inputs")
        scene.collection.children.link(collection)
        domain = _cube("Fluid domain", (0, 0, 1.8), (2.2, 2.2, 1.8))
        modifier = domain.modifiers.new("AVC Mantaflow bake only", "FLUID")
        modifier.fluid_type = "DOMAIN"
        settings = modifier.domain_settings
        gas = mode == "smoke"
        settings.domain_type = "GAS" if gas else "LIQUID"
        settings.resolution_max = p["resolution"]
        settings.cache_type = "MODULAR"
        settings.cache_frame_start, settings.cache_frame_end = 1, p["simulation_frames"]
        settings.cache_directory = str(directory / "solver")
        settings.cache_data_format = "OPENVDB"
        settings.time_scale = 0.75
        settings.timesteps_min, settings.timesteps_max = 2, 6
        settings.fluid_group = collection
        settings.effector_group = collection
        if not gas:
            settings.use_mesh = True
            settings.mesh_scale = p["mesh_scale"]
            settings.mesh_particle_radius = 1.4
            settings.mesh_smoothen_pos, settings.mesh_smoothen_neg = 2, 2
            settings.use_fractions = True
            settings.flip_ratio = 0.97
        if mode == "splash":
            bpy.ops.mesh.primitive_torus_add(major_radius=0.84, minor_radius=0.085, major_segments=64, minor_segments=16, location=(0, 0, 0.31))
        else:
            bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=0.22 if gas else 0.24, location=(0, 0, 0.22 if gas else 2.6))
        source = bpy.context.object
        source.name = "AVC Fluid emitter"
        rng = random.Random(p["seed"])
        phase = rng.uniform(0, math.tau)
        source.rotation_euler.z = phase
        if mode == "splash":
            for vertex in source.data.vertices:
                angle = math.atan2(vertex.co.y, vertex.co.x)
                radial = 1 + 0.09 * math.sin(5 * angle + phase)
                vertex.co.x *= radial
                vertex.co.y *= radial
                vertex.co.z += 0.065 * math.sin(7 * angle + phase)
            # Detached seeded liquid charges are simulated with the crown, not animated particles.
            charges = [source]
            for index in range(9):
                angle = phase + math.tau * index / 9
                radius = rng.uniform(1.18, 1.5)
                bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=rng.uniform(0.045, 0.075), location=(radius * math.cos(angle), radius * math.sin(angle), rng.uniform(0.4, 0.65)))
                charges.append(bpy.context.object)
            bpy.ops.object.select_all(action="DESELECT")
            for charge in charges:
                charge.select_set(state=True)
            bpy.context.view_layer.objects.active = source
            bpy.ops.object.join()
        for existing in list(source.users_collection):
            existing.objects.unlink(source)
        collection.objects.link(source)
        flow = source.modifiers.new("AVC Fluid flow", "FLUID")
        flow.fluid_type = "FLOW"
        flow.flow_settings.flow_type = "SMOKE" if gas else "LIQUID"
        flow.flow_settings.flow_behavior = "INFLOW"
        if mode == "splash":
            for frame, emitting in ((1, True), (2, True), (3, False)):
                flow.flow_settings.use_inflow = emitting
                flow.flow_settings.keyframe_insert("use_inflow", frame=frame)
            flow.flow_settings.velocity_normal = 1.8
        flow.flow_settings.use_initial_velocity = True
        flow.flow_settings.velocity_coord = (0, 0, 3.5 if mode == "splash" else 0.8 if gas else -1.7)
        if gas:
            flow.flow_settings.density = 1.6
            flow.flow_settings.temperature = 1.5
        if mode == "splash":
            bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.43, depth=1.8, location=(0, 0, 0.92))
            obstacle = bpy.context.object
            for existing in list(obstacle.users_collection):
                existing.objects.unlink(obstacle)
            collection.objects.link(obstacle)
            effector = obstacle.modifiers.new("AVC Can collision", "FLUID")
            effector.fluid_type = "EFFECTOR"
        bpy.context.view_layer.objects.active = domain
        domain.select_set(state=True)
        frames, payloads = [], {}
        scene.frame_set(1)
        if bpy.ops.fluid.bake_data() != {"FINISHED"}:
            msg = "Mantaflow data bake did not finish"
            raise RuntimeError(msg)
        if gas:
            files = sorted((directory / "solver" / "data").glob("*.vdb"))
            if len(files) != p["simulation_frames"]:
                msg = "Mantaflow did not publish every VDB frame"
                raise RuntimeError(msg)
            for index, file in enumerate(files, 1):
                target = directory / f"density_{index:04d}.vdb"
                target.write_bytes(file.read_bytes())
                payloads[target.name] = _digest(target)
            return {"files": payloads, "frames": len(files), "kind": "volume", "location": list(domain.location)}
        if bpy.ops.fluid.bake_mesh() != {"FINISHED"}:
            msg = "Mantaflow mesh bake did not finish"
            raise RuntimeError(msg)
        for frame in range(1, p["simulation_frames"] + 1):
            scene.frame_set(frame)
            evaluated = domain.evaluated_get(bpy.context.evaluated_depsgraph_get())
            data = bpy.data.meshes.new_from_object(evaluated)
            data.name = f"AVC fluid snapshot {frame:04d}"
            # Store world coordinates; no live domain transform or modifier remains.
            data.transform(domain.matrix_world)
            for face in data.polygons:
                face.use_smooth = True
            frames.append(data)
        if not any(len(data.polygons) for data in frames):
            msg = "Mantaflow produced an empty liquid mesh sequence"
            raise RuntimeError(msg)
        target = directory / "meshes.blend"
        temporary = directory / f"meshes-{os.getpid()}.blend"
        bpy.data.libraries.write(str(temporary), set(frames), fake_user=True, compress=True)
        temporary.replace(target)
        return {"files": {target.name: _digest(target)}, "frames": [data.name for data in frames], "kind": "mesh", "polygons": [len(data.polygons) for data in frames]}
    finally:
        for obj in set(bpy.data.objects) - owned_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        for data in set(bpy.data.meshes) - owned_meshes:
            if data.users == 0:
                bpy.data.meshes.remove(data)
        if collection is not None:
            bpy.data.collections.remove(collection)
        scene.frame_start, scene.frame_end = old_range[:2]
        scene.frame_set(old_range[2])


def apply_fluid(scene: Any, p: dict[str, Any], mode: str, mat: Any) -> dict[str, Any]:
    """Reuse verified solver output; pin solver version, scene physics and all recipe code."""
    import bpy

    started = time.monotonic()
    context = {"blender": bpy.app.version_string, "fps": scene.render.fps / scene.render.fps_base, "gravity": list(scene.gravity), "units": scene.unit_settings.scale_length, "mode": mode}
    directory = Path(paths()["bakes"]) / ("mantaflow-" + mode) / cache_hash("mantaflow-" + mode, {k: v for k, v in p.items() if k not in {"freeze_ramp", "method"}}, context)
    directory = Path(contained(repo_root(), str(directory)))
    directory.mkdir(parents=True, exist_ok=True)
    if any(file.is_symlink() for file in directory.rglob("*")):
        msg = "Symlinks are not allowed in a fluid cache"
        raise ValueError(msg)
    file = directory / "bake.json"
    receipt = json.loads(file.read_text()) if file.exists() else {}
    reused = valid_receipt(directory, receipt)
    if not reused:
        receipt = _simulate(scene, p, mode, directory)
        temporary = directory / f"bake-{os.getpid()}.tmp"
        temporary.write_text(json.dumps(receipt, sort_keys=True), encoding="utf8")
        temporary.replace(file)
    if receipt["kind"] == "mesh":
        with bpy.data.libraries.load(str(directory / "meshes.blend")) as (_source, dest):
            dest.meshes = receipt["frames"]
        frames = dest.meshes
        obj = bpy.data.objects.new("AVC Baked juice", frames[0])
        scene.collection.objects.link(obj)
        for data in frames:
            data.materials.clear()
            data.materials.append(mat)
        smooth = obj.modifiers.new("AVC Surface relaxation", "SMOOTH")
        smooth.factor, smooth.iterations = 0.6, 3

        object_name = obj.name

        def select_frame(current: Any, *_: Any) -> None:
            if current is not scene:
                return
            if bpy.data.objects.get(object_name) is not obj:
                if select_frame in bpy.app.handlers.frame_change_pre:
                    bpy.app.handlers.frame_change_pre.remove(select_frame)
                return
            f = remap_frame(current.frame_current + current.frame_subframe) if p.get("freeze_ramp") else current.frame_current + current.frame_subframe
            obj.data = frames[max(0, min(len(frames) - 1, math.floor(f) - 1))]

        select_frame.avc_fluid_object = obj.name  # ty: ignore[missing-attribute]
        for handler in list(bpy.app.handlers.frame_change_pre):
            if getattr(handler, "avc_fluid_object", None) == obj.name:
                bpy.app.handlers.frame_change_pre.remove(handler)
        bpy.app.handlers.frame_change_pre.append(select_frame)
        select_frame(scene)
    else:
        volume = bpy.data.volumes.new("AVC Baked smoke density")
        volume.filepath = str(directory / "density_0001.vdb")
        volume.is_sequence = True
        volume.frame_start, volume.frame_duration = 1, receipt["frames"]
        volume.sequence_mode = "EXTEND"
        obj = bpy.data.objects.new("AVC Baked smoke", volume)
        scene.collection.objects.link(obj)
        volume.materials.append(mat)
    obj["avc_bake"] = str(file)
    return {"objects": [obj.name], "materials": [mat.name], "bake": {"path": str(file), "reused": reused, "seconds": time.monotonic() - started}}
