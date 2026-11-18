# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Light moods (kit.presets.MOODS) built round a subject, and light animation: sweep, flicker and reveal.

    rig = light.mood("soft-product", target=(0, 0, 0.15), size=0.3, camera_yaw=0)
    rig.sweep("rim", -40, 30, at=0, frames=90).reveal("key", at=0, frames=20).bake(timeline)

Lights are placed relative to the camera direction, so "key camera-left" stays camera-left whatever the yaw. Power comes
from the share of the key's irradiance, compensated for distance, so ratios hold at any scale. Colour temperature uses
Blender's own black-body light temperature.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, Self, TypeAlias, TypedDict, Unpack

import bpy
from mathutils import Vector

from . import anim, curves, presets

if TYPE_CHECKING:
    from collections.abc import Collection, Mapping, Sequence


class MoodOptions(TypedDict, total=False):
    """Optional settings accepted by the light mood constructor."""

    target: Sequence[float]
    size: float
    camera_yaw: float
    exposure: float
    hdri_rotation: float
    use_world: bool
    world_strength: float | None
    only: Collection[str] | None
    scale: Mapping[str, float] | None


Params: TypeAlias = dict[str, Any]


SHARED_HDRI = os.path.abspath(str(Path(str(Path(__file__).parent)).joinpath("..", "..", "..", "public", "shared", "hdri")))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.
HDRIS = {
    "studio": "studio_small_09_2k.hdr",
    "softbox": "studio_small_08_2k.hdr",
    "warm": "brown_photostudio_02_2k.hdr",
    "loft": "photo_studio_loft_hall_2k.hdr",
}


def hex_linear(value: str | Sequence[float]) -> tuple[float, ...]:
    """Convert sRGB hexadecimal colour or existing linear components to linear RGB."""
    if not isinstance(value, str):
        return tuple(value)
    value = value.lstrip("#")
    srgb = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


def world(hdri: str | None = None, strength: float = 0.3, rotation: float = 0.0, colour: str | None = None) -> bpy.types.Node:
    """World: an HDRI for reflections at low strength, or a flat colour. Returns the Background node."""
    scene = bpy.context.scene
    w = scene.world or bpy.data.worlds.new("world")
    scene.world = w
    w.use_nodes = True
    nodes, links = w.node_tree.nodes, w.node_tree.links
    background = nodes["Background"]
    background.inputs["Strength"].default_value = strength
    if hdri:
        name = HDRIS.get(hdri, hdri)
        env = nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(name if Path(name).is_absolute() else str(Path(SHARED_HDRI).joinpath(name)), check_existing=True)
        mapping = nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value = (0, 0, math.radians(rotation))
        coord = nodes.new("ShaderNodeTexCoord")
        links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], env.inputs["Vector"])
        links.new(env.outputs["Color"], background.inputs["Color"])
    elif colour:
        background.inputs["Color"].default_value = (*hex_linear(colour), 1)
    return background


