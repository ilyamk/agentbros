import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addMotionCandidate, searchMotionCandidates, motionSources } from "../src/lib/model-preparation/library";

test("dated market/category shortlist separates acquisition, originality and rights", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "motion-library-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const now = new Date("2026-11-15T10:00:00Z"),
    base = {
      schemaVersion: 1,
      title: "Football dance",
      origin: "social",
      sourceUrl: "https://www.tiktok.com/@fixture/video/123",
      category: "sports",
      tags: ["dance"],
      market: "US",
      observedAt: "2026-11-14T10:00:00Z",
      trendEvidence: "Observed ranking on the public chart; fixture only",
      acquisition: "public-post",
    };
  addMotionCandidate("demo", { ...base, id: "fresh" }, root, now);
  addMotionCandidate("demo", { ...base, id: "old", observedAt: "2026-10-01T10:00:00Z" }, root, now);
  addMotionCandidate(
    "demo",
    { ...base, id: "higgsfield", origin: "higgsfield", acquisition: "manual-export" },
    root,
    now,
  );
  const rows = searchMotionCandidates("demo", { query: "dance", market: "US", category: "sports", now }, root);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.rights, "unknown");
  const post = rows.find((row) => row.id === "fresh")!;
  assert.deepEqual(post.acquisitionNext.argv, ["--project", "demo", "--url", base.sourceUrl, "--dry-run"]);
  assert.equal(rows.find((row) => row.id === "higgsfield")!.acquisitionNext.command, null);
  assert.equal(searchMotionCandidates("demo", { market: "ID", now }, root).length, 0);
  assert.equal(searchMotionCandidates("demo", { now, maxAgeDays: 60 }, root).length, 3);
  assert.throws(() => addMotionCandidate("demo", { ...base, id: "fresh", title: "Overwrite" }, root, now));
  assert.throws(
    () => addMotionCandidate("demo", { ...base, id: "bad", origin: "higgsfield" }, root, now),
    /No supported Higgsfield/,
  );
  assert.throws(
    () => addMotionCandidate("demo", { ...base, id: "future", observedAt: "2026-11-17T00:00:00Z" }, root, now),
    /future/,
  );
  assert.throws(() => addMotionCandidate("demo", { ...base, id: "../escape" }, root, now));
  assert.equal(motionSources().higgsfield.catalogueApi, "unverified");
});

test("Higgsfield public-link candidates return the checked URL resolver without inventing a feed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "motion-public-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const sourceUrl = "https://higgsfield.ai/card/example",
    now = new Date("2026-11-16T10:00:00Z");
  addMotionCandidate(
    "demo",
    {
      schemaVersion: 1,
      id: "public-card",
      title: "Observed motion",
      origin: "higgsfield",
      sourceUrl,
      category: "sports",
      tags: [],
      market: "US",
      observedAt: now.toISOString(),
      trendEvidence: "Dated fixture observation, not live popularity",
      acquisition: "public-link",
    },
    root,
    now,
  );
  const [candidate] = searchMotionCandidates("demo", { now }, root);
  assert.equal(candidate.acquisitionNext.command, "hf:media");
  assert.deepEqual(candidate.acquisitionNext.argv, ["--action", "resolve", "--url", sourceUrl, "--kind", "video"]);
});
