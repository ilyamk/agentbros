/** WP15 snapshot mode (RFC 0004 D18): embedded data, read-only client, media replaced by a note with a local path. */
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { dictionaries } from "@/i18n";
import { FIXTURES } from "@/lib/fixtures";
import { setSnapshotMode } from "@/lib/snapshot-mode";
import { MediaSlot } from "@/media";
import { OpenInStudio } from "@/media/studio-action";
import { RateMedia } from "@/panels/film/feedback";
import { VerdictPanel } from "@/panels/film/verdict";
import { snapshotHref } from "@/media/snapshot-media";
import { renderWith } from "@/test/utils";
import { readSnapshot, SNAPSHOT_ELEMENT_ID, SnapshotApiClient, type SnapshotData } from "./snapshot";

const view = FIXTURES["view-film-build"];
const data: SnapshotData = {
  v: 1,
  takenAt: "2026-11-17T10:00:00Z",
  view,
  summary: {
    id: view.project.id,
    route: view.project.route,
    waiting: view.waiting.length,
    control: "running",
    spentUsd: 0,
    updatedAt: view.generatedAt,
  },
};

afterEach(() => {
  setSnapshotMode(undefined);
  document.getElementById(SNAPSHOT_ELEMENT_ID)?.remove();
});

describe("snapshot", () => {
  it("reads the embedded JSON and ignores a malformed or wrong-typed element", () => {
    const element = document.createElement("script");
    element.id = SNAPSHOT_ELEMENT_ID;
    element.type = "application/json";
    element.textContent = JSON.stringify(data);
    document.body.append(element);
    expect(readSnapshot(document)?.view.project.id).toBe(view.project.id);
    element.textContent = "{";
    expect(readSnapshot(document)).toBeUndefined();
    element.type = "module";
    element.textContent = JSON.stringify(data);
    expect(readSnapshot(document)).toBeUndefined();
  });

  it("serves the one project and refuses every action", async () => {
    const client = new SnapshotApiClient(data);
    expect(client.mode).toBe("snapshot");
    expect((await client.view(view.project.id)).project.id).toBe(view.project.id);
    await expect(client.view("other")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect((await client.projects()).projects).toHaveLength(1);
    expect((await client.events()).events).toEqual([]);
    await expect(client.decide()).rejects.toMatchObject({ code: "READ_ONLY" });
    await expect(client.control()).rejects.toMatchObject({ code: "READ_ONLY" });
    await expect(client.answerCard()).rejects.toMatchObject({ code: "READ_ONLY" });
    expect("library" in client).toBe(false);
  });

  it("replaces media by a note with a path relative to out/<id>/", () => {
    expect(snapshotHref("p", { path: "renders/a b.mp4", kind: "video", root: "out" })).toBe("./renders/a%20b.mp4");
    expect(snapshotHref("p", { path: "music/t.wav", kind: "audio" })).toBe("../../public/projects/p/music/t.wav");
    setSnapshotMode({ project: "p", takenAt: data.takenAt });
    renderWith(<MediaSlot project="p" media={{ path: "renders/final.mp4", kind: "video", root: "out" }} />);
    expect(screen.getByText(dictionaries.en.snapshot.mediaOmitted)).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("[data-snapshot-media] a")?.getAttribute("href")).toBe("./renders/final.mp4");
  });

  it("offers no rating, verdict form or studio command on a snapshot (WP9, WP15)", () => {
    const human = FIXTURES["view-film-human"];
    setSnapshotMode({ project: human.project.id, takenAt: data.takenAt });
    const { container } = renderWith(
      <>
        <RateMedia project="p" media={{ path: "pipeline/frames/a.png", kind: "image" }} />
        <OpenInStudio project={human.project.id} composition="Main" />
        <VerdictPanel view={human} />
      </>,
    );
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(screen.getByText(dictionaries.en.snapshot.readOnly)).toBeTruthy();
  });
});
