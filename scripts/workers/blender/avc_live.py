# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Blender live-session server, started by scripts/blender-live.ts. Never run it by hand.

Binds 127.0.0.1 on an OS-assigned port and answers one authenticated JSON request per connection
(avc_live_protocol). Scene changes go through avc_live_ops and are journaled, so `export` can hand the
scene to blender:run as a recipe. The token comes from AGENTBROS_LIVE_TOKEN and is removed from the environment
before any kit script runs. The server exits after `idleSec` without an authenticated request.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import traceback
from pathlib import Path
from typing import TypeAlias

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(os.path.abspath(__file__)).parent))  # noqa: PTH100 -- Retain lexical absolute paths without resolving symlinks here.

from typing import Any  # noqa: E402 -- Native module paths are established before these imports.

import bpy  # noqa: E402 -- Native module paths are established before these imports.

import avc_live_ops as ops  # noqa: E402 -- Native module paths are established before these imports.
from avc_live_protocol import PROTOCOL, LiveError, check_name, contained, encode_response, parse_request, read_line  # noqa: E402 -- Native module paths are established before these imports.

MAX_FRAME = 100000
MAX_RENDER_DIMENSION = 7680
MAX_RENDER_PERCENTAGE = 100
MAX_RENDER_SAMPLES = 4096
MAX_STRIP_FRAMES = 24
MIN_FRAME = -100000
MIN_RENDER_DIMENSION = 16
MIN_STRIP_FRAMES = 2
MIN_TOKEN_BYTES = 32

Params: TypeAlias = dict[str, Any]


# Dynamic Blender/operator dictionaries are validated by their owning request schemas.

STILL_KEYS = ("frame", "name", "samples", "width", "height", "percentage", "engine", "device")


