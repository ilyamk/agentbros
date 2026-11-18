import {
  preparationDeliveryReview,
  preparationInputCoverage,
  preparationLineageReview,
} from "../model-preparation/results";
import { iconRights } from "../icon-resources/usage";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { compare } from "../timeline-ir/rational";
import { TimelineEditStore } from "../timeline-ir/store";
import { SceneSchema } from "../../types/video";
import { workflowClaims } from "../workflows/claims";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readAssetRegistry, hashFile } from "../assets/registry";
import { evaluateResourceUsage, isStockLicence, normalizeLicence } from "../resources/rights";
import { assertPathWithin } from "../cli";
import type { z } from "zod";
import { deliveryUseContext } from "./use-context";
import { DeliveryRequestSchema, type DeliverySnapshot, type RenderIdentity } from "../../types/delivery";
type Request = z.output<typeof DeliveryRequestSchema>;
export type Finding = { code: string; severity: "error" | "warning"; message: string; path?: string };
/**
 * Every project needs manualApproval naming the user who accepted it. A bespoke film's chain approvals are not read here
 * (docs/production-chain.md), and a legacy template project's pipeline-state.json approvals are ignored: the 16-stage
 * pipeline was removed, so its project.json is delivered on the timeline route like any other.
 */
export function reviewGates(
  _root: string,
  request: Request,
  snapshot: DeliverySnapshot,
  findings: Finding[],
  options: { bespoke?: boolean } = {},
) {
  const error = (message: string) => findings.push({ code: "CREATIVE_APPROVAL_REQUIRED", severity: "error", message });
  const approval = request.manualApproval;
  if (
    request.approvalMode !== "manual" ||
    !approval ||
    approval.sourceSnapshotHash !== snapshot.id ||
    !snapshot.identities.every((identity) => identity.storyHash === approval.storyHash)
  )
    error(
      options.bespoke
        ? 'A bespoke film needs approvalMode "manual" and manualApproval naming the user who accepted the film, bound to this snapshot id and its storyHash'
        : `Production needs approvalMode "manual" (stage approvals are gone${request.approvalMode === "pipeline" ? '; this request still says "pipeline"' : ""}) and explicit named human approval bound to this story and complete source snapshot`,
    );
  else
    findings.push({
      code: "HUMAN_DECLARED_APPROVAL",
      severity: "warning",
      message: "Approval is supplied human evidence; no independent creative judgement is inferred",
    });
}
export function reviewClaims(root: string, request: Request, snapshot: DeliverySnapshot, findings: Finding[]) {
  const project = path.join(root, "public/projects", request.projectId);
  const raw = JSON.parse(readFileSync(path.join(project, "project.json"), "utf8")) as Record<string, any>;
  const brief = existsSync(path.join(project, "pipeline/brief.json"))
    ? JSON.parse(readFileSync(path.join(project, "pipeline/brief.json"), "utf8"))
    : {};
  const educational =
    raw.educational === true ||
    /educat|explain|обуч|образоват|документаль/i.test(
      JSON.stringify({ tone: brief.tone, genre: brief.genre, recipe: raw.recipe, declared: raw.educational }),
    );
  const authoredClaims = workflowClaims(root, request.projectId);
  const declared = request.declaredClaims;
  const review = request.claimsReview;
  const embeddedFacts = raw.claims ?? raw.declaredClaims ?? raw.facts;
  const required =
    educational ||
    authoredClaims.length > 0 ||
    declared.length > 0 ||
    (Array.isArray(embeddedFacts) && embeddedFacts.length > 0);
  if (!required) return;
  const fail = (message: string) => findings.push({ code: "CLAIMS_REVIEW_REQUIRED", severity: "error", message });
  if (!review || !snapshot.identities.every((identity) => identity.storyHash === review.storyHash)) {
    fail("Educational/declared factual content requires a current story-bound reviewed claim/source map");
    return;
  }
  if (Array.isArray(embeddedFacts) && embeddedFacts.length && declared.length < embeddedFacts.length)
    fail("Declared project facts are not fully mapped by the supplied claim records");
  for (const authored of authoredClaims) {
    const mapped = declared.find((claim) => claim.id === authored.id);
    if (!mapped || mapped.text !== authored.text || mapped.sceneId !== authored.sceneId)
      fail(`Workflow assertion ${authored.id} requires its exact authored text and owning scene`);
    const checked = review.claims.find((claim) => claim.id === authored.id);
    if (!checked || (authored.sourceUrls.length && !authored.sourceUrls.includes(checked.sourceUrl)))
      fail(`Workflow assertion ${authored.id} needs a reviewed source from its pinned source map`);
  }
  if (
    new Set(declared.map((claim) => claim.id)).size !== declared.length ||
    new Set(review.claims.map((claim) => claim.id)).size !== review.claims.length
  )
    fail("Duplicate claim/source IDs");
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  if (Array.isArray(embeddedFacts))
    for (const fact of embeddedFacts) {
      const text = typeof fact === "string" ? fact : fact?.text;
      if (typeof text !== "string" || !declared.some((claim) => normalize(claim.text) === normalize(text)))
        fail("Every embedded factual declaration needs an exact claim text mapping");
    }
  // Only display-bearing fields count as visible evidence; paths, IDs and provider prompts do not.
  const displayKeys = new Set([
    "text",
    "headline",
    "subtext",
    "title",
    "label",
    "caption",
    "author",
    "handle",
    "yUnit",
    "yAxisLabel",
    "xAxisLabel",
    "value",
    "suffix",
    "prefix",
    "lines",
    "bullets",
    "quote",
    "labels",
    "name",
    "category",
    "xLabel",
  ]);
  const displayCopy = (value: unknown, key = ""): string[] => {
    if (typeof value === "string" || typeof value === "number") return displayKeys.has(key) ? [String(value)] : [];
    if (Array.isArray(value)) return value.flatMap((item) => displayCopy(item, key));
    if (value && typeof value === "object")
      return Object.entries(value).flatMap(([name, item]) => displayCopy(item, name));
    return [];
  };
  const timeline = request.timeline
    ? (() => {
        const file = path.join(project, "pipeline/timeline-edit.json");
        assertPathWithin(project, file);
        const document = new TimelineEditStore(file).read();
        if (document.timeline.projectId !== request.projectId)
          throw new Error("Claim timeline belongs to another project");
        return { raw: document.timeline, compiled: compileTimelineIR(document.timeline) };
      })()
    : undefined;
  for (const claim of declared) {
    const scene = (raw.scenes as Record<string, unknown>[]).find((item) => item.id === claim.sceneId);
    if (timeline) {
      const owners = timeline.compiled.tracks
        .filter((track) => ["visual", "presenter"].includes(track.kind))
        .flatMap((track) => track.clips)
        .filter(
          (clip) =>
            clip.id === claim.sceneId || (clip.payload?.scene as { id?: string } | undefined)?.id === claim.sceneId,
        );
      if (!owners.length) {
        fail(`Claim ${claim.id} has no owning active timeline scene`);
        continue;
      }
      const visible = owners
        .flatMap((clip) => {
          if (!clip.assetId.startsWith("scene:") || !clip.payload?.scene) return [];
          const active = SceneSchema.parse(clip.payload.scene);
          // .text is a speech declaration, not displayed copy. Source URLs/IDs cannot substantiate a claim.
          return [
            displayCopy(
              raw.talkingHead?.enabled
                ? (active.leftPanel ?? {})
                : { headline: active.headline, subtext: active.subtext, template: active.template?.props },
            ).join(" "),
          ];
        })
        .some((text) => normalize(text).includes(normalize(claim.text)));
      const spoken = timeline.compiled.tracks
        .filter((track) => ["voiceover", "presenter", "captions", "visual"].includes(track.kind))
        .some((track) => {
          const words = track.clips
            .flatMap((clip) => {
              const original = timeline.raw.tracks
                .find((item) => item.id === track.id)!
                .clips.find((item) => item.id === clip.id)!;
              return clip.captions.filter((word) => {
                const sourceWord = original.captions.find((item) => item.id === word.id)!;
                return (
                  compare(sourceWord.start, original.source.start) >= 0 &&
                  compare(sourceWord.end, original.source.end) <= 0 &&
                  owners.some((owner) => compare(word.start, owner.start) >= 0 && compare(word.end, owner.end) <= 0)
                );
              });
            })
            .sort((a, b) => compare(a.start, b.start));
          const unique = [
            ...new Map(words.map((word) => [JSON.stringify([word.text, word.start, word.end]), word])).values(),
          ];
          return normalize(unique.map((word) => word.text).join(" ")).includes(normalize(claim.text));
        });
      const originallySpoken =
        scene && typeof scene.text === "string" && normalize(scene.text).includes(normalize(claim.text));
      if (!visible && !spoken) fail(`Claim ${claim.id} does not match retained active timeline copy or timed words`);
      if (originallySpoken && !spoken)
        fail(`Claim ${claim.id} differs between its spoken declaration and retained timeline words`);
      if (!review.claims.some((item) => item.id === claim.id))
        fail(`Claim ${claim.id} has no reviewed supporting source`);
      continue;
    }

    if (!scene || !normalize(JSON.stringify(scene)).includes(normalize(claim.text)))
      fail(`Claim ${claim.id} does not match the declared scene text`);
    if (!review.claims.some((item) => item.id === claim.id))
      fail(`Claim ${claim.id} has no reviewed supporting source`);
    if (scene && typeof scene.text === "string" && normalize(scene.text).includes(normalize(claim.text))) {
      const edited = path.join(project, "voiceover", `${claim.sceneId}.words.edited.json`),
        original = path.join(project, "voiceover", `${claim.sceneId}.words.json`);
      const file = existsSync(edited) ? edited : original;
      assertPathWithin(project, file);
      if (existsSync(file)) {
        const words = JSON.parse(readFileSync(file, "utf8")) as { words?: { text: string }[] };
        if (!normalize((words.words ?? []).map((w) => w.text).join(" ")).includes(normalize(claim.text)))
          fail(`Claim ${claim.id} differs between spoken script and aligned captions`);
      }
    }
  }
  findings.push({
    code: "HUMAN_DECLARED_CLAIMS",
    severity: "warning",
    message: "Claim support is named reviewer evidence, not automated independent factual verification",
  });
}
/** A bespoke film has no scene text to match claims against: declared claims need a story-bound review, and nothing more is inferred. */
export function reviewBespokeClaims(request: Request, snapshot: DeliverySnapshot, findings: Finding[]) {
  if (!request.declaredClaims.length && !request.claimsReview) return;
  const review = request.claimsReview;
  if (!review || !snapshot.identities.every((identity) => identity.storyHash === review.storyHash)) {
    findings.push({
      code: "CLAIMS_REVIEW_REQUIRED",
      severity: "error",
      message: "Declared claims need a current story-bound reviewed claim/source map",
    });
    return;
  }
  for (const claim of request.declaredClaims)
    if (!review.claims.some((item) => item.id === claim.id))
      findings.push({
        code: "CLAIMS_REVIEW_REQUIRED",
        severity: "error",
        message: `Claim ${claim.id} has no reviewed supporting source`,
      });
  findings.push({
    code: "HUMAN_DECLARED_CLAIMS",
    severity: "warning",
    message: "Claim support is named reviewer evidence; a bespoke film's on-screen text is not matched automatically",
  });
}
export function reviewRights(
  root: string,
  request: Request,
  identities: RenderIdentity[],
  findings: Finding[],
  expectedContextSha256?: string,
) {
  const use = deliveryUseContext(root, request, identities);
  if (expectedContextSha256 && expectedContextSha256 !== use.contextSha256)
    throw new Error("Workflow use context changed before rights review");
  const project = path.join(root, "public/projects", request.projectId),
    registry = readAssetRegistry(request.projectId, root);
  const assetSources = [
    ...new Map(
      identities
        .flatMap((i) => i.sources)
        .filter((source) => source.role === "asset")
        .map((source) => [source.sha256, source]),
    ).values(),
  ];
  const resources: { sha256: string; candidate: any; credit: boolean }[] = [];
  const directory = path.join(project, "pipeline/resources");
  if (existsSync(directory)) {
    assertPathWithin(project, directory);
    for (const name of readdirSync(directory).filter((n) => n.endsWith(".json"))) {
      const file = path.join(directory, name);
      assertPathWithin(project, file);
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      if (receipt.resource && receipt.file) {
        const media = path.resolve(root, "public", receipt.file);
        assertPathWithin(path.join(root, "public"), media);
        if (existsSync(media))
          resources.push({
            sha256: hashFile(media),
            candidate: receipt.resource,
            credit: receipt.usage?.credit === true,
          });
      }
    }
  }
  const records: Record<string, unknown>[] = [];
  for (const source of assetSources) {
    const issues: string[] = [];
    let attribution = "",
      licence = "unknown",
      evidence = "missing",
      allowed = false;
    const resource = resources.find((item) => item.sha256 === source.sha256);
    const asset = registry.assets.find((item) => item.hash === source.sha256);
    let preparationReview: ReturnType<typeof preparationDeliveryReview> | undefined;
    if (asset) {
      try {
        const lineage = preparationLineageReview(
          request.projectId,
          asset.id,
          { commercial: request.commercial, placements: request.placements, usage: use.effectiveUsage },
          root,
          registry.assets,
        );
        preparationReview = lineage.find((item) => item.assetId === asset.id);
        if (
          lineage.some((item) => item.requiresAudioReplacement) &&
          !(request.platformAudioPlacement || (request.audioMaster && request.loudness.audioRequired))
        )
          throw new Error(
            "Genjutsu replace-in-edit requires a bound final audioMaster with audioRequired, or the checked native-platform audio handoff.",
          );
      } catch (error) {
        findings.push({
          code: "MODEL_PREPARATION_REVIEW_REQUIRED",
          severity: "error",
          message: `${source.path}: ${String(error)}`,
          path: source.path,
        });
      }
    }
    const preparationInput =
      asset && !preparationReview
        ? preparationInputCoverage(
            request.projectId,
            asset,
            { commercial: request.commercial, placements: request.placements, usage: use.effectiveUsage },
            root,
          )
        : undefined;
    const icon = iconRights(root, request.projectId, source.path, source.sha256);
    if (preparationReview) {
      allowed = true;
      licence = preparationReview.rights.status;
      evidence = "human-declared-genjutsu-source-use";
      findings.push({
        code: "HUMAN_DECLARED_RIGHTS",
        severity: "warning",
        message:
          "Genjutsu rights and visual acceptance are supplied review evidence, not independent legal or creative verification",
        path: source.path,
      });
    } else if (preparationInput) {
      allowed = true;
      licence = preparationInput.rights.status;
      evidence = "human-declared-genjutsu-input-coverage";
    } else if (icon) {
      allowed = icon.allowed;
      licence = icon.licence;
      attribution = icon.attribution;
      issues.push(...icon.issues);
      evidence = "immutable-icon-resource";
    } else if (resource) {
      const review = evaluateResourceUsage(resource.candidate, { ...use.usage, credit: resource.credit });
      allowed = review.allowed;
      issues.push(...review.blockers);
      attribution = review.attribution;
      licence = resource.candidate.rights.licence;
      evidence = "original-resource-record";
    } else if (asset) {
      licence = asset.rights.licence;
      attribution = asset.rights.attribution ?? "";
      evidence = "immutable-asset-record";
      const normalized = normalizeLicence(licence, asset.rights.sourceUrl).code;
      if (
        normalized === "unknown" ||
        /-NC|-ND|-SA/.test(normalized) ||
        !asset.rights.checkedAsOf ||
        !asset.rights.sourceUrl ||
        (request.commercial && asset.rights.commercialAllowed !== true) ||
        asset.rights.attributionRequired === "unknown" ||
        (asset.rights.attributionRequired && !attribution)
      )
        issues.push("Asset licence/commercial permission/source/attribution evidence is incomplete");
      else allowed = true;
      // A missing discovery receipt does not erase restrictions encoded by the known licence.
      if (isStockLicence(normalized) && (use.effectiveUsage.endorsement || use.effectiveUsage.standaloneResale)) {
        allowed = false;
        issues.push(
          `${normalized} licence forbids this endorsement/standalone resale use even without an original resource receipt`,
        );
      }
      // ResourceService imports explicitly identify their catalogue; never guess from a URL.
      const nasaStock = asset.provenance.origin === "stock" && asset.provenance.tool.startsWith("nasa:");
      if (nasaStock) {
        if (!/^nasa:(?:original|preview):.+$/.test(asset.provenance.tool)) {
          allowed = false;
          issues.push("NASA stock provenance requires its canonical resource acquisition identity");
        }
        if (use.effectiveUsage.advertising || use.effectiveUsage.endorsement || use.effectiveUsage.standaloneResale) {
          allowed = false;
          issues.push(
            "NASA catalogue route does not clear advertising, endorsement or standalone resale; obtain asset-specific permission outside this route",
          );
        }
        if (
          !/\bNASA\b/i.test(attribution) ||
          !asset.rights.sourceUrl ||
          !attribution.includes(asset.rights.sourceUrl)
        ) {
          allowed = false;
          issues.push("NASA source acknowledgement and the original asset page must be retained in credits");
        }
      }
    } else issues.push("No licence record for the exact used bytes");
    const human = request.rightsReviews.find((item) => item.sha256 === source.sha256);
    const specialUsesCovered = (["advertising", "endorsement", "standaloneResale"] as const).every(
      (key) => !use.effectiveUsage[key] || human?.usage?.[key] === true,
    );
    if (
      !allowed &&
      human &&
      specialUsesCovered &&
      (!request.commercial || human.commercialAllowed) &&
      human.modifiedAllowed &&
      request.placements.every((p) => human.placements.includes(p)) &&
      human.licence !== "unknown"
    ) {
      allowed = true;
      attribution = human.attribution;
      licence = human.licence;
      evidence = "human-declared-current-hash";
      findings.push({
        code: "HUMAN_DECLARED_RIGHTS",
        severity: "warning",
        message: `Rights for ${source.path} are named human evidence, not independent legal proof`,
        path: source.path,
      });
    }
    if (!allowed)
      findings.push({
        code: "RIGHTS_UNCONFIRMED",
        severity: "error",
        message: `${source.path}: ${issues.join("; ")}. Explicit current-hash review must cover every placement and requested advertising/endorsement/standalone-resale use`,
        path: source.path,
      });
    records.push({
      path: source.path,
      sha256: source.sha256,
      licence,
      attribution,
      evidence,
      allowed,
      placements: request.placements,
      useContext: use,
      ...(human ? { humanReview: human } : {}),
    });
  }
  return records;
}
