import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import { compileTimelineIR, validateTimeline } from "../timeline-ir/compiler";
import { generationInputHash } from "../jobs/runner";
import { exportOtio, exportFcpxml, captionSidecars, type ExportAssets } from "./export";
import { OperationStore } from "../jobs/store";
import { claimOperationWork } from "../jobs/work-lease";
import { assertPathWithin } from "../cli";
export type BackendProbe = {
  available: boolean;
  backend: string;
  version?: string;
  capabilities: string[];
  reason?: string;
  liveVerified: boolean;
};
export interface ResolveAdapter {
  probe(): Promise<BackendProbe>;
  fingerprintOriginal(timelineId: string): Promise<string>;
  cloneTimeline(timelineId: string, cloneName: string): Promise<{ timelineId: string }>;
  importIntoClone(timelineId: string, exportFile: string): Promise<void>;
  readback(timelineId: string): Promise<Record<string, unknown>>;
}
export function expectedTimeline(input: unknown): Record<string, unknown> {
  const compiled = compileTimelineIR(input);
  return {
    version: 1,
    projectId: compiled.projectId,
    timebase: compiled.timebase,
    duration: compiled.duration,
    tracks: compiled.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      clips: t.clips.map((c) => ({
        id: c.id,
        assetId: c.assetId,
        start: c.start,
        end: c.end,
        source: c.source,
        rate: c.rate,
        captions: c.captions,
      })),
    })),
  };
}
const hashFile = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
export function prepareHandoff(input: unknown, assets: ExportAssets, directory: string, originalTimelineId: string) {
  if (!originalTimelineId) throw new Error("Original timeline ID required");
  const ir = validateTimeline(input);
  const root = path.resolve(directory);
  const originals = Object.entries(assets).map(([assetId, asset]) => ({
    assetId,
    path: asset.path,
    sha256: hashFile(asset.path),
  }));
  const handoffId = digest(JSON.stringify({ ir, originals, originalTimelineId }));
  const files = [
    ["timeline.otio", JSON.stringify(exportOtio(ir, assets), null, 2)],
    ["timeline.fcpxml", exportFcpxml(ir, assets)],
    ["captions.exact.json", JSON.stringify(captionSidecars(ir).exact, null, 2)],
    ["captions.srt", captionSidecars(ir).srt],
  ] as const;
  const exports = files.map(([name, content]) => {
    const file = path.join(root, name);
    immutableWrite(file, content);
    return { name, sha256: digest(content) };
  });
  const manifest = {
    version: 1,
    handoffId,
    originalTimelineId,
    cloneName: `${ir.projectId}-finishing-${handoffId.slice(0, 12)}`,
    expected: expectedTimeline(ir),
    originals,
    exports,
    recovery:
      "Originals untouched; preserve clone. Ambiguous clone/import requires reconciliation; never automatically repeat mutation.",
  };
  const content = JSON.stringify(manifest, null, 2);
  immutableWrite(path.join(root, "handoff.json"), content);
  immutableWrite(path.join(root, "handoff.sha256"), digest(content));
  return manifest;
}
async function executeLockedResolveHandoff(
  directory: string,
  adapter: ResolveAdapter,
): Promise<Record<string, unknown>> {
  const root = path.resolve(directory);
  const file = (name: string) => {
    const target = path.join(root, name);
    assertPathWithin(root, target);
    return target;
  };
  if (digest(readFileSync(file("handoff.json"))) !== readFileSync(file("handoff.sha256"), "utf8"))
    throw new Error("Handoff manifest checksum changed");
  const manifest = JSON.parse(readFileSync(file("handoff.json"), "utf8")) as ReturnType<typeof prepareHandoff>;
  const verifyFiles = () => {
    for (const original of manifest.originals)
      if (hashFile(original.path) !== original.sha256) throw new Error("Original asset checksum changed");
    for (const item of manifest.exports)
      if (hashFile(file(item.name)) !== item.sha256) throw new Error("Export checksum changed");
  };
  verifyFiles();
  const probe = await adapter.probe();
  if (
    !probe.available ||
    !/^(19|20)\./.test(probe.version ?? "") ||
    !["clone", "import-into-clone", "readback", "original-fingerprint"].every((cap) => probe.capabilities.includes(cap))
  )
    return {
      available: false,
      state: "unavailable",
      probe,
      reason: "A supported version and complete isolated-clone/readback protocol are required",
    };
  const intent = file("clone-intent.json"),
    cloned = file("clone-result.json"),
    imported = file("import-intent.json"),
    verified = file("readback-verified.json");
  let originalFingerprint: string;
  if (existsSync(intent)) originalFingerprint = JSON.parse(readFileSync(intent, "utf8")).originalFingerprint as string;
  else {
    originalFingerprint = await adapter.fingerprintOriginal(manifest.originalTimelineId);
    if (!originalFingerprint) throw new Error("Original timeline fingerprint missing");
    immutableWrite(intent, JSON.stringify({ handoffId: manifest.handoffId, originalFingerprint }));
  }
  if ((await adapter.fingerprintOriginal(manifest.originalTimelineId)) !== originalFingerprint)
    throw new Error("Original timeline changed since handoff intent");
  let cloneId: string;
  if (existsSync(cloned)) cloneId = JSON.parse(readFileSync(cloned, "utf8")).timelineId as string;
  else {
    // Existing submit intent with no receipt is ambiguous: never duplicate again.
    const dispatch = file("clone-dispatch.json");
    if (existsSync(dispatch))
      return { available: true, state: "unknown", nextAction: "reconcile-clone", handoffId: manifest.handoffId };
    immutableWrite(dispatch, JSON.stringify({ handoffId: manifest.handoffId }));
    const clone = await adapter.cloneTimeline(manifest.originalTimelineId, manifest.cloneName);
    cloneId = clone.timelineId;
    if (!cloneId || cloneId === manifest.originalTimelineId)
      throw new Error("Adapter did not return an isolated clone");
    immutableWrite(cloned, JSON.stringify({ timelineId: cloneId }));
  }
  if (!cloneId || cloneId === manifest.originalTimelineId) throw new Error("Unsafe clone receipt");
  const expectedHash = generationInputHash(manifest.expected);
  let observed: Record<string, unknown>;
  if (existsSync(imported)) observed = await adapter.readback(cloneId);
  else {
    immutableWrite(imported, JSON.stringify({ handoffId: manifest.handoffId, cloneId, expectedHash }));
    await adapter.importIntoClone(cloneId, file("timeline.fcpxml"));
    observed = await adapter.readback(cloneId);
  }
  verifyFiles();
  if ((await adapter.fingerprintOriginal(manifest.originalTimelineId)) !== originalFingerprint)
    throw new Error("Adapter mutated original timeline; handoff verification failed");
  if (generationInputHash(observed) !== expectedHash)
    return {
      available: true,
      state: "contradiction",
      cloneId,
      observed,
      expected: manifest.expected,
      nextAction: "review-clone-readback-no-automatic-import-retry",
    };
  immutableWrite(verified, JSON.stringify({ handoffId: manifest.handoffId, cloneId, expectedHash, observed }));
  return {
    available: true,
    state: "verified",
    cloneId,
    handoffId: manifest.handoffId,
    outputs: [verified],
    nextAction: "manual-finishing-on-clone",
  };
}

export async function executeResolveHandoff(
  directory: string,
  adapter: ResolveAdapter,
): Promise<Record<string, unknown>> {
  const release = claimOperationWork(
    new OperationStore("finishing-bridge", { directory: path.resolve(directory) }),
    "resolve-handoff",
  );
  if (!release) return { state: "busy", nextAction: "resume-handoff-after-current-worker" };
  try {
    return await executeLockedResolveHandoff(directory, adapter);
  } finally {
    release();
  }
}