class Session:
    """Own one authenticated Blender session and its reversible render settings."""

    def __init__(self, config: Params, token: str) -> None:
        """Own the scene configuration, authentication token and replay journal."""
        self.config = config
        self.token = token
        self.journal = []
        self.base = config["base"]
        self.renders = 0
        self.last_still = None
        self.last_request = time.monotonic()
        self.stopping = False
        self.context = {"kitDir": config["kitDir"], "workspaceRoot": config["workspaceRoot"], "project": config.get("project"), "extensionsProfile": config.get("extensionsProfile", False)}
        for extension in config.get("extensions", []):
            self.journal.append(ops.arsenal.prepare_step("enable-extension", {"id": extension["id"]}, self.context))
        self.persist()

    # ---------- request handling ----------

    def handle(self, op: str, params: Params) -> Params:  # noqa: C901, PLR0911 -- Keep the ordered validation or native transaction together. Each supported contract variant returns its own result.
        """Dispatch one authenticated typed live operation."""
        if op == "arsenal":
            return ops.arsenal.arsenal(params)
        if op == "ping":
            return {
                "protocol": PROTOCOL,
                "blenderVersion": bpy.app.version_string,
                "pid": os.getpid(),
                "session": self.config["sessionId"],
                "journal": len(self.journal),
                "onlineAccess": bpy.app.online_access,
            }
        if op == "inspect":
            return {**ops.inspect(), "journal": len(self.journal), "base": self.base}
        if op == "journal":
            return {**self.recipe(), "lastStill": self.last_still}
        if op == "reset":
            ops.reset_empty()
            self.base = {"kind": "empty"}
            self.journal = [step for step in self.journal if step["op"] == "enable-extension"]
            return {"reset": True, "journalFile": self.persist()}
        if op in ops.JOURNALED:
            ops.validate_recipe(self.recipe(), self.context)
            step = ops.arsenal.prepare_step(op, params, self.context)
            try:
                result = ops.apply_step(step, self.context)
            except Exception:
                # A failed op may have changed part of the scene (a kit resets it first). Rebuild from the
                # journal, so the scene stays exactly what the recipe replays and the failure changes nothing.
                ops.apply_recipe(self.recipe(), self.context)
                raise
            if op == "run-kit":
                # A kit script starts from the empty base, so earlier edits no longer apply.
                self.base = {"kind": "empty"}
                self.journal = [step for step in self.journal if step["op"] == "enable-extension"]
            self.journal.append(step)
            return {**result, "journal": len(self.journal), "journalFile": self.persist()}
        if op == "still":
            return self.still(params)
        if op == "strip":
            return self.strip(params)
        if op == "save":
            return self.save(params)
        if op == "shutdown":
            self.stopping = True
            return {"stopping": True}
        error_message = f"Unknown op {op!r}."
        raise LiveError("INVALID_INPUT", error_message)

    def recipe(self) -> Params:
        """Serialise the current session base and journal for replay."""
        return {"version": ops.RECIPE_VERSION, "blenderVersion": bpy.app.version_string, "base": self.base, "ops": self.journal}

    def persist(self) -> str:
        """Writes the journal after every change, so an idle exit or a crash loses nothing: it replays like an export."""
        path = str(Path(self.config["outDir"]).joinpath("journal.live.json"))
        temporary = path + ".tmp"
        with Path(temporary).open("w", encoding="utf8") as handle:
            json.dump(self.recipe(), handle, indent=2)
        Path(temporary).replace(path)
        return path

    # ---------- renders: temporary overrides, restored afterwards, so they never enter the journal ----------

    def _render_settings(self, params: Params) -> Params:  # noqa: C901, PLR0912, PLR0915 -- Keep the ordered validation or native transaction together. Each branch validates one supported contract variant. Ordered native mutations and their validation form one operation.
        scene = bpy.context.scene
        if scene.camera is None:
            error_message = "The scene has no active camera; add one (add kind camera) or set scene.camera."
            raise LiveError("VALIDATION", error_message)
        render = scene.render
        saved = {
            "engine": render.engine,
            "x": render.resolution_x,
            "y": render.resolution_y,
            "pct": render.resolution_percentage,
            "samples": scene.cycles.samples,
            "eeveeSamples": scene.eevee.taa_render_samples if hasattr(scene, "eevee") else None,
            "device": scene.cycles.device,
            "filepath": render.filepath,
            "format": render.image_settings.file_format,
            "frame": scene.frame_current,
            "dither": render.dither_intensity,
            "compositorDevice": getattr(render, "compositor_device", None),
            "denoisingGpu": getattr(scene.cycles, "denoising_use_gpu", None),
        }
        engine = params.get("engine")
        if engine not in (None, "cycles", "eevee"):
            error_message = "engine must be cycles or eevee."
            raise LiveError("INVALID_INPUT", error_message)
        if engine == "cycles":
            render.engine = "CYCLES"
        elif engine == "eevee":
            try:
                render.engine = "BLENDER_EEVEE"  # Blender 5.x
            except TypeError:
                render.engine = "BLENDER_EEVEE_NEXT"  # Blender 4.2-4.x
        width, height = params.get("width"), params.get("height")
        if (width is None) != (height is None):
            error_message = "Give width and height together."
            raise LiveError("INVALID_INPUT", error_message)
        if width is not None:
            for value in (width, height):
                if isinstance(value, bool) or not isinstance(value, int) or not MIN_RENDER_DIMENSION <= value <= MAX_RENDER_DIMENSION:
                    error_message = "width and height must be whole numbers from 16 to 7680."
                    raise LiveError("INVALID_INPUT", error_message)
            render.resolution_x, render.resolution_y = width, height
        percentage = params.get("percentage")
        if percentage is not None:
            if isinstance(percentage, bool) or not isinstance(percentage, int) or not 1 <= percentage <= MAX_RENDER_PERCENTAGE:
                error_message = "percentage must be a whole number from 1 to 100."
                raise LiveError("INVALID_INPUT", error_message)
            render.resolution_percentage = percentage
        samples = params.get("samples")
        if samples is not None:
            if isinstance(samples, bool) or not isinstance(samples, int) or not 1 <= samples <= MAX_RENDER_SAMPLES:
                error_message = "samples must be a whole number from 1 to 4096."
                raise LiveError("INVALID_INPUT", error_message)
            scene.cycles.samples = samples
            if hasattr(scene, "eevee"):
                scene.eevee.taa_render_samples = samples
        device = params.get("device", "cpu")
        if device not in ("cpu", "gpu"):
            error_message = "device must be cpu or gpu."
            raise LiveError("INVALID_INPUT", error_message)
        scene.cycles.device = "CPU" if device == "cpu" else "GPU"
        if device == "cpu":
            render.dither_intensity = 0
            if hasattr(render, "compositor_device"):
                render.compositor_device = "CPU"
            if hasattr(scene.cycles, "denoising_use_gpu"):
                scene.cycles.denoising_use_gpu = False
        render.image_settings.file_format = "PNG"
        return saved

    @staticmethod
    def _restore(saved: Params) -> None:
        scene = bpy.context.scene
        render = scene.render
        render.engine = saved["engine"]
        render.resolution_x, render.resolution_y, render.resolution_percentage = saved["x"], saved["y"], saved["pct"]
        scene.cycles.samples, scene.cycles.device = saved["samples"], saved["device"]
        if saved["eeveeSamples"] is not None:
            scene.eevee.taa_render_samples = saved["eeveeSamples"]
        render.filepath, render.image_settings.file_format = saved["filepath"], saved["format"]
        render.dither_intensity = saved["dither"]
        if saved["compositorDevice"] is not None:
            render.compositor_device = saved["compositorDevice"]
        if saved["denoisingGpu"] is not None:
            scene.cycles.denoising_use_gpu = saved["denoisingGpu"]
        scene.frame_set(saved["frame"])

    def _frame(self, value: object, what: str = "frame") -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not MIN_FRAME <= value <= MAX_FRAME:
            error_message = f"{what} must be a whole number."
            raise LiveError("INVALID_INPUT", error_message)
        return value

    def _render_to(self, path: str, frame: float) -> float:
        scene = bpy.context.scene
        scene.frame_set(frame)
        scene.render.filepath = path
        started = time.monotonic()
        bpy.ops.render.render(write_still=True)
        if not Path(path).is_file():
            error_message = f"Blender did not write {path}."
            raise LiveError("INTERNAL", error_message)
        return round(time.monotonic() - started, 2)

    def still(self, params: Params) -> Params:
        """Render one still while restoring the previous scene settings."""
        ops.only(params, STILL_KEYS, "still")
        name = check_name(params.get("name", "still"))
        frame = self._frame(params.get("frame", bpy.context.scene.frame_current))
        saved = self._render_settings(params)
        try:
            self.renders += 1
            directory = str(Path(self.config["outDir"]).joinpath("stills"))
            Path(directory).mkdir(parents=True, exist_ok=True)
            path = contained(self.config["outDir"], str(Path(directory).joinpath(f"{self.renders:03d}-{name}-f{frame:06d}.png")))
            seconds = self._render_to(path, frame)
            render = bpy.context.scene.render
            size = [round(render.resolution_x * render.resolution_percentage / 100), round(render.resolution_y * render.resolution_percentage / 100)]
            scene = bpy.context.scene
            samples = scene.cycles.samples if render.engine == "CYCLES" else getattr(getattr(scene, "eevee", None), "taa_render_samples", None)
            self.last_still = {"frame": frame, "width": size[0], "height": size[1], "samples": samples, "engine": "cycles" if render.engine == "CYCLES" else "eevee"}
            return {"path": path, "frame": frame, "size": size, "engine": render.engine, "samples": samples, "seconds": seconds}
        finally:
            self._restore(saved)

    def strip(self, params: Params) -> Params:
        """Render a bounded sequence of review frames."""
        ops.only(params, (*STILL_KEYS, "frames", "count"), "strip")
        name = check_name(params.get("name", "strip"))
        scene = bpy.context.scene
        span = params.get("frames", [scene.frame_start, scene.frame_end])
        if not isinstance(span, list) or len(span) != MIN_STRIP_FRAMES:
            error_message = "frames must be [first, last]."
            raise LiveError("INVALID_INPUT", error_message)
        first, last = self._frame(span[0], "frames[0]"), self._frame(span[1], "frames[1]")
        count = params.get("count", 6)
        if isinstance(count, bool) or not isinstance(count, int) or not MIN_STRIP_FRAMES <= count <= MAX_STRIP_FRAMES or last < first:
            error_message = "count must be 2 to 24 and frames ascending."
            raise LiveError("INVALID_INPUT", error_message)
        frames = sorted({round(first + (last - first) * i / (count - 1)) for i in range(count)})
        saved = self._render_settings(params)
        try:
            self.renders += 1
            directory = contained(self.config["outDir"], str(Path(self.config["outDir"]).joinpath("strips", f"{self.renders:03d}-{name}")))
            Path(directory).mkdir(parents=True, exist_ok=True)
            items = []
            for frame in frames:
                path = str(Path(directory).joinpath(f"f{frame:06d}.png"))
                items.append({"frame": frame, "path": path, "seconds": self._render_to(path, frame)})
            render = scene.render
            size = [round(render.resolution_x * render.resolution_percentage / 100), round(render.resolution_y * render.resolution_percentage / 100)]
            return {"directory": directory, "frames": items, "size": size, "engine": render.engine}
        finally:
            self._restore(saved)

    def save(self, params: Params) -> Params:
        """Writes a copy of the scene as a .blend to a path the CLI computed inside an allowed root."""
        ops.only(params, ("path",), "save")
        path = params.get("path")
        if not isinstance(path, str) or not path.endswith(".blend"):
            error_message = "path must end with .blend."
            raise LiveError("INVALID_INPUT", error_message)
        roots = [root for root in (self.config["outDir"], self.config.get("assetsDir")) if root]
        allowed = None
        for root in roots:
            try:
                allowed = contained(root, path)
                break
            except LiveError:
                continue
        if allowed is None:
            error_message = "save path must be inside the session's output or the project's assets/blender folder."
            raise LiveError("VALIDATION", error_message)
        Path(str(Path(allowed).parent)).mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=allowed, copy=True, compress=True, relative_remap=True)
        return {"path": allowed}

    # ---------- transport ----------

    def serve_connection(self, conn: socket.socket) -> None:
        """Read, authenticate and answer one bounded connection."""
        conn.settimeout(10)
        try:
            try:
                line = read_line(conn.recv)
                op, params = parse_request(line, self.token)
                self.last_request = time.monotonic()
                payload = encode_response(True, self.handle(op, params))
            except LiveError as error:
                payload = encode_response(False, {"code": error.code, "message": error.message})
            except Exception as error:  # noqa: BLE001 - every failure must reach the caller as one response line
                traceback.print_exc()
                payload = encode_response(False, {"code": "INTERNAL", "message": f"{type(error).__name__}: {error}"})
            conn.settimeout(30)
            conn.sendall(payload)
        except OSError:
            traceback.print_exc()
        finally:
            conn.close()


