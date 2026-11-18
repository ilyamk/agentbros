"""Fixed local worker. Never loads code named by a handoff or invokes services."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol, cast, overload

MAX_SUPPORTED_FPS = 120


class ResolveTimeline(Protocol):
    """Native timeline methods used by the clone-only worker."""

    def GetUniqueId(self) -> str:
        """Return the native immutable identifier."""
        ...

    def GetName(self) -> str:
        """Return the native display name."""
        ...

    def Export(self, file: str, export_type: str) -> bool:
        """Export the timeline using the requested native format."""
        ...

    def DuplicateTimeline(self, name: str) -> ResolveTimeline:
        """Duplicate the timeline under the supplied name."""
        ...

    def GetSetting(self, name: str) -> str:
        """Read one native timeline setting."""
        ...

    def GetTrackCount(self, kind: str) -> int:
        """Return the number of tracks of this kind."""
        ...

    def SetIsTrackLocked(self, kind: str, index: int, locked: bool) -> bool:
        """Set the lock state of one track."""
        ...

    def SetIsTrackEnabled(self, kind: str, index: int, enabled: bool) -> bool:
        """Set the enabled state of one track."""
        ...

    def GetIsTrackEnabled(self, kind: str, index: int) -> bool:
        """Read the enabled state of one track."""
        ...

    def GetItemListInTrack(self, kind: str, index: int) -> list[ResolveItem]:
        """Return the items in one track."""
        ...

    def DeleteClips(self, clips: list[ResolveItem], ripple: bool) -> bool:
        """Delete the supplied clone items with explicit ripple behaviour."""
        ...

    def AddTrack(self, kind: str, subtype: str = "") -> bool:
        """Add a track with the requested subtype."""
        ...

    def GetStartFrame(self) -> int:
        """Return the timeline start frame."""
        ...


class ResolveItem(Protocol):
    """Readback methods required from a native timeline item."""

    def GetName(self) -> str:
        """Return the native display name."""
        ...

    def GetUniqueId(self) -> str:
        """Return the native immutable identifier."""
        ...

    def GetMediaPoolItem(self) -> ResolveMedia:
        """Return the source media associated with the item."""
        ...

    def GetStart(self) -> int:
        """Return the item start frame."""
        ...

    def GetEnd(self) -> int:
        """Return the item end frame."""
        ...

    def GetDuration(self) -> int:
        """Return the item duration in frames."""
        ...

    def GetLeftOffset(self) -> int:
        """Return the trimmed source offset."""
        ...

    def GetSourceStartFrame(self) -> int:
        """Return the first included source frame."""
        ...

    def GetSourceEndFrame(self) -> int:
        """Return the last included source frame."""
        ...

    def GetFusionCompCount(self) -> int:
        """Return the number of attached Fusion compositions."""
        ...

    def GetProperty(self) -> Params:
        """Read the native item properties."""
        ...


class ResolveMedia(Protocol):
    """Native media identity used for immutable clone readback."""

    def GetMediaId(self) -> str:
        """Return the source media identifier."""
        ...

    @overload
    def GetClipProperty(self) -> dict[str, str]: ...

    @overload
    def GetClipProperty(self, name: str) -> str: ...


Params = dict[str, Any]


def sha(data: bytes) -> str:
    """Return the SHA-256 identity of the supplied bytes."""
    return hashlib.sha256(data).hexdigest()


def integer(value: object) -> int:
    """Validate and convert an integral rational frame."""
    if not isinstance(value, dict) or set(value) != {"num", "den"}:
        error_message = "Expected rational frame"
        raise ValueError(error_message)
    frame = cast("dict[str, object]", value)
    num, den = frame["num"], frame["den"]
    if isinstance(num, bool) or not isinstance(num, int) or isinstance(den, bool) or not isinstance(den, int) or den <= 0 or num % den:
        error_message = "Resolve subset requires integral frames and integer FPS"
        raise ValueError(error_message)
    return num // den


def rational(value: object) -> dict[str, int]:
    """Convert an integral SDK frame to the rational wire format."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        error_message = "Resolve returned fractional/invalid frame"
        raise ValueError(error_message)
    return {"num": int(value), "den": 1}


def atomic_new(file: Path, value: object) -> None:
    """Publish an immutable receipt without replacing different content."""
    data = json.dumps(value, sort_keys=True).encode()
    if file.exists():
        if file.read_bytes() != data:
            error_message = "Immutable worker receipt already differs"
            raise ValueError(error_message)
        return
    descriptor, temporary = tempfile.mkstemp(prefix=".resolve-receipt-", dir=file.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, file)  # Atomic publication, never overwrite an acknowledgement.
    finally:
        Path(temporary).unlink()


