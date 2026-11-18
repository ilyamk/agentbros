import { projectChapterPlan } from "../longform/runner";
import { UnsupportedChapterInspection, ChapterInspectionInputs } from "../longform/inspection-inputs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ChapterManifestSchema } from "../../types/longform";
import { parseTimelineEditDocument, RevisionConflict } from "../timeline-ir/store";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { compare } from "../timeline-ir/rational";
import { planChapters } from "../longform/plans";
import { workflowEvidenceExists } from "../workflows/local-evidence";

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ChapterInspectionSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    timelineHash: sha,
    manifestSha256: sha.nullable(),
    chapterId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .max(128)
      .optional(),
    format: z.enum(["vertical", "square", "landscape"]),
  })
  .strict();
const CacheSchema = z.record(
  z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .max(128),
  z.object({ fingerprint: sha, output: z.string().min(1).max(4096), outputHash: sha }).strict(),
);
/** Read-only navigator. A cache receipt alone never authorizes output reuse. */
export function inspectChapters(project: string, raw: unknown, rootDir: string) {
  const request = ChapterInspectionSchema.parse(raw);
  const inspectionInputs = new ChapterInspectionInputs();
  const journalFile = path.join(project, "pipeline/timeline-edit.json");
  const journal = inspectionInputs.read(journalFile, project, 4 * 1024 * 1024);
  const document = parseTimelineEditDocument(JSON.parse(journal.text));
  const timelineHash = digest(document.timeline);
  if (document.revision !== request.expectedRevision || timelineHash !== request.timelineHash)
    throw new RevisionConflict(request.expectedRevision, document.revision);
  if (document.timeline.projectId !== path.basename(project)) throw Error("Chapter journal belongs to another project");
  const manifestFile = path.join(project, "pipeline/chapters.json");
  const present = workflowEvidenceExists(manifestFile);
  if (!present) {
    if (request.manifestSha256 !== null) throw Error("Chapter manifest changed; refresh inspection");
    inspectionInputs.absent(manifestFile, project);
    inspectionInputs.assertUnchanged();
    return {
      status: "absent" as const,
      revision: document.revision,
      timelineHash,
      manifestSha256: null,
      chapters: [],
      format: request.format,
    };
  }
  const consumed = inspectionInputs.read(manifestFile, project, 256 * 1024);
  if (request.manifestSha256 !== null && consumed.sha256 !== request.manifestSha256)
    throw Error("Chapter manifest changed; refresh inspection");
  const manifest = ChapterManifestSchema.parse(JSON.parse(consumed.text));
  if (
    manifest.chapters.length > 128 ||
    manifest.protectedSpans.length > 256 ||
    manifest.chapters.some((c) => c.id.length > 128 || c.title.length > 512) ||
    manifest.protectedSpans.some((s) => s.id.length > 128 || s.note.length > 2048 || s.requires.length > 256)
  )
    throw Error("Chapter manifest exceeds inspection bounds");
  const whole = compileTimelineIR(document.timeline);
  if (whole.tracks.reduce((n, t) => n + t.clips.length, 0) > 4096)
    throw Error("Chapter timeline exceeds inspection clip bound");
  for (const span of manifest.protectedSpans)
    if (compare(span.start, { num: 0, den: 1 }) < 0 || compare(span.end, whole.duration) > 0)
      throw Error("Protected context exceeds source timeline");
  const plan = planChapters(document.timeline, manifest);
  let verifiedPlan: ReturnType<typeof projectChapterPlan> | undefined, unsupported: string | undefined;
  try {
    verifiedPlan = projectChapterPlan(document.timeline.projectId, manifest, {
      rootDir,
      format: request.format,
      readonlyInspection: inspectionInputs,
    });
  } catch (error) {
    if (error instanceof UnsupportedChapterInspection) unsupported = error.message;
    else throw error;
  }
  const chapter = request.chapterId ? manifest.chapters.find((c) => c.id === request.chapterId) : manifest.chapters[0];
  if (!chapter) throw Error("Unknown selected chapter");
  const job = plan.jobs.find((j) => j.chapterId === chapter.id)!;
  const cacheFile = path.join(rootDir, "out", document.timeline.projectId, "chapters", request.format, "cache.json");
  let cacheStatus = "absent",
    candidate: { fingerprint: string; outputHash: string; outputPresent: boolean } | null = null;
  const verifiedJob = verifiedPlan?.jobs.find((j) => j.chapterId === chapter.id);
  if (workflowEvidenceExists(cacheFile)) {
    // Root-scoped reader rejects every ancestor alias, including out/project/format.
    const receipt = inspectionInputs.read(cacheFile, rootDir, 256 * 1024);
    const cache = CacheSchema.parse(JSON.parse(receipt.text));
    if (Object.keys(cache).length > 128) throw Error("Chapter cache exceeds entry bound");
    for (const [id, entry] of Object.entries(cache))
      if (path.resolve(entry.output) !== path.join(path.dirname(cacheFile), `${id}-${entry.fingerprint}.mp4`))
        throw Error("Chapter cache output path mismatch");
    cacheStatus = "candidate-unverified";
    const entry = cache[chapter.id];
    if (entry)
      candidate = {
        fingerprint: entry.fingerprint,
        outputHash: entry.outputHash,
        outputPresent: workflowEvidenceExists(entry.output),
      };
  }
  if (verifiedJob?.action === "reuse") {
    if (
      !candidate ||
      candidate.fingerprint !== verifiedJob.fingerprint ||
      candidate.outputHash !== verifiedJob.previousOutputHash ||
      !candidate.outputPresent
    )
      throw Error("Chapter cache candidate does not match verified output");
    cacheStatus = "verified-by-chapter-planner";
  }
  const reuseReason =
    unsupported ||
    (verifiedJob?.action === "reuse"
      ? "Existing chapter planner verified exact dependencies, renderer/config fingerprint and immutable output hash."
      : verifiedJob?.cacheReason === "unknown-asset-dependencies-disable-reuse"
        ? verifiedJob.cacheReason
        : !candidate
          ? "No cached output for selected chapter/format."
          : candidate.fingerprint !== verifiedJob?.fingerprint
            ? "Render context, dependencies or renderer closure differ from cached fingerprint."
            : "Cached output missing or immutable output hash verification failed.");
  // Bind the response to the same consumed bytes. This is an observation, not a filesystem transaction.
  if (
    inspectionInputs.read(journalFile, project, 4 * 1024 * 1024).sha256 !== journal.sha256 ||
    inspectionInputs.read(manifestFile, project, 256 * 1024).sha256 !== consumed.sha256
  )
    throw Error("Chapter inputs changed during inspection");
  inspectionInputs.assertUnchanged();
  return {
    status: "ready" as const,
    revision: document.revision,
    timelineHash,
    journalSha256: journal.sha256,
    manifestSha256: consumed.sha256,
    manifestRevision: manifest.revision,
    format: request.format,
    chapters: manifest.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      start: c.start,
      end: c.end,
      revision: c.revision,
    })),
    selected: {
      ...chapter,
      tracks: job.snapshot.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        clips: t.clips.map((c) => ({
          id: c.id,
          assetId: c.assetId,
          start: c.start,
          end: c.end,
          source: c.source,
          rate: c.rate,
        })),
      })),
      protectedContext: manifest.protectedSpans.filter(
        (s) => compare(s.start, chapter.end) < 0 && compare(s.end, chapter.start) > 0,
      ),
      dependencyIds: Object.keys(job.dependencies),
      reuse: {
        action: verifiedJob?.action === "reuse" ? "reuse" : "render-required",
        cacheStatus,
        candidate,
        verified: verifiedJob?.action === "reuse",
        fingerprint: verifiedJob?.fingerprint,
        dependencies: verifiedJob?.dependencies,
        reason: reuseReason,
      },
    },
    readonly: true,
  };
}