def load_config() -> tuple[Params, str]:
    """Read session configuration and consume its authentication token."""
    with Path(os.environ["AGENTBROS_LIVE_CONFIG"]).open(encoding="utf8") as handle:
        config = json.load(handle)
    token = os.environ.pop("AGENTBROS_LIVE_TOKEN", "")
    if len(token) < MIN_TOKEN_BYTES:
        error_message = "AGENTBROS_LIVE_TOKEN is missing or too short."
        raise RuntimeError(error_message)
    return config, token


def prepare_scene(config: Params) -> None:
    """Initialise the session scene and permitted extensions."""
    base = config["base"]
    if base["kind"] == "empty":
        ops.reset_empty()
    if config.get("extensions"):
        import avc_extensions

        avc_extensions.enable([item["id"] for item in config["extensions"]], {item["id"]: item["version"] for item in config["extensions"]})
    if base["kind"] == "blend":
        ops.open_blend(base["absolutePath"])
    # Kit scripts that export a camera write beside the session's renders, never to the working directory.
    request = str(Path(config["sessionDir"]).joinpath("kit-request.json"))
    with Path(request).open("w", encoding="utf8") as handle:
        json.dump({"output": str(Path(config["outDir"]).joinpath("kit"))}, handle)
    os.environ["AGENTBROS_BLENDER_REQUEST"] = request
    config["base"] = {key: value for key, value in base.items() if key != "absolutePath"}