class Mood:
    """Build a lighting mood and its frame-driven changes."""

    def __init__(
        self,
        name: str,
        target: Sequence[float] = (0, 0, 0),
        size: float = 0.3,
        camera_yaw: float = 0.0,
        exposure: float = 9.0,
        world_strength: float | None = None,
        hdri_rotation: float = 0.0,
        use_world: bool = True,
        only: Collection[str] | None = None,
        scale: Mapping[str, float] | None = None,
    ) -> None:
        r"""Build a mood around the subject with explicit light ratios and exposure.

        `size` is the subject's size in metres; `exposure` the key's irradiance (W/m^2) at the subject; `scale` per
        light name multiplies its share (a mood tweak without a new mood); `only` keeps those lights.
        """
        self.name = name
        self.preset = presets.MOODS[name]
        self.target = Vector(target)
        self.size = size
        self.camera_yaw = camera_yaw
        self.exposure = exposure
        self.lights = {}
        self.anims = []
        for spec in self.preset["lights"]:
            if only and spec["name"] not in only:
                continue
            share = spec["share"] * (scale or {}).get(spec["name"], 1.0)
            self.lights[spec["name"]] = self._make(spec, share)
        if use_world:
            world(self.preset.get("hdri"), self.preset["world"] if world_strength is None else world_strength, hdri_rotation)

    def _position(self, az: float, el: float, dist: float) -> Vector:
        yaw = math.radians(self.camera_yaw + az)
        e = math.radians(el)
        d = dist * self.size
        return self.target + Vector((math.sin(yaw) * math.cos(e), -math.cos(yaw) * math.cos(e), math.sin(e))) * d

    def _make(self, spec: presets.LightSpec, share: float) -> Params:
        kind = spec.get("kind", "AREA")
        data = bpy.data.lights.new(f"{self.name}-{spec['name']}", kind)
        if "colour" in spec:
            data.color = hex_linear(spec["colour"])
        else:
            data.use_temperature = True
            data.temperature = spec.get("kelvin", 6500)
            data.color = (1, 1, 1)
        obj = bpy.data.objects.new(data.name, data)
        bpy.context.scene.collection.objects.link(obj)
        if kind == "SUN":
            data.energy = 4.2 * share * self.exposure / 9.0
            data.angle = math.radians(spec.get("angle", 2.0))
            direction = self._position(spec["az"], spec["el"], 1.0) - self.target
            # A sun shines along its -Z: point +Z back towards where the light comes from.
            obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
            power = data.energy
        else:
            data.shape = "RECTANGLE"
            data.size = spec["size"] * self.size
            data.size_y = data.size * spec.get("ratio", 0.75)
            d = spec["dist"] * self.size
            # Irradiance of a Lambertian area light on its axis is about P / (pi d^2): power for the wanted share.
            power = self.exposure * share * math.pi * d * d
            data.energy = power
            obj.location = self._position(spec["az"], spec["el"], spec["dist"])
            obj.rotation_euler = (self.target - obj.location).to_track_quat("-Z", "Y").to_euler()
        return {"obj": obj, "spec": spec, "power": power}

    def light(self, name: str) -> bpy.types.Object:
        """Return a named light from this mood."""
        return self.lights[name]["obj"]

    def sweep(self, name: str, az_from: float, az_to: float, at: float = 0, frames: float = 60, intent: str = "glide", el: float | None = None) -> Self:
        """Moves a light round the subject from az_from to az_to degrees (its highlight travels across the surface)."""
        entry = self.lights[name]
        spec = entry["spec"]
        elevation = spec["el"] if el is None else el

        def location(f: float) -> tuple[float, ...]:
            az = az_from + (az_to - az_from) * curves.progress(f, at, frames, intent)
            return tuple(self._position(az, elevation, spec.get("dist", 3.0)))

        def rotation(f: float) -> tuple[float, ...]:
            loc = Vector(location(f))
            return tuple((self.target - loc).to_track_quat("-Z", "Y").to_euler())

        self.anims.append((entry["obj"], "location", location))
        self.anims.append((entry["obj"], "rotation_euler", rotation))
        return self

    def flicker(self, name: str, seed: int = 0, depth: float = 0.25, rate: float = 9.0) -> Self:
        """Layer seeded energy variation on a named light."""
        entry = self.lights[name]
        power = entry["power"]
        self.anims.append((entry["obj"].data, "energy", lambda f: power * curves.flicker(f, seed, depth=depth, rate=rate)))
        return self

    def reveal(self, name: str, at: float = 0, frames: float = 18, intent: str = "brake", start: float = 0.0) -> Self:
        """A light that comes up (from `start` of its power): the reveal light that brings the subject out of black."""
        entry = self.lights[name]
        power = entry["power"]
        self.anims.append((entry["obj"].data, "energy", lambda f: power * curves.mix(start, 1.0, curves.clamp01(curves.progress(f, at, frames, intent)))))
        return self

    def bake(self, timeline: anim.Timeline) -> Self:
        """Write the configured motion layers as per-frame keys."""
        for owner, path, fn in self.anims:
            timeline.add(owner, path, fn, combine="set")
        return self


def mood(name: str, **kwargs: Unpack[MoodOptions]) -> Mood:
    """Create a light mood with the supplied optional settings."""
    return Mood(name, **kwargs)
