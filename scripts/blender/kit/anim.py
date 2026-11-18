# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Animation layer of the craft kit: intent curves as real F-curve keys, and a timeline that bakes composed motion.

Two ways to animate, both deterministic:

- `key_intent` writes two keys with Bezier handles that reproduce an intent curve exactly (snap, glide, punch, float,
  brake are cubic beziers, the same as timing.ts). Use it for simple moves an agent or a person may edit in Blender
  (a live session): the curve stays a curve. `settle` is a spring, not a bezier, so it is baked per frame.
- `Timeline` evaluates functions of the frame (anticipation plus follow-through plus breathing, a camera rig, a light
  flicker) and keys every frame of exactly the channels it owns, LINEAR. Composed motion cannot be two keys.

Blender frame 1 is block frame 0, as in toy_kit. Never `toy_kit.linear_all()` after `key_intent`: it flattens every
curve in the file. Timeline.bake linearises only its own channels.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from typing import Self, TypedDict, cast

import bpy

from . import curves


class Channel(TypedDict):
    """One owned animation channel and its frame-driven layers."""

    owner: bpy.types.bpy_struct
    path: str
    fns: list[Callable[[float], curves.MotionValue]]


def fcurves_of(owner: bpy.types.bpy_struct) -> list[bpy.types.FCurve]:
    """Every F-curve of the owner's action, legacy or Blender 5 layered (slots and channel bags)."""
    data = getattr(owner, "animation_data", None)
    if not data or not data.action:
        return []
    action = data.action
    if hasattr(action, "fcurves") and len(getattr(action, "layers", [])) == 0:
        return list(action.fcurves)
    out = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                if data.action_slot is None or bag.slot == data.action_slot:
                    out.extend(bag.fcurves)
    return out


def _anchor(owner: bpy.types.bpy_struct, path: str) -> tuple[bpy.types.ID, str]:
    """(ID that holds the action, full data path): a pose bone's or a node socket's curves live on its ID."""
    if isinstance(owner, bpy.types.ID):
        return owner, path
    return owner.id_data, owner.path_from_id(path)


def fcurve(owner: bpy.types.bpy_struct, path: str, index: int = 0) -> bpy.types.FCurve:
    """Find the owned F-curve for a property and component."""
    holder, full = _anchor(owner, path)
    for curve in fcurves_of(holder):
        if curve.data_path == full and curve.array_index == index:
            return curve
    error_message = f"No F-curve {full}[{index}] on {holder}"
    raise KeyError(error_message)


def _resolve(owner: bpy.types.bpy_struct, path: str) -> tuple[bpy.types.bpy_struct, str]:
    """(holder, attribute) for a dotted path such as "dof.focus_distance"."""
    *head, last = path.split(".")
    holder = owner
    for part in head:
        holder = getattr(holder, part)
    return holder, last


def _get(owner: bpy.types.bpy_struct, path: str) -> curves.MotionValue:
    holder, attr = _resolve(owner, path)
    return getattr(holder, attr)


def _set(owner: bpy.types.bpy_struct, path: str, value: curves.MotionValue) -> None:
    holder, attr = _resolve(owner, path)
    current = getattr(holder, attr)
    if hasattr(current, "__len__") and isinstance(value, (int, float)):
        value = [value] * len(current)
    setattr(holder, attr, value)


def _width(value: curves.MotionValue) -> int:
    return len(value) if isinstance(value, Sequence) else 0


