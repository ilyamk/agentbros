import path from "node:path";
import type { z } from "zod";
import {
  DeliveryRequestSchema,
  DeliverySubtitleSelectionSchema,
  DeliverySubtitleOutputSchema,
  type RenderIdentity,
} from "../../types/delivery";
import type { TimelineIR } from "../../types/timeline";
import { captionCues, subtitleText } from "../captions/delivery";
import { generationInputHash } from "../jobs/runner";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import { hashFile } from "../assets/registry";
import { assertPathWithin } from "../cli";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import { parseTimelineEditDocument } from "../timeline-ir/store";

type Request = z.output<typeof DeliveryRequestSchema>;
type Output = z.infer<typeof DeliverySubtitleOutputSchema>;
const stable = (value: unknown) => generationInputHash(value as Record<string, unknown>);
export const subtitleRequestHash = (request: Request) =>
  stable({
    projectId: request.projectId,
    timeline: request.timeline,
    formats: request.formats,
    variants: request.variants,
    placements: request.placements,
    subtitleTracks: request.subtitleTracks,
  });

/** Supplied language is a declaration. Only explicit caption owners are exported; visual copies do not become translation tracks. */
export function planSubtitleTracks(ir: TimelineIR, request: Request) {
  if (!request.subtitleTracks || ir.projectId !== request.projectId)
    throw new Error("Explicit subtitle selection/project required");
  let totalBytes = 0;
  return request.subtitleTracks.map((selected) => {
    const track = ir.tracks.find((track) => track.id === selected.trackId);
    if (!track || !["captions", "voiceover", "presenter"].includes(track.kind))
      throw new Error(`Selected track is not a caption owner: ${selected.trackId}`);
    const cues = captionCues(ir, { trackId: selected.trackId });
    if (!cues.length) throw new Error(`Selected track has no retained caption cues: ${selected.trackId}`);
    const content = subtitleText(cues, selected.format),
      bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    if (bytes > 4 * 1024 * 1024 || totalBytes > 16 * 1024 * 1024)
      throw new Error("Explicit subtitle delivery exceeds bounded output size");
    const output = DeliverySubtitleOutputSchema.parse({
      ...selected,
      trackSha256: stable(track),
      cuesSha256: stable({ cues }),
      sha256: digest(content),
      cueCount: cues.length,
    });
    return { name: selected.filename, content, output };
  });
}

/** Same consumed journal bytes must match every render snapshot source pin. No reopened Store.read is used. */
export function captureSubtitleSelection(root: string, request: Request, identities: RenderIdentity[]) {
  if (!request.subtitleTracks) return undefined;
  const project = path.resolve(root, "public/projects", request.projectId);
  assertPathWithin(path.resolve(root, "public/projects"), project);
  const file = path.join(project, "pipeline/timeline-edit.json"),
    evidence = readWorkflowEvidence(file, project, 8 * 1024 * 1024);
  const sourcePath = path.relative(root, file).split(path.sep).join("/");
  if (
    !identities.length ||
    identities.some(
      (identity) =>
        identity.projectId !== request.projectId ||
        identity.sources.filter(
          (source) => source.path === sourcePath && source.role === "edit" && source.sha256 === evidence.sha256,
        ).length !== 1 ||
        identity.sources.filter((source) => source.path === sourcePath).length !== 1,
    )
  )
    throw new Error("Selected subtitles require exact current journal pins in every render identity");
  const document = parseTimelineEditDocument(JSON.parse(evidence.text));
  if (identities.some((identity) => identity.editRevision !== document.revision))
    throw new Error("Selected subtitle journal revision differs from render identity");
  const files = planSubtitleTracks(document.timeline, request);
  const selection = DeliverySubtitleSelectionSchema.parse({
    version: 1,
    requestHash: subtitleRequestHash(request),
    timelineSource: { path: sourcePath, sha256: evidence.sha256, role: "edit" },
    journalRevision: document.revision,
    outputs: files.map((file) => file.output),
  });
  return { selection, files };
}

export function assertSubtitleSelection(expected: unknown, actual: ReturnType<typeof captureSubtitleSelection>) {
  if (expected === undefined && actual === undefined) return;
  if (
    expected === undefined ||
    actual === undefined ||
    stable(DeliverySubtitleSelectionSchema.parse(expected)) !== stable(actual.selection)
  )
    throw new Error("Explicit subtitle request/source selection changed since delivery snapshot");
}

type SubtitleFile = { name: string; content: string; output?: Output };
function subtitleTarget(directory: string, file: SubtitleFile) {
  if (file.output) {
    const output = DeliverySubtitleOutputSchema.parse(file.output);
    if (output.filename !== file.name || digest(file.content) !== output.sha256)
      throw new Error("Subtitle output declaration differs from exact bytes");
  } else if (!/^captions\.(?:srt|vtt)$/.test(file.name)) throw new Error("Legacy subtitle filename invalid");
  const target = path.join(directory, file.name);
  assertPathWithin(directory, target);
  return target;
}
/** Re-read exact UTF-8 bytes immediately after writes and immediately before the release commit marker. */
export function verifyPublishedSubtitleFiles(directory: string, files: SubtitleFile[]) {
  return files.map((file) => {
    const target = subtitleTarget(directory, file);
    const writtenSha256 = file.output
      ? readWorkflowEvidence(target, directory, 4 * 1024 * 1024).sha256
      : hashFile(target);
    if (writtenSha256 !== digest(file.content)) throw new Error("Subtitle release readback checksum mismatch");
    return target;
  });
}
/** Caller still owns existing release/rights gates. All declarations are checked before the first write. */
export function publishSubtitleFiles(directory: string, files: SubtitleFile[]) {
  const targets = files.map((file) => subtitleTarget(directory, file));
  files.forEach((file, index) => immutableWrite(targets[index]!, file.content));
  return verifyPublishedSubtitleFiles(directory, files);
}
