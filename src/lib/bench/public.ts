import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BenchBundleSchema, type BenchBundle } from "../../types/bench";
import { compileLeakPatterns, loadLeakPatterns, type LeakPattern } from "../leak-scan";
import { digest, fail } from "./io";

export function publicSummary(original: BenchBundle, sourceManifestSha256: string) {
  return {
    sourceManifestSha256,
    tokens: original.tokens,
    toolCalls: original.toolCalls,
    wallTimeSec: original.wallTimeSec,
    spendUsd: original.spendUsd,
    status: original.status,
  };
}
export function publicManifest(original: BenchBundle, sourceManifestSha256: string) {
  const bytes = Buffer.from(JSON.stringify(publicSummary(original, sourceManifestSha256), null, 2) + "\n");
  return BenchBundleSchema.parse({
    version: 1,
    protocolVersion: original.protocolVersion,
    suiteVersion: original.suiteVersion,
    taskSha256: original.taskSha256,
    visibility: "public",
    publication: { policyVersion: 1, sourceManifestSha256 },
    cell: { ...original.cell, task: `task-${original.taskSha256.slice(0, 16)}` },
    files: [{ path: "summary.json", sha256: digest(bytes), bytes: bytes.length }],
    omitted: [],
    env: { os: "redacted", arch: "redacted", node: "redacted", harnessVersion: "redacted" },
    tokens: original.tokens,
    toolCalls: original.toolCalls,
    wallTimeSec: original.wallTimeSec,
    spendUsd: original.spendUsd,
    transcript: null,
    status: original.status,
    exitCode: original.exitCode,
    claims: {
      tokens: original.tokens,
      toolCalls: original.toolCalls,
      spendUsd: original.spendUsd,
      transcriptState: "truncated",
      delivery: "unavailable",
      criteria: [],
      technical: {},
    },
  });
}
export function checkPublicExport(root: string, manifest: BenchBundle, summary: unknown, signature?: string): void {
  if (
    !manifest.publication ||
    !isDeepStrictEqual(manifest, publicManifest(manifest, manifest.publication.sourceManifestSha256)) ||
    !isDeepStrictEqual(summary, publicSummary(manifest, manifest.publication.sourceManifestSha256))
  )
    fail("Public export differs from the sanitised projection");
  const config = JSON.parse(readFileSync(path.join(root, "public-export.json"), "utf8")) as {
    leakPatterns: LeakPattern[];
  };
  const { leakPatterns } = loadLeakPatterns(root, config.leakPatterns, "optional");
  const texts = [
    "summary.json",
    "manifest.json",
    JSON.stringify(summary, null, 2),
    JSON.stringify(manifest, null, 2),
    ...(signature ? ["manifest.json.sig", signature] : []),
  ];
  for (const text of texts.flatMap((text) => [text, ...text.split("\n")])) {
    if (compileLeakPatterns(leakPatterns).some((pattern) => pattern.regex.test(text)))
      fail("Leak scan hit in public benchmark export; no public copy written");
  }
}