def listen() -> socket.socket:
    """Bind the loopback listener on an operating-system assigned port."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    return listener


def write_ready(config: Params, port: int) -> None:
    """Publish the assigned port in the session readiness file."""
    ready = str(Path(config["sessionDir"]).joinpath("ready.json"))
    temporary = ready + ".tmp"
    with Path(temporary).open("w", encoding="utf8") as handle:
        json.dump({"port": port, "pid": os.getpid(), "blenderVersion": bpy.app.version_string, "protocol": PROTOCOL}, handle)
    Path(temporary).replace(ready)


def serve_blocking(session: Session, listener: socket.socket) -> None:
    """Serve authenticated calls until shutdown or inactivity."""
    listener.settimeout(1.0)
    idle = session.config["idleSec"]
    while not session.stopping:
        if time.monotonic() - session.last_request > idle:
            print(f"AGENTBROS_LIVE idle for {idle}s; exiting", flush=True)  # noqa: T201 -- The owning Node caller consumes this worker output.
            break
        try:
            conn, _address = listener.accept()
        except TimeoutError:
            continue
        session.serve_connection(conn)
    listener.close()


def serve_timer(session: Session, listener: socket.socket) -> None:
    """UI mode: poll from Blender's main-thread timer so the window stays responsive."""
    listener.setblocking(False)

    def tick() -> float | None:
        if session.stopping or time.monotonic() - session.last_request > session.config["idleSec"]:
            listener.close()
            if session.stopping:
                bpy.ops.wm.quit_blender()
            return None
        try:
            conn, _address = listener.accept()
        except (BlockingIOError, TimeoutError):
            return 0.1
        conn.setblocking(True)
        session.serve_connection(conn)
        return 0.01

    bpy.app.timers.register(tick, first_interval=0.1, persistent=True)


def main() -> None:
    """Run the fixed worker operation selected by its owning command."""
    config, token = load_config()
    prepare_scene(config)
    session = Session(config, token)
    listener = listen()
    write_ready(config, listener.getsockname()[1])
    print(f"AGENTBROS_LIVE listening on 127.0.0.1:{listener.getsockname()[1]}", flush=True)  # noqa: T201 -- The owning Node caller consumes this worker output.
    if bpy.app.background:
        serve_blocking(session, listener)
    else:
        serve_timer(session, listener)


main()
