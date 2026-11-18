# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Camera rigs: a virtual operator whose every parameter is a function of the frame.

A `Rig` aims at a target from a yaw, a pitch and a distance, then layers a truck (sideways), a boom (up), a whip,
handheld wobble and roll, a zoom and a focus. Moves are helpers that set those tracks with an intent curve:

    rig = Rig(a, role="hero", target=(0, 0, 0.15), subject=(0.3, 0.3))   # lens, f-stop, height, fill from the role
    rig.push_in(0.82, at=0, frames=90, intent="glide")                   # 18% closer, focus follows the subject
    rig.orbit(-12, 8, at=0, frames=90)                                   # a slow arc round it
    rig.handheld(0.25)                                                   # an operator's hands, 0.6-2.5 Hz
    rig.bake(timeline)

Every rig takes a lens (mm), a sensor (mm, horizontal fit) and an intent; roles (curves.ROLES) give the defaults for a
hero, reveal, detail or establishing shot. Focus is a distance keyed per frame from the camera to the focus point, so a
push keeps focus and a pull or rack is an explicit move.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import Literal, Self, TypeVar, cast, overload

import bpy
from mathutils import Euler, Quaternion, Vector

from . import anim, curves

T = TypeVar("T")


def _const(value: T) -> Callable[[float], T]:
    return lambda _frame: value


