"""Persistence-backed synthetic SDK: exercises native method arguments, no app claim."""

from __future__ import annotations

import copy
import json
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Sequence

Params = dict[str, Any]


file = Path(os.environ["RESOLVE_WORKER_FIXTURE"])
state = json.loads(file.read_text())
assert not any(key in os.environ for key in ("FAL_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"))


def save() -> None:
    file.write_text(json.dumps(state))


class Media:
    def __init__(self, source: str) -> None:
        self.source = source

    def GetClipProperty(self, key: str) -> str:
        return self.source if key == "File Path" else "" if self.source.endswith(".wav") else "30"


class Item:
    def __init__(self, data: Params) -> None:
        self.data = data

    def GetUniqueId(self) -> str:
        return self.data["id"]

    def GetMediaPoolItem(self) -> Media:
        return Media(self.data["source"])

    def GetStart(self) -> int:
        return self.data["recordFrame"]

    def GetEnd(self) -> int:
        return self.GetStart() + self.data["endFrame"] - self.data["startFrame"] + 1

    def GetSourceStartFrame(self) -> int:
        return self.data["startFrame"]

    def GetSourceEndFrame(self) -> int:
        return self.data["endFrame"]

    def GetFusionCompCount(self) -> int:
        return 0

    def GetProperty(self) -> dict[str, float]:
        return {"ZoomX": 1, "ZoomY": 1}


class Timeline:
    def __init__(self, timeline_id: str) -> None:
        self.id = timeline_id

    @property
    def data(self) -> Params:
        return state["timelines"][self.id]

    def GetUniqueId(self) -> str:
        return self.id

    def GetName(self) -> str:
        return self.data["name"]

    def GetSetting(self, key: str) -> str:  # noqa: ARG002 -- The fake deliberately implements the external SDK signature.
        return "30"

    def GetStartFrame(self) -> int:
        return 1000

    def GetEndFrame(self) -> int:
        return max([self.GetStartFrame()] + [Item(item).GetEnd() for item in self.data["items"]])

    def SetIsTrackLocked(self, kind: str, index: int, value: bool) -> bool:  # noqa: ARG002 -- The fake deliberately implements the external SDK signature.
        assert self.id != "original"
        assert value is False
        return True

    def SetIsTrackEnabled(self, kind: str, index: int, value: bool) -> bool:  # noqa: ARG002 -- The fake deliberately implements the external SDK signature.
        assert self.id != "original"
        assert value is True
        return True

    def GetIsTrackEnabled(self, kind: str, index: int) -> bool:  # noqa: ARG002 -- The fake deliberately implements the external SDK signature.
        return True

    def GetTrackCount(self, kind: str) -> int:
        return self.data["tracks"].get(kind, 0)

    def GetItemListInTrack(self, kind: str, index: int) -> list[Item]:
        return [Item(item) for item in self.data["items"] if item["kind"] == kind and item["trackIndex"] == index]

    def AddTrack(self, kind: str) -> bool:
        self.data["tracks"][kind] = self.GetTrackCount(kind) + 1
        save()
        return True

    def DeleteClips(self, items: Sequence[Item], ripple: bool) -> bool:
        assert self.id != "original"
        assert ripple is False
        ids = [v.GetUniqueId() for v in items]
        self.data["items"] = [v for v in self.data["items"] if v["id"] not in ids]
        save()
        return True

    def DuplicateTimeline(self, name: str) -> Timeline:
        clone = "clone-" + str(len(state["timelines"]))
        state["timelines"][clone] = copy.deepcopy(self.data)
        state["timelines"][clone]["name"] = name
        state["clones"] = state.get("clones", 0) + 1
        save()
        if state.get("delayCloneAckUntilRelease"):
            # Readiness was persisted above; the test controls acknowledgement.
            # The real timeout must kill this Python subprocess before release.
            while not file.with_suffix(".clone-release").exists():
                time.sleep(0.01)
        if state.get("delayCloneAck"):
            time.sleep(2)
        if state.get("loseCloneAck"):
            error_message = "simulated acknowledgement loss after native mutation"
            raise RuntimeError(error_message)
        return Timeline(clone)

    def Export(self, file: str, exportType: str) -> bool:
        assert exportType == "DRT"
        Path(file).write_text(json.dumps(self.data, sort_keys=True))
        return True


class Pool:
    def ImportMedia(self, files: list[str]) -> list[Media]:
        state.setdefault("calls", []).append({"method": "ImportMedia", "files": files})
        save()
        return [Media(file) for file in files]

    def AppendToTimeline(self, infos: list[Params]) -> list[Item]:
        assert state["current"] != "original"
        items = []
        for info in infos:
            data = {key: value for key, value in info.items() if key != "mediaPoolItem"}
            data.update(source=info["mediaPoolItem"].source, id="item-" + str(state.get("appends", 0)), kind="audio" if info["mediaType"] == 2 else "video")
            state["appends"] = state.get("appends", 0) + 1
            state["timelines"][state["current"]]["items"].append(data)
            state.setdefault("calls", []).append({"method": "AppendToTimeline", "info": data.copy()})
            items.append(Item(data))
        save()
        if state.get("loseImportAck"):
            error_message = "simulated acknowledgement loss after append"
            raise RuntimeError(error_message)
        return items


class Project:
    def GetUniqueId(self) -> str:
        return "owned-synthetic-project"

    def GetTimelineCount(self) -> int:
        return len(state["timelines"])

    def GetTimelineByIndex(self, index: int) -> Timeline:
        return Timeline(list(state["timelines"])[index - 1])

    def GetCurrentTimeline(self) -> Timeline:
        return Timeline(state["current"])

    def SetCurrentTimeline(self, timeline: Timeline) -> bool:
        state["current"] = timeline.GetUniqueId()
        save()
        return True

    def GetMediaPool(self) -> Pool:
        return Pool()


class Manager:
    def GetCurrentProject(self) -> Project:
        return Project()


class Resolve:
    EXPORT_DRT = "DRT"

    def GetVersionString(self) -> str:
        return "20.2.0"

    def GetProjectManager(self) -> Manager:
        return Manager()


def scriptapp(name: str) -> Resolve:
    assert name == "Resolve"
    print("synthetic SDK diagnostic must stay off stdout JSON")  # noqa: T201 -- The owning Node caller consumes this worker output.
    return Resolve()
