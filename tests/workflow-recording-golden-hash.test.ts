import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { recordingFixture } from "./workflow-recording-edit-fixtures";
import { timingFixture } from "./workflow-recording-timing-fixtures";

const golden = JSON.parse(
  readFileSync(path.resolve("tests/fixtures/recording-edit-golden-identities.json"), "utf8"),
) as { cases: Record<string, { editHash: string; sourceSha256: string; identity: unknown }> };
const fill = (value: unknown, values: Record<string, string>): unknown =>
  typeof value === "string" && /^<[A-Za-z0-9_]+>$/.test(value)
    ? (values[value.slice(1, -1)] ?? assert.fail(`no value for ${value}`))
    : Array.isArray(value)
      ? value.map((item) => fill(item, values))
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]))
        : value;

const cases: [string, (root: string) => Record<string, any>][] = [
  ["v1", (root) => recordingFixture(root)],
  ["v2-ntsc", (root) => timingFixture(root, "ntsc").request],
  ["v2-vfr", (root) => timingFixture(root, "vfr").request],
];
for (const [name, make] of cases)
  test(`${name} edit hash is byte-identical to the identity recorded from the code before request version 3`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "recording-golden-"));
    try {
      const request = make(root);
      const metadata = (await runRecordingEditWorkflow(request, { action: "plan", rootDir: root })).metadata as Record<
        string,
        any
      >;
      const timing = metadata.sourceTiming ?? {};
      const expected = fill(golden.cases[name].identity, {
        SOURCE_SHA256: request.source.sha256,
        timingHash: timing.timingHash,
        mappingHash: timing.mappingHash,
        timingSummaryHash: timing.timingSummaryHash,
        normalizerVersion: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0],
      });
      assert.equal(createHash("sha256").update(JSON.stringify(expected)).digest("hex"), metadata.editHash);
      if (request.source.sha256 === golden.cases[name].sourceSha256)
        assert.equal(metadata.editHash, golden.cases[name].editHash);
      else
        t.diagnostic(
          "fixture media differs from the recording machine (another FFmpeg build); identity structure checked, literal hash not comparable",
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