class Worker:
    """Validate a handoff and operate only on an explicit Resolve clone."""

    def __init__(self, request: Params) -> None:
        """Validate the handoff before connecting to the optional native SDK."""
        self.root = Path(request["directory"]).resolve(strict=True)
        self.manifest = json.loads(self.checked("handoff.json").read_text())
        if sha(self.checked("handoff.json").read_bytes()) != self.checked("handoff.sha256").read_text():
            error_message = "Handoff checksum changed"
            raise ValueError(error_message)
        self.expected = self.manifest["expected"]
        self.assets = {v["assetId"]: v for v in self.manifest["originals"]}
        for item in self.manifest["exports"]:
            if sha(self.checked(item["name"]).read_bytes()) != item["sha256"]:
                error_message = "Export checksum changed"
                raise ValueError(error_message)
        for item in self.assets.values():
            if sha(Path(item["path"]).read_bytes()) != item["sha256"]:
                error_message = "Original media checksum changed"
                raise ValueError(error_message)
        self.preflight()
        import DaVinciResolveScript  # noqa: PLC0415 -- Pure validators also run without the optional SDK.

        self.resolve = DaVinciResolveScript.scriptapp("Resolve")
        if not self.resolve:
            error_message = "Resolve scripting connection unavailable"
            raise RuntimeError(error_message)
        self.project = self.resolve.GetProjectManager().GetCurrentProject()
        if not self.project:
            error_message = "Open an owned synthetic/project timeline in Resolve first"
            raise RuntimeError(error_message)
        self.pool = self.project.GetMediaPool()

    def checked(self, name: str) -> Path:
        """Read a handoff file after verifying its pinned identity."""
        file = (self.root / name).resolve()
        if not file.is_relative_to(self.root):
            error_message = "Handoff path escapes directory"
            raise ValueError(error_message)
        return file

    def preflight(self) -> None:  # noqa: C901, PLR0912, PLR0915 -- Keep the ordered validation or native transaction together. Each branch validates one supported contract variant. Ordered native mutations and their validation form one operation.
        """Validate the handoff subset before calling the Resolve SDK."""
        self.fps = integer(self.expected["timebase"])
        if self.fps < 1 or self.fps > MAX_SUPPORTED_FPS:
            error_message = "Unsupported FPS"
            raise ValueError(error_message)
        integer(self.expected["duration"])
        otio = json.loads(self.checked("timeline.otio").read_text())
        ir = otio["metadata"]["aiVideoCreator"]["exactIR"]

        def reject_effects(node: object) -> None:
            if isinstance(node, dict):
                if cast("dict[str, object]", node).get("effects"):
                    error_message = "Bake OTIO effects before Resolve handoff"
                    raise ValueError(error_message)
                for value in node.values():
                    reject_effects(value)
            elif isinstance(node, list):
                for value in node:
                    reject_effects(value)

        reject_effects(otio)
        for track in ir["tracks"]:
            if track["kind"] == "captions":
                error_message = "Native caption import/readback unsupported; use reviewed sidecars separately"
                raise ValueError(error_message)
            for clip in track["clips"]:
                if clip["transition"]["kind"] != "cut" or clip.get("payload"):
                    error_message = "Bake transition/layout/automation before Resolve handoff"
                    raise ValueError(error_message)
        for track in self.expected["tracks"]:
            if track["kind"] not in ("visual", "presenter", "voiceover", "music", "sfx"):
                error_message = "Unsupported Resolve track kind"
                raise ValueError(error_message)
            for clip in track["clips"]:
                start, end = integer(clip["start"]), integer(clip["end"])
                source_start, source_end = integer(clip["source"]["start"]), integer(clip["source"]["end"])
                if clip["rate"] != {"num": 1, "den": 1} or integer(clip["source"]["timebase"]) != self.fps:
                    error_message = "Bake retiming/source-FPS conversion before Resolve handoff"
                    raise ValueError(error_message)
                if start < 0 or source_start < 0 or end <= start or source_end - source_start != end - start:
                    error_message = "Invalid source/output interval"
                    raise ValueError(error_message)
                if clip.get("captions"):
                    error_message = "Native caption verification unsupported; use sidecars separately"
                    raise ValueError(error_message)
                if clip["assetId"] not in self.assets:
                    error_message = "Unknown native media binding"
                    raise ValueError(error_message)
        for asset_id, asset in self.assets.items():
            probe = subprocess.run(  # noqa: S603 -- Arguments are a literal vector; the worker never invokes a shell.
                ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,r_frame_rate,avg_frame_rate:format=duration", "-of", "json", asset["path"]],  # noqa: S607 -- Fixed local media tool resolved through the caller environment.
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            )
            media = json.loads(probe.stdout)
            video = [stream for stream in media.get("streams", []) if stream["codec_type"] == "video"]
            audio_only = all(track["kind"] in ("voiceover", "music", "sfx") for track in self.expected["tracks"] if any(clip["assetId"] == asset_id for clip in track["clips"]))
            if video:
                if Fraction(video[0]["r_frame_rate"]) != self.fps or Fraction(video[0]["avg_frame_rate"]) != self.fps:
                    error_message = "Actual local video FPS mismatch; normalize/bake before cloning"
                    raise ValueError(error_message)
            elif not audio_only or not any(stream["codec_type"] == "audio" for stream in media.get("streams", [])):
                error_message = "Resolve subset requires actual baked video/audio media"
                raise ValueError(error_message)
            duration = Fraction(media.get("format", {}).get("duration", "0")) * self.fps
            for track in self.expected["tracks"]:
                for clip in track["clips"]:
                    if clip["assetId"] == asset_id and integer(clip["source"]["end"]) > duration:
                        error_message = "Actual local source trim exceeds media duration"
                        raise ValueError(error_message)

    def timeline(self, timeline_id: str) -> ResolveTimeline:
        """Find a timeline by its immutable native identifier."""
        for index in range(1, self.project.GetTimelineCount() + 1):
            timeline = self.project.GetTimelineByIndex(index)
            if timeline.GetUniqueId() == timeline_id:
                return timeline
        error_message = "Timeline ID not found in current project"
        raise ValueError(error_message)

    def fingerprint(self, timeline: ResolveTimeline) -> str:
        # DRT includes grading/Fusion/timeline state rather than only clip geometry.
        """Hash a timeline export for drift detection."""
        with tempfile.TemporaryDirectory(prefix="resolve-fingerprint-") as temp:
            file = Path(temp) / "timeline.drt"
            if not timeline.Export(str(file), self.resolve.EXPORT_DRT) or not file.is_file():
                error_message = "Native DRT fingerprint export unavailable"
                raise RuntimeError(error_message)
            if zipfile.is_zipfile(file):
                with zipfile.ZipFile(file) as archive:
                    entries = [(name, sha(archive.read(name))) for name in sorted(archive.namelist())]
                return sha(json.dumps(entries, separators=(",", ":")).encode())
            return sha(file.read_bytes())

    def binding(self, timeline_id: str) -> Params:
        """Return the exact project and timeline binding."""
        binding = json.loads(self.checked("resolve-worker-clone.json").read_text())
        if (
            binding["cloneId"] != timeline_id
            or timeline_id == self.manifest["originalTimelineId"]
            or binding["handoffId"] != self.manifest["handoffId"]
            or binding["projectId"] != self.project.GetUniqueId()
        ):
            error_message = "Clone binding does not match this project/handoff"
            raise ValueError(error_message)
        if self.timeline(timeline_id).GetName() != self.manifest["cloneName"]:
            error_message = "Native clone name differs from immutable handoff"
            raise ValueError(error_message)
        return binding

    def probe(self) -> Params:
        """Report the installed SDK capabilities without mutating the project."""
        version = self.resolve.GetVersionString()
        # Source frame getters used for independent readback require this subset.
        original = self.timeline(self.manifest["originalTimelineId"])
        supported = bool(re.match(r"^20\.(?:[2-9]|[1-9][0-9]+)(?:\.|$)", version)) and hasattr(original, "DuplicateTimeline") and hasattr(self.resolve, "EXPORT_DRT")
        return {
            "backend": "resolve",
            "available": supported,
            "version": version,
            "capabilities": ["clone", "import-into-clone", "readback", "original-fingerprint"] if supported else [],
            "liveVerified": False,
            "reason": "Native worker connected; handoff still needs measured clone readback",
        }

    def clone(self, timeline_id: str, name: str) -> dict[str, str]:
        """Duplicate the bound timeline for isolated changes."""
        if timeline_id != self.manifest["originalTimelineId"] or name != self.manifest["cloneName"]:
            error_message = "Clone request differs from verified manifest"
            raise ValueError(error_message)
        for index in range(1, self.project.GetTimelineCount() + 1):
            if self.project.GetTimelineByIndex(index).GetName() == name:
                error_message = "Clone name already exists: reconcile, never duplicate again"
                raise ValueError(error_message)
        clone = self.timeline(timeline_id).DuplicateTimeline(name)
        if not clone or clone.GetUniqueId() == timeline_id:
            error_message = "DuplicateTimeline failed"
            raise RuntimeError(error_message)
        binding = {"cloneId": clone.GetUniqueId(), "handoffId": self.manifest["handoffId"], "projectId": self.project.GetUniqueId()}
        atomic_new(self.checked("resolve-worker-clone.json"), binding)
        return {"timelineId": clone.GetUniqueId()}

    def import_clone(self, timeline_id: str, file: str) -> dict[str, bool]:  # noqa: C901, PLR0912, PLR0915 -- Keep the ordered validation or native transaction together. Each branch validates one supported contract variant. Ordered native mutations and their validation form one operation.
        """Import the reviewed timeline into the designated clone."""
        if Path(file).resolve() != self.checked("timeline.fcpxml"):
            error_message = "Only verified export path accepted"
            raise ValueError(error_message)
        self.binding(timeline_id)
        clone = self.timeline(timeline_id)
        if float(clone.GetSetting("timelineFrameRate")) != self.fps:
            error_message = "Clone FPS mismatch; no clips modified"
            raise ValueError(error_message)
        # Select only the proven clone, restore previous selection even on errors.
        previous = self.project.GetCurrentTimeline()
        if not self.project.SetCurrentTimeline(clone):
            error_message = "Could not select isolated clone"
            raise RuntimeError(error_message)
        try:
            dispatch = self.checked("resolve-worker-import-dispatch.json")
            if dispatch.exists():
                error_message = "Import already dispatched: readback/reconcile; never replay"
                raise ValueError(error_message)
            atomic_new(dispatch, {"cloneId": timeline_id, "handoffId": self.manifest["handoffId"]})
            imported = {}
            for asset_id, asset in self.assets.items():
                items = self.pool.ImportMedia([asset["path"]])
                if not items or len(items) != 1:
                    error_message = "ImportMedia failed/ambiguous"
                    raise RuntimeError(error_message)
                media = items[0]
                audio_only = all(track["kind"] in ("voiceover", "music", "sfx") for track in self.expected["tracks"] if any(clip["assetId"] == asset_id for clip in track["clips"]))
                source_fps = media.GetClipProperty("FPS")
                if audio_only and source_fps in (None, "", "0"):
                    source_fps = self.fps  # Audio source frame getters use the timeline frame basis.
                if Path(media.GetClipProperty("File Path")).resolve() != Path(asset["path"]).resolve() or float(source_fps) != self.fps:
                    error_message = "Imported source path/FPS mismatch; original timeline untouched"
                    raise ValueError(error_message)
                imported[asset_id] = media
            for kind in ("video", "audio", "subtitle"):
                for index in range(1, clone.GetTrackCount(kind) + 1):
                    if not clone.SetIsTrackLocked(kind, index, False) or not clone.SetIsTrackEnabled(kind, index, True):
                        error_message = "Could not enable/unlock clone-only track"
                        raise RuntimeError(error_message)
                    items = clone.GetItemListInTrack(kind, index) or []
                    if items and not clone.DeleteClips(items, False):
                        error_message = "Clone-only DeleteClips failed"
                        raise RuntimeError(error_message)
            lanes = {"video": 0, "audio": 0}
            mapping = []
            for track in self.expected["tracks"]:
                kind = "audio" if track["kind"] in ("voiceover", "music", "sfx") else "video"
                lanes[kind] += 1
                index = lanes[kind]
                while clone.GetTrackCount(kind) < index:
                    if not clone.AddTrack(kind):
                        error_message = "AddTrack failed"
                        raise RuntimeError(error_message)
                for clip in track["clips"]:
                    info = {
                        "mediaPoolItem": imported[clip["assetId"]],
                        "startFrame": integer(clip["source"]["start"]),
                        "endFrame": integer(clip["source"]["end"]) - 1,
                        "mediaType": 2 if kind == "audio" else 1,
                        "trackIndex": index,
                        "recordFrame": clone.GetStartFrame() + integer(clip["start"]),
                    }
                    items = self.pool.AppendToTimeline([info])
                    if not items or len(items) != 1:
                        error_message = "AppendToTimeline failed/ambiguous"
                        raise RuntimeError(error_message)
                    mapping.append({"trackId": track["id"], "kind": kind, "index": index, "clipId": clip["id"], "itemId": items[0].GetUniqueId(), "nativeProperties": items[0].GetProperty()})
            atomic_new(self.checked("resolve-worker-import-result.json"), {"cloneId": timeline_id, "mapping": mapping})
        finally:
            if previous:
                self.project.SetCurrentTimeline(previous)
        return {"imported": True}

    def readback(self, timeline_id: str) -> Params:  # noqa: C901, PLR0912 -- Keep the ordered validation or native transaction together. Each branch validates one supported contract variant.
        """Read native timeline state for comparison with the planned edit."""
        self.binding(timeline_id)
        timeline = self.timeline(timeline_id)
        receipt = json.loads(self.checked("resolve-worker-import-result.json").read_text())
        actual = {}
        for kind in ("video", "audio", "subtitle"):
            for index in range(1, timeline.GetTrackCount(kind) + 1):
                for item in timeline.GetItemListInTrack(kind, index) or []:
                    actual[item.GetUniqueId()] = (kind, index, item)
        if set(actual) != {v["itemId"] for v in receipt["mapping"]}:
            error_message = "Clone contains missing/extra native items"
            raise ValueError(error_message)
        tracks = []
        for expected_track in self.expected["tracks"]:
            clips = []
            for expected in expected_track["clips"]:
                matches = [v for v in receipt["mapping"] if v["trackId"] == expected_track["id"] and v["clipId"] == expected["id"]]
                if len(matches) != 1:
                    error_message = "Ambiguous native item binding"
                    raise ValueError(error_message)
                binding = matches[0]
                kind, index, item = actual[binding["itemId"]]
                if (kind, index) != (binding["kind"], binding["index"]):
                    error_message = "Native item moved to different track"
                    raise ValueError(error_message)
                if not timeline.GetIsTrackEnabled(kind, index):
                    error_message = "Native track disabled"
                    raise ValueError(error_message)
                media = item.GetMediaPoolItem()
                source_fps = media.GetClipProperty("FPS")
                if kind == "audio" and source_fps in (None, "", "0"):
                    source_fps = timeline.GetSetting("timelineFrameRate")
                if Path(media.GetClipProperty("File Path")).resolve() != Path(self.assets[expected["assetId"]]["path"]).resolve():
                    error_message = "Native source replacement detected"
                    raise ValueError(error_message)
                start, end = item.GetStart() - timeline.GetStartFrame(), item.GetEnd() - timeline.GetStartFrame()
                source_start, source_end = item.GetSourceStartFrame(), item.GetSourceEndFrame() + 1
                duration = end - start
                if not duration or source_end - source_start != duration:
                    error_message = "Native retiming detected outside supported rate1 subset"
                    raise ValueError(error_message)
                if item.GetFusionCompCount() or item.GetProperty() != binding["nativeProperties"] or item.GetProperty().get("ZoomX", 1) != 1 or item.GetProperty().get("ZoomY", 1) != 1:
                    error_message = "Unrepresented native Fusion/transform effects detected"
                    raise ValueError(error_message)
                clips.append(
                    {
                        "id": expected["id"],
                        "assetId": expected["assetId"],
                        "start": rational(start),
                        "end": rational(end),
                        "source": {"start": rational(source_start), "end": rational(source_end), "timebase": rational(float(source_fps))},
                        "rate": {"num": 1, "den": 1},
                        "captions": [],
                    }
                )
            tracks.append({"id": expected_track["id"], "kind": expected_track["kind"], "clips": clips})
        return {
            "version": 1,
            "projectId": self.expected["projectId"],
            "timebase": rational(float(timeline.GetSetting("timelineFrameRate"))),
            "duration": rational(max([timeline.GetStartFrame()] + [item.GetEnd() for _, _, item in actual.values()]) - timeline.GetStartFrame()),
            "tracks": tracks,
        }


def main() -> Params:
    """Run the fixed worker operation selected by its owning command."""
    request = json.load(sys.stdin)
    action = request["action"]
    if action not in ("probe", "fingerprint", "clone", "import", "readback"):
        error_message = "Unsupported fixed worker action"
        raise ValueError(error_message)
    worker = Worker(request)
    if action != "probe" and not worker.probe()["available"]:
        error_message = "Unsupported Resolve version/method subset"
        raise ValueError(error_message)
    if action == "probe":
        return worker.probe()
    if action == "fingerprint":
        return {"fingerprint": worker.fingerprint(worker.timeline(request["timelineId"]))}
    if action == "clone":
        return worker.clone(request["timelineId"], request["cloneName"])
    if action == "import":
        return worker.import_clone(request["timelineId"], request["exportFile"])
    return worker.readback(request["timelineId"])


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = main()
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))  # noqa: T201 -- The owning Node caller consumes this worker output.
    except Exception as error:  # noqa: BLE001 -- The subprocess boundary serialises every failure for its caller.
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": str(error)}, separators=(",", ":")))  # noqa: T201 -- The owning Node caller consumes this worker output.
        sys.exit(1)