def key_intent(owner: bpy.types.bpy_struct, path: str, f0: float, v0: curves.MotionValue, f1: float, v1: curves.MotionValue, intent: str = "brake") -> None:
    """Two keys at block frames f0 and f1 whose segment is the intent curve, with FREE Bezier handles.

    A CSS cubic-bezier (x1, y1, x2, y2) on a segment from (f0, v0) to (f1, v1) is key 0's right handle at
    (f0 + x1 df, v0 + y1 dv) and key 1's left handle at (f0 + x2 df, v0 + y2 dv); Blender evaluates the same curve.
    `settle` and `linear` have no bezier form and are baked per frame. Works on scalars and vectors (one curve per
    component); `path` may be dotted (camera data "dof.focus_distance").
    """
    if intent not in curves.BEZIER:
        fn = lambda frame: curves.mix(v0, v1, curves.progress(frame, f0, f1 - f0, intent))  # noqa: E731
        tl = Timeline(range(int(f0), int(f1) + 1))
        tl.add(owner, path, fn)
        tl.bake()
        return
    x1, y1, x2, y2 = curves.BEZIER[intent]
    df = f1 - f0
    _set(owner, path, v0)
    owner.keyframe_insert(path, frame=f0 + 1)
    _set(owner, path, v1)
    owner.keyframe_insert(path, frame=f1 + 1)
    n = _width(_get(owner, path))
    starts: list[float] = list(cast("Sequence[float]", v0)) if isinstance(v0, Sequence) else [v0] * max(1, n)
    ends: list[float] = list(cast("Sequence[float]", v1)) if isinstance(v1, Sequence) else [v1] * max(1, n)
    if len(starts) != max(1, n) or len(ends) != max(1, n):
        error_message = "Key values must match the channel width"
        raise ValueError(error_message)
    for index in range(max(1, n)):
        curve = fcurve(owner, path, index)
        a = next(p for p in curve.keyframe_points if abs(p.co.x - (f0 + 1)) < 1e-6)
        b = next(p for p in curve.keyframe_points if abs(p.co.x - (f1 + 1)) < 1e-6)
        dv = ends[index] - starts[index]
        a.interpolation = "BEZIER"
        a.handle_right_type = "FREE"
        b.handle_left_type = "FREE"
        a.handle_right = (f0 + 1 + x1 * df, starts[index] + y1 * dv)
        b.handle_left = (f0 + 1 + x2 * df, starts[index] + y2 * dv)
        curve.update()


class Timeline:
    """Channels driven by functions of the block frame, baked as one key per frame on exactly those channels.

    tl = Timeline(range(frames)); tl.add(obj, "location", lambda f: (...)); tl.bake()

    A channel's function returns a scalar or a tuple; several functions on one channel are summed when `combine` is
    "add" (layers: a move plus handheld wobble plus breathing), or the last wins ("set").
    """

    def __init__(self, frames: Iterable[int]) -> None:
        """Store block frames and initialise the owned animation channels."""
        self.frames = list(frames)
        self.channels: dict[tuple[int, str], Channel] = {}

    def add(self, owner: bpy.types.bpy_struct, path: str, fn: Callable[[float], curves.MotionValue], combine: str = "add") -> Self:
        """Add a frame-driven layer to an owned animation channel."""
        key = (owner.as_pointer() if hasattr(owner, "as_pointer") else id(owner), path)
        entry = self.channels.setdefault(key, {"owner": owner, "path": path, "fns": []})
        if combine == "set":
            entry["fns"] = []
        entry["fns"].append(fn)
        return self

    def value(self, owner: bpy.types.bpy_struct, path: str, frame: float) -> curves.MotionValue:
        """Evaluate the composed channel at a block frame."""
        key = (owner.as_pointer() if hasattr(owner, "as_pointer") else id(owner), path)
        return self._sum(self.channels[key]["fns"], frame)

    @staticmethod
    def _sum(fns: Iterable[Callable[[float], curves.MotionValue]], frame: float) -> curves.MotionValue:
        values = iter(fn(frame) for fn in fns)
        try:
            total: curves.MotionValue = next(values)
        except StopIteration as error:
            message = "An animation channel needs at least one layer"
            raise ValueError(message) from error
        for value in values:
            if isinstance(total, Sequence) and isinstance(value, Sequence):
                total = tuple(a + b for a, b in zip(cast("Sequence[float]", total), cast("Sequence[float]", value), strict=True))
            elif isinstance(total, (int, float)) and isinstance(value, (int, float)):
                total += value
            else:
                message = "Animation layers must have matching scalar or vector shapes"
                raise TypeError(message)
        return total

    def bake(self) -> None:
        """Write the configured motion layers as per-frame keys."""
        for entry in self.channels.values():
            owner, path = entry["owner"], entry["path"]
            for frame in self.frames:
                _set(owner, path, self._sum(entry["fns"], frame))
                owner.keyframe_insert(path, frame=frame + 1)
            n = _width(_get(owner, path))
            first, last = self.frames[0] + 1, self.frames[-1] + 1
            for index in range(max(1, n)):
                for point in fcurve(owner, path, index).keyframe_points:
                    if first <= point.co.x <= last:
                        point.interpolation = "LINEAR"


def evaluate(owner: bpy.types.bpy_struct, path: str, frame: float, index: int = 0) -> float:
    """The F-curve value at a block frame (for tests and checks)."""
    return fcurve(owner, path, index).evaluate(frame + 1)


def volume(stretch: float, base: float = 1.0) -> tuple[float, float, float]:
    """Scale tuple for a volume-preserving squash/stretch along Z, times a uniform base size."""
    sx, sy, sz = curves.volume_scale(stretch)
    return (sx * base, sy * base, sz * base)
