import { createHash } from "node:crypto";
import path from "node:path";
import { TimelineEditStore } from "../timeline-ir/store";
import { fraction, compare } from "../timeline-ir/rational";
import { type SourceIndex, SourceIndexSchema } from "../../types/source-index";
import { assertPathWithin, requireProject, CliErrorObject } from "../cli";
import { readSourceIndex } from "./index";
const tokens = (text: string) => [
  ...new Set(
    text
      .toLocaleLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  ),
];
export interface SourceSelect {
  cacheKey: string;
  assetId: string;
  sourceHash: string;
  segmentId: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
  scoreParts: { transcriptCoverage: number; tagCoverage: number; exactPhraseBonus: number };
  matchedTokens: string[];
  evidence: SourceIndex["segments"][number]["evidence"];
  method: "lexical-transcript-and-tags";
}
export function searchSourceIndexes(indexes: SourceIndex[], query: string, limit = 10): SourceSelect[] {
  const needles = tokens(query);
  if (!needles.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Search requires nonempty words and a limit from 1 to 100.",
    });
  const hits: SourceSelect[] = [];
  for (const raw of indexes) {
    const index = SourceIndexSchema.parse(raw);
    for (const segment of index.segments) {
      const words = tokens(segment.text),
        tags = tokens(segment.tags.join(" "));
      const matched = needles.filter((word) => words.includes(word) || tags.includes(word));
      if (!matched.length) continue;
      const transcriptCoverage = needles.filter((word) => words.includes(word)).length / needles.length;
      const tagCoverage = needles.filter((word) => tags.includes(word)).length / needles.length;
      const exactPhraseBonus = segment.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? 0.25 : 0;
      hits.push({
        cacheKey: index.cacheKey,
        assetId: index.assetId,
        sourceHash: index.sourceHash,
        segmentId: segment.id,
        startSec: segment.startSec,
        endSec: segment.endSec,
        text: segment.text,
        score: transcriptCoverage + 0.5 * tagCoverage + exactPhraseBonus,
        scoreParts: { transcriptCoverage, tagCoverage, exactPhraseBonus },
        matchedTokens: matched,
        evidence: segment.evidence,
        method: "lexical-transcript-and-tags",
      });
    }
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.assetId.localeCompare(b.assetId) ||
        a.startSec - b.startSec ||
        a.segmentId.localeCompare(b.segmentId),
    )
    .slice(0, limit);
}
export interface SelectProposal {
  version: 1;
  id: string;
  projectId: string;
  cacheKey: string;
  assetId: string;
  sourceHash: string;
  segmentIds: string[];
  startSec: number;
  endSec: number;
  contextSec: number;
  evidence: SourceSelect["evidence"];
  reviewRequired: true;
  instruction: "Review the entire statement and its context before applying this explicit trim.";
}
export function proposeSelect(index: SourceIndex, hit: SourceSelect, contextSec = 1.5): SelectProposal {
  if (!Number.isFinite(contextSec) || contextSec < 0 || contextSec > 60)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Context must be 0–60 seconds." });
  const segment = index.segments.find((s) => s.id === hit.segmentId);
  if (
    hit.cacheKey !== index.cacheKey ||
    hit.sourceHash !== index.sourceHash ||
    hit.assetId !== index.assetId ||
    !segment
  )
    throw new CliErrorObject({ code: "VALIDATION", message: "Select evidence does not match its source index." });
  let startSec = Math.max(0, segment.startSec - contextSec),
    endSec = Math.min(index.source.durationSec, segment.endSec + contextSec);
  // Never cut through a supplied statement or protected span at a boundary.
  const spans = [
    ...index.segments.filter((s) => s.evidence.some((e) => e.kind === "supplied-transcript" || e.kind === "local-asr")),
    ...index.options.protectedSpans,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const span of spans)
      if (span.startSec < endSec && span.endSec > startSec) {
        const nextStart = Math.min(startSec, span.startSec),
          nextEnd = Math.max(endSec, span.endSec);
        if (nextStart !== startSec || nextEnd !== endSec) {
          startSec = nextStart;
          endSec = nextEnd;
          changed = true;
        }
      }
  }
  const segmentIds = index.segments.filter((s) => s.startSec < endSec && s.endSec > startSec).map((s) => s.id);
  const identity = {
    projectId: index.projectId,
    cacheKey: index.cacheKey,
    assetId: index.assetId,
    sourceHash: index.sourceHash,
    segmentIds,
    startSec,
    endSec,
    contextSec,
  };
  return {
    version: 1,
    id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    ...identity,
    evidence: segment.evidence,
    reviewRequired: true,
    instruction: "Review the entire statement and its context before applying this explicit trim.",
  };
}
/** Only an explicit reviewed trim is applied; there is no automatic silence or meaning deletion. */
export function applySelect(request: {
  projectId: string;
  indexFile: string;
  proposal: SelectProposal;
  trackId: string;
  clipId: string;
  expectedRevision: number;
  dryRun?: boolean;
}) {
  requireProject(request.projectId);
  const index = readSourceIndex(request.projectId, request.indexFile),
    proposal = request.proposal;
  const first = index.segments.find((segment) => segment.id === proposal.segmentIds[0]);
  if (
    !first ||
    proposal.projectId !== request.projectId ||
    proposal.cacheKey !== index.cacheKey ||
    proposal.sourceHash !== index.sourceHash ||
    proposal.assetId !== index.assetId
  )
    throw new CliErrorObject({ code: "VALIDATION", message: "Proposal identity does not match source evidence." });
  // Rebuild each possible evidence proposal instead of trusting edited timecodes/IDs.
  const verified = index.segments.some((segment) => {
    const expected = proposeSelect(
      index,
      {
        segmentId: segment.id,
        cacheKey: index.cacheKey,
        assetId: index.assetId,
        sourceHash: index.sourceHash,
      } as SourceSelect,
      proposal.contextSec,
    );
    return (
      expected.id === proposal.id && expected.startSec === proposal.startSec && expected.endSec === proposal.endSec
    );
  });
  if (!verified)
    throw new CliErrorObject({ code: "VALIDATION", message: "Proposal was altered or lacks reproducible evidence." });
  if (!index.source.fps || index.source.variableFrameRate)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Timeline trims require a constant-frame-rate video; normalize VFR/audio explicitly first.",
    });
  const project = path.resolve("public/projects", request.projectId),
    file = path.join(project, "pipeline/timeline-edit.json");
  assertPathWithin(project, file);
  const store = new TimelineEditStore(file),
    doc = store.read();
  const clip = doc.timeline.tracks
    .find((track) => track.id === request.trackId)
    ?.clips.find((row) => row.id === request.clipId);
  if (!clip || clip.assetId !== index.assetId)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Target clip must reference the indexed immutable source asset.",
    });
  if (clip.source.timebase.num * index.source.fps.den !== index.source.fps.num * clip.source.timebase.den)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Target clip source frame rate does not match the index.",
    });
  const fps = index.source.fps.num / index.source.fps.den;
  const start = fraction(Math.floor(proposal.startSec * fps + 1e-6)),
    end = fraction(Math.ceil(proposal.endSec * fps - 1e-6));
  if (compare(start, clip.source.start) < 0 || compare(end, clip.source.end) > 0)
    throw new CliErrorObject({ code: "VALIDATION", message: "Select cannot extend the target clip." });
  for (const protectedSpan of index.options.protectedSpans) {
    const oldStart = clip.source.start.num / clip.source.start.den / fps,
      oldEnd = clip.source.end.num / clip.source.end.den / fps;
    if (
      protectedSpan.startSec < oldEnd &&
      protectedSpan.endSec > oldStart &&
      (protectedSpan.startSec < proposal.startSec || protectedSpan.endSec > proposal.endSec)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Trim would discard protected context: ${protectedSpan.reason}`,
      });
  }
  const command = { type: "trim" as const, trackId: request.trackId, clipId: request.clipId, start, end };
  return request.dryRun
    ? store.dryRun(command, request.expectedRevision)
    : store.apply(command, request.expectedRevision);
}