class Rig:
    """Compose deterministic camera moves, framing and focus tracks."""

    def __init__(
        self,
        a: Mapping[str, float],
        role: str = "hero",
        target: Sequence[float] = (0, 0, 0),
        subject: tuple[float, float] = (0.3, 0.3),
        lens: float | None = None,
        fstop: float | None = None,
        sensor: float = 36.0,
        yaw: float = 0.0,
        pitch: float | None = None,
        distance: float | None = None,
        fill: float | None = None,
        name: str = "camera",
    ) -> None:
        """`a` holds width and height (the render's aspect). `subject` is (width, height) in metres for framing.

        `pitch` is degrees above the target (default from the role's height); `distance` defaults to the role's fill.
        """
        r = curves.ROLES[role]
        self.a = a
        self.role = role
        self.lens_mm = lens or r["lens"]
        self.fstop = r["fstop"] if fstop is None else fstop
        self.sensor = sensor
        self.subject = subject
        self.base_target = Vector(target)
        fill = fill or r["fill"]
        self.distance0 = distance or curves.fit_distance(self.lens_mm, subject[0], subject[1], a["width"], a["height"], fill, sensor)
        if pitch is None:
            pitch = math.degrees(math.atan2(r["height"] * subject[1], self.distance0))
        self.tracks: dict[str, list[Callable[[float], curves.MotionValue]]] = {
            "yaw": [_const(yaw)],
            "pitch": [_const(pitch)],
            "distance": [_const(self.distance0)],
            "truck": [_const(0.0)],
            "boom": [_const(0.0)],
            "pan": [_const(0.0)],
            "tilt": [_const(0.0)],
            "roll": [_const(0.0)],
            "lens": [_const(self.lens_mm)],
            "target": [lambda _f: (0.0, 0.0, 0.0)],
        }
        self.focus_point = self.target
        self.focus_offset = _const(0.0)
        self.shake = None
        data = bpy.data.cameras.new(name)
        data.lens = self.lens_mm
        data.sensor_width = sensor
        data.sensor_fit = "HORIZONTAL" if a["width"] >= a["height"] else "VERTICAL"
        if data.sensor_fit == "VERTICAL":
            data.sensor_height = sensor
        data.clip_start = 0.005
        data.clip_end = 500
        data.dof.use_dof = self.fstop > 0
        data.dof.aperture_fstop = max(0.5, self.fstop or 2.8)
        data.dof.aperture_blades = 9
        data.dof.aperture_ratio = 1.0
        self.obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(self.obj)
        bpy.context.scene.camera = self.obj
        self.obj.rotation_mode = "XYZ"

    # ---------- evaluation ----------

    @overload
    def value(self, name: Literal["target"], frame: float) -> Sequence[float]: ...

    @overload
    def value(self, name: str, frame: float) -> float: ...

    def value(self, name: str, frame: float) -> curves.MotionValue:
        """Evaluate and add the layers of a camera channel at a block frame."""
        value = anim.Timeline._sum(self.tracks[name], frame)  # noqa: SLF001 -- The pinned SDK exposes this required preprocessing/animation hook.
        if name == "target":
            if not isinstance(value, Sequence):
                message = "Camera target layers must return vectors"
                raise TypeError(message)
        elif not isinstance(value, (int, float)):
            message = "Camera optical and travel layers must return scalars"
            raise TypeError(message)
        return value

    def target(self, frame: float) -> Vector:
        """Return the camera target in world coordinates."""
        return self.base_target + Vector(self.value("target", frame))

    def pose(self, frame: float) -> tuple[Vector, Quaternion, float, float]:
        """(location, rotation_euler, lens, focus_distance) at a block frame (subframes allowed)."""
        yaw = math.radians(self.value("yaw", frame))
        pitch = math.radians(self.value("pitch", frame))
        distance = self.value("distance", frame)
        target = self.target(frame)
        direction = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
        location = target + direction * distance
        forward = (target - location).normalized()
        right = forward.cross(Vector((0, 0, 1)))
        if right.length < 1e-6:
            right = Vector((1, 0, 0))
        right.normalize()
        up = right.cross(forward)
        location = location + right * self.value("truck", frame) + up * self.value("boom", frame)
        aim = target + right * self.value("truck", frame) + up * self.value("boom", frame)
        quat = (aim - location).to_track_quat("-Z", "Y")
        pan, tilt, roll = (math.radians(self.value(n, frame)) for n in ("pan", "tilt", "roll"))
        if self.shake:
            (sp, sy, sr), move = self.shake(frame)
            pan += math.radians(sy)
            tilt += math.radians(sp)
            roll += math.radians(sr)
            location = location + right * move[0] + up * move[1] + forward * move[2]
        # Operator rotations in the camera's own frame: pan about its up, tilt about its right, roll about its view axis.
        quat = quat @ Euler((tilt, pan, roll), "YXZ").to_quaternion()
        focus = (self.focus_point(frame) - location).length + self.focus_offset(frame)
        return location, quat, self.value("lens", frame), max(0.01, focus)

    def bake(self, timeline: anim.Timeline) -> Self:
        """Adds the camera's location, rotation, lens and focus to a Timeline (kit.anim)."""
        previous = {"euler": None}

        def location(frame: float) -> tuple[float, ...]:
            return tuple(self.pose(frame)[0])

        def rotation(frame: float) -> tuple[float, ...]:
            quat = self.pose(frame)[1]
            # Euler continuity across frames: keyed per frame, so the baked values never flip by 360 degrees.
            base = previous["euler"] if previous["euler"] is not None and previous.get("frame") == frame - 1 else None
            euler = quat.to_euler("XYZ", base) if base is not None else quat.to_euler("XYZ")
            previous["euler"], previous["frame"] = euler, frame
            return tuple(euler)

        timeline.add(self.obj, "location", location, combine="set")
        timeline.add(self.obj, "rotation_euler", rotation, combine="set")
        timeline.add(self.obj.data, "lens", lambda f: self.pose(f)[2], combine="set")
        if self.obj.data.dof.use_dof:
            timeline.add(self.obj.data, "dof.focus_distance", lambda f: self.pose(f)[3], combine="set")
        return self

    # ---------- moves ----------

    def _move(self, name: str, start: float, end: float, at: float, frames: float, intent: str | curves.ScalarCurve) -> Self:
        """Adds (end - start) * progress to a scalar track: moves layer on top of each other."""
        self.tracks[name].append(lambda f: (end - start) * curves.progress(f, at, frames, intent))
        return self

    def dolly(self, factor: float, at: float = 0, frames: float = 60, intent: str = "glide") -> Self:
        """Distance times `factor` (< 1 closer, > 1 back): the camera travels, perspective changes."""
        return self._move("distance", self.distance0, self.distance0 * factor, at, frames, intent)

    def push_in(
        self, factor: float = 0.85, at: float = 0, frames: float = 60, intent: str = "glide", pull_from: float | None = None, pull_frames: float | None = None, pull_intent: str = "brake"
    ) -> Self:
        r"""Dolly towards the subject with an optional focus pull.

        A dolly in whose focus stays on the subject. `pull_from` (metres behind the subject, negative in front)
        starts focus off the subject and pulls it on over `pull_frames`: the focus pull that lands the reveal.
        """
        self.dolly(factor, at, frames, intent)
        if pull_from:
            n = pull_frames or max(6, frames // 3)
            self.focus_offset = lambda f: pull_from * (1 - curves.progress(f, at, n, pull_intent))
        return self

    def truck(self, start: float, end: float, at: float = 0, frames: float = 60, intent: str = "glide") -> Self:
        """Sideways travel in metres along the camera's right, the aim travelling with it (parallax, not a pan)."""
        self.tracks["truck"].append(lambda f: start + (end - start) * curves.progress(f, at, frames, intent))
        return self

    def crane(self, pitch_from: float, pitch_to: float, at: float = 0, frames: float = 60, intent: str = "glide", boom: float = 0.0) -> Self:
        """Rises or sinks round the target (pitch in degrees above it), optionally lifting the aim by `boom` metres."""
        self.tracks["pitch"] = [lambda f: pitch_from + (pitch_to - pitch_from) * curves.progress(f, at, frames, intent)]
        if boom:
            self.tracks["boom"].append(lambda f: boom * curves.progress(f, at, frames, intent))
        return self

    def orbit(self, yaw_from: float, yaw_to: float, at: float = 0, frames: float = 60, intent: str = "glide") -> Self:
        """Arcs round the target from yaw_from to yaw_to degrees (0 = from -Y)."""
        self.tracks["yaw"] = [lambda f: yaw_from + (yaw_to - yaw_from) * curves.progress(f, at, frames, intent)]
        return self

    def follow(self, fn: Callable[[float], Sequence[float]], half_life: float = 4.0, weight: float = 1.0) -> Self:
        """Aims at a moving subject with an operator's lag: `fn(frame)` is the subject's offset from the target."""
        self.tracks["target"].append(lambda f: tuple(weight * v for v in curves.smoothed(fn, f, half_life)))
        return self

    def handheld(self, amount: float = 0.25, seed: int = 0, band: tuple[float, float] = (0.6, 2.5), translation: float | None = None) -> Self:
        r"""Layer seeded operator rotation and translation over the camera move.

        An operator's hands: rotation wobble of `amount` degrees in a physical band (0.6-2.5 Hz), roll smaller,
        translation in millimetres. Seeded; a pure function of the frame.
        """
        fps = self.a.get("fps", 30)
        move = 0.004 * amount / 0.25 if translation is None else translation
        self.shake = lambda f: curves.handheld(f, seed=seed, fps=fps, rotation=amount, translation=move, band=band)
        return self

    def whip(self, at: float, frames: float = 6, degrees: float = 40.0, intent: str = "snap", axis: str = "pan") -> Self:
        r"""Layer a fast pan or tilt shaped by the chosen intent.

        A whip pan: `degrees` of pan (or tilt) in `frames`, snap-shaped, so most of it is a blur. Turn motion blur on
        (look.motion_blur) and cut on its middle frame.
        """
        self.tracks[axis].append(lambda f: degrees * curves.progress(f, at, frames, intent))
        return self

    def rack(
        self, point_from: Sequence[float] | Callable[[float], Sequence[float]], point_to: Sequence[float] | Callable[[float], Sequence[float]], at: float = 0, frames: float = 18, intent: str = "snap"
    ) -> Self:
        """Rack focus from one point to another (world positions or functions of the frame)."""
        pa = cast("Callable[[float], Sequence[float]]", point_from) if callable(point_from) else _const(Vector(point_from))
        pb = cast("Callable[[float], Sequence[float]]", point_to) if callable(point_to) else _const(Vector(point_to))
        self.focus_point = lambda f: Vector(pa(f)).lerp(Vector(pb(f)), curves.clamp01(curves.progress(f, at, frames, intent)))
        return self

    def zoom(self, lens_to: float, at: float = 0, frames: float = 60, intent: str = "glide") -> Self:
        """Changes focal length (a zoom, not a dolly: perspective stays). Use sparingly; a dolly reads as a camera."""
        start = self.lens_mm
        self.tracks["lens"] = [lambda f: start + (lens_to - start) * curves.progress(f, at, frames, intent)]
        return self

    def roll(self, degrees_from: float, degrees_to: float, at: float = 0, frames: float = 60, intent: str = "glide") -> Self:
        """Layer a rotation around the camera view axis."""
        self.tracks["roll"].append(lambda f: degrees_from + (degrees_to - degrees_from) * curves.progress(f, at, frames, intent))
        return self

    def frame_offset(self, x: float = 0.0, y: float = 0.0) -> Self:
        r"""Move the subject away from the frame centre by shifting the camera aim.

        Places the subject off centre: x, y as shares of the frame (positive moves the subject right, up), by shifting
        the lens, so perspective does not change. Use for thirds, and for vertical where type takes the bottom.
        """
        data = self.obj.data
        data.shift_x = -x
        data.shift_y = -y
        return self


def vertical_fill(a: Mapping[str, float], subject: tuple[float, float], lens: float, fill: float = 0.6, sensor: float = 36.0) -> float:
    """Distance for a subject in the render's aspect (vertical included): the framing helper used by Rig."""
    return curves.fit_distance(lens, subject[0], subject[1], a["width"], a["height"], fill, sensor)
