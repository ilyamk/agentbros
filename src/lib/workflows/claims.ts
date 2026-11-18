import path from "node:path";
import { z } from "zod";
import { assertPathWithin } from "../cli";
import { readWorkflowEvidence, workflowEvidenceExists } from "./local-evidence";

const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const product = z.object({
  claimEvidence: z.array(
    z.object({ id: text, statement: text, evidence: z.object({ path: text, sha256: hash, excerpt: text }) }),
  ),
  beats: z.array(z.object({ id: text, claimIds: z.array(text) })),
});
const lesson = z.object({
  request: z.object({
    sources: z.array(z.object({ id: text, sha256: hash, url: z.string().url().optional() })).min(1),
    claims: z
      .array(z.object({ id: text, evidence: z.array(z.object({ sourceId: text, excerpt: text })).min(1) }))
      .min(1),
    chapters: z
      .array(z.object({ beats: z.array(z.object({ id: text, spokenText: text, claimIds: z.array(text) })) }))
      .min(1),
  }),
  evidenceFiles: z.array(z.object({ id: text, file: text, sha256: hash })).min(1),
});
const FrozenEvidence = z.object({ path: text, sha256: hash, excerpt: text }).strict();
export const WorkflowClaimsArtifactSchema = z
  .object({
    version: z.literal(1),
    projectId: text,
    claims: z
      .array(
        z
          .object({
            id: text,
            text,
            sceneId: text,
            sourceUrls: z.array(z.string().url()),
            evidence: z.array(FrozenEvidence).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type WorkflowClaim = {
  id: string;
  text: string;
  sceneId: string;
  sourceUrls: string[];
  evidence: z.infer<typeof FrozenEvidence>[];
};

type EvidenceRead = ReturnType<typeof readWorkflowEvidence>;
type Capture = (input: EvidenceRead, maxBytes: number) => void;
function read(file: string, root: string, capture?: Capture): unknown {
  assertPathWithin(root, file);
  const consumed = readWorkflowEvidence(file, root, 8 * 1024 * 1024);
  capture?.(consumed, 8 * 1024 * 1024);
  return JSON.parse(consumed.text);
}
function evidence(file: string, root: string, expectedHash: string, excerpt: string, capture?: Capture): void {
  assertPathWithin(root, file);
  const consumed = readWorkflowEvidence(file, root, 2 * 1024 * 1024);
  capture?.(consumed, 2 * 1024 * 1024);
  if (consumed.sha256 !== expectedHash || !consumed.text.includes(excerpt))
    throw new Error("Workflow claim source changed or supporting excerpt is absent");
}
/** Discover mandatory reviewed assertions from authored workflow data, never a caller opt-out. */
export function workflowClaims(root: string, projectId: string, options: { capture?: Capture } = {}): WorkflowClaim[] {
  const directory = path.join(root, "public/projects", projectId);
  assertPathWithin(path.join(root, "public/projects"), directory);
  const result: WorkflowClaim[] = [];
  const productFile = path.join(directory, "pipeline/product-ad-evidence.json");
  if (workflowEvidenceExists(productFile)) {
    const source = product.parse(read(productFile, directory, options.capture));
    if (!source.claimEvidence.length) throw new Error("Product workflow factual evidence map is empty");
    for (const beat of source.beats)
      for (const id of beat.claimIds) {
        const claim = source.claimEvidence.find((item) => item.id === id);
        if (!claim) throw new Error("Workflow references missing product claim");
        evidence(
          path.resolve(root, "public", claim.evidence.path),
          directory,
          claim.evidence.sha256,
          claim.evidence.excerpt,
          options.capture,
        );
        result.push({
          id: `${id}:${beat.id}`,
          text: claim.statement,
          sceneId: beat.id,
          sourceUrls: [],
          evidence: [{ path: claim.evidence.path, sha256: claim.evidence.sha256, excerpt: claim.evidence.excerpt }],
        });
      }
    if (
      !result.length ||
      source.claimEvidence.some((claim) => !source.beats.some((beat) => beat.claimIds.includes(claim.id)))
    )
      throw new Error("Product claims must be attached to their actual scenes");
  }
  const lessonFile = path.join(directory, "pipeline/education.json");
  if (workflowEvidenceExists(lessonFile)) {
    const source = lesson.parse(read(lessonFile, directory, options.capture));
    if (!source.request.claims.length) throw new Error("Education factual evidence map is empty");
    for (const chapter of source.request.chapters)
      for (const beat of chapter.beats)
        for (const id of beat.claimIds) {
          const claim = source.request.claims.find((item) => item.id === id);
          if (!claim) throw new Error("Workflow references missing lesson claim");
          const sourceUrls: string[] = [],
            frozenEvidence: WorkflowClaim["evidence"] = [];
          for (const citation of claim.evidence) {
            const original = source.request.sources.find((item) => item.id === citation.sourceId);
            const frozen = source.evidenceFiles.find((item) => item.id === citation.sourceId);
            if (!original || !frozen || original.sha256 !== frozen.sha256)
              throw new Error("Lesson evidence ownership/hash differs");
            evidence(
              path.resolve(directory, frozen.file),
              directory,
              original.sha256,
              citation.excerpt,
              options.capture,
            );
            frozenEvidence.push({
              path: path
                .relative(path.join(root, "public"), path.resolve(directory, frozen.file))
                .split(path.sep)
                .join("/"),
              sha256: original.sha256,
              excerpt: citation.excerpt,
            });
            if (original.url) sourceUrls.push(original.url);
          }
          result.push({
            id: `${id}:${beat.id}`,
            text: beat.spokenText,
            sceneId: beat.id,
            sourceUrls,
            evidence: frozenEvidence,
          });
        }
    if (!result.length) throw new Error("Education must map factual sources to actual spoken scenes");
  }
  const inheritedFile = path.join(directory, "pipeline/workflow-claims.json");
  if (workflowEvidenceExists(inheritedFile)) {
    const inherited = WorkflowClaimsArtifactSchema.parse(read(inheritedFile, directory, options.capture));
    if (inherited.projectId !== projectId) throw new Error("Inherited claims belong to another project");
    for (const claim of inherited.claims) {
      for (const citation of claim.evidence)
        evidence(
          path.resolve(root, "public", citation.path),
          directory,
          citation.sha256,
          citation.excerpt,
          options.capture,
        );
      result.push(claim);
    }
  }
  if (new Set(result.map((claim) => claim.id)).size !== result.length)
    throw new Error("Duplicate workflow scene/claim identities");
  return result;
}
