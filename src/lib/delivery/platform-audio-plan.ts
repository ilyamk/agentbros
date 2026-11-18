import {
  PlatformAudioPlacementSchema,
  PlatformAudioHandoffSchema,
  type PlatformAudioPlacement,
} from "../../types/platform-audio";
import { type ProjectVideoProps } from "../project-props";
import { type RenderIdentity, type DeliveryRequest } from "../../types/delivery";
import { type AssetRegistry } from "../../types/assets";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { compare, add, sub, fraction } from "../timeline-ir/rational";
import { generationInputHash } from "../jobs/runner";
import { evaluateResourceUsage } from "../resources/rights";
import { type DeliveryUseContext } from "./use-context";
export const platformAudioHash = (value: unknown) => generationInputHash(value as Record<string, unknown>);
export function nativeSelectionHash(entry: PlatformAudioPlacement["entries"][number]) {
  const { selectionReview: _, marksReview: __, marks: ___, ...basis } = entry;
  return platformAudioHash(basis);
}
export const nativeMarksHash = (entry: PlatformAudioPlacement["entries"][number]) =>
  platformAudioHash({ selectionHash: nativeSelectionHash(entry), marks: entry.marks });
export const nativeSpanHash = (trackId: string, kind: string, clip: unknown) =>
  platformAudioHash({ trackId, kind, clip });
/** Output listening review is necessarily post-render and not part of prospective selection identity. */
export function platformAudioRequestHash(request: DeliveryRequest, plan: PlatformAudioPlacement) {
  const { outputReviews: _, ...prospective } = plan;
  return platformAudioHash({
    projectId: request.projectId,
    timeline: request.timeline,
    formats: request.formats,
    variants: request.variants,
    placements: request.placements,
    commercial: request.commercial,
    usage: request.usage,
    platformAudioPlacement: prospective,
  });
}
/** Readonly structural routing and declaration correspondence, not acoustic or legal verification. */
export function planPlatformAudioEligibility(
  request: DeliveryRequest,
  input: unknown,
  props: ProjectVideoProps,
  identities: RenderIdentity[],
  registry: AssetRegistry,
  use: DeliveryUseContext,
) {
  const plan = PlatformAudioPlacementSchema.parse(input),
    findings: { code: string; message: string; entryId?: string }[] = [];
  const fail = (code: string, message: string, entryId?: string) => {
    if (findings.length < 128) findings.push({ code, message, ...(entryId ? { entryId } : {}) });
  };
  if (!request.timeline || !props.timeline || props.timeline.projectId !== request.projectId)
    fail("NATIVE_TIMELINE_REQUIRED", "Current explicit project timeline required");
  if (props.audioMaster || request.audioMaster)
    fail("NATIVE_MIXED_MASTER", "Audio masters are unsupported; separated reviewed speech/SFX sources required");
  if (props.talkingHead?.audioSource === "embedded")
    fail("NATIVE_EMBEDDED_AUDIO", "Embedded presenter audio may contain music and is unsupported");
  if (!identities.length || identities.some((identity) => identity.projectId !== request.projectId))
    fail("NATIVE_IDENTITY_INVALID", "Exact current project render identities required");
  if (use.projectId !== request.projectId) fail("NATIVE_USE_CONTEXT", "Use context belongs to another project");
  const routing: unknown[] = [],
    requiredSourceReviews = new Set<string>();
  if (props.timeline) {
    const compiled = compileTimelineIR(props.timeline);
    for (const track of compiled.tracks) {
      if (track.kind === "music" && track.clips.length)
        fail("NATIVE_MUSIC_TRACK", "Nonempty music ownership is forbidden even at zero volume");
      for (const clip of track.clips) {
        if (track.kind === "visual") {
          const asset = props.timelineAssets?.[clip.assetId];
          if (asset?.kind === "audio") fail("NATIVE_VISUAL_AUDIO", "Visual audio asset unsupported");
          if (!asset) {
            const scene = clip.payload?.scene as
              { visualType?: string; template?: unknown; leftPanel?: { kind?: string } } | undefined;
            if (
              !scene ||
              scene.template ||
              (props.talkingHead?.enabled
                ? scene.leftPanel?.kind !== "archival"
                : !["title", "feature", "product", "cta"].includes(scene.visualType ?? "")) ||
              (scene.leftPanel && scene.leftPanel.kind !== "archival")
            )
              fail(
                "NATIVE_RENDERER_PROFILE",
                "Only inspected simple legacy scenes or muted archival panels are supported",
              );
          }
          continue;
        }
        if (!["voiceover", "sfx"].includes(track.kind)) continue;
        const asset = registry.assets.find((item) => item.id === clip.assetId),
          resolved = props.timelineAssets?.[clip.assetId];
        if (
          !asset ||
          asset.kind !== "audio" ||
          !resolved ||
          resolved.kind !== "audio" ||
          resolved.source !== asset.files.original
        ) {
          fail("NATIVE_AUDIO_SOURCE", "Audible source must resolve to a registered immutable audio original");
          continue;
        }
        const role = track.kind === "voiceover" ? "speech" : "sfx",
          spanHash = nativeSpanHash(track.id, track.kind, clip),
          key = JSON.stringify([track.id, clip.id]);
        requiredSourceReviews.add(key);
        const review = plan.sourceReviews.find((item) => item.trackId === track.id && item.clipId === clip.id);
        if (!review || review.assetSha256 !== asset.hash || review.spanHash !== spanHash || review.role !== role)
          fail(
            "NATIVE_CONTENT_REVIEW",
            "Every retained audible original/span requires an exact named speech/SFX no-music declaration",
          );
        routing.push({
          trackId: track.id,
          clipId: clip.id,
          role,
          assetSha256: asset.hash,
          source: asset.files.original,
          spanHash,
          clip,
        });
      }
    }
  }
  if (!routing.length) fail("NATIVE_SPEECH_SFX_REQUIRED", "At least one reviewed speech/SFX source required");
  if (plan.sourceReviews.some((review) => !requiredSourceReviews.has(JSON.stringify([review.trackId, review.clipId]))))
    fail("NATIVE_CONTENT_REVIEW", "Unmatched source-content review cannot certify this timeline");
  for (const entry of plan.entries) {
    const selectionHash = nativeSelectionHash(entry),
      marksHash = nativeMarksHash(entry);
    const supported =
      (entry.platform === "tiktok" && entry.resource.provider === "tiktok-cml") ||
      (["instagram", "facebook"].includes(entry.platform) && entry.resource.provider === "meta-sound-collection");
    if (!supported)
      fail(
        "NATIVE_ROUTE_UNSUPPORTED",
        "This declared catalogue/platform route is pending or unsupported; YouTube library is not inferred native Shorts availability",
        entry.id,
      );
    if (
      entry.target.placement !== entry.platform ||
      !request.placements.includes(entry.target.placement) ||
      !request.formats.includes(entry.target.format) ||
      !request.variants.includes(entry.target.variant)
    )
      fail(
        "NATIVE_TARGET_INVALID",
        "Native selection must match exact requested platform/format/variant placement",
        entry.id,
      );
    if (
      entry.selectionReview.selectionHash !== selectionHash ||
      entry.selectionReview.usageContextSha256 !== use.contextSha256 ||
      entry.marksReview.selectionHash !== selectionHash ||
      entry.marksReview.marksHash !== marksHash
    )
      fail("NATIVE_REVIEW_STALE", "Selection/use/mark review pins do not match current declarations", entry.id);
    const matching = identities.filter(
      (identity) =>
        identity.format === entry.target.format &&
        identity.captions === (entry.target.variant === "clean" ? "off" : "on"),
    );
    if (matching.length !== 1)
      fail("NATIVE_IDENTITY_INVALID", "Native target needs one exact prospective render identity", entry.id);
    else {
      const duration = fraction(matching[0].durationInFrames, 30);
      if (
        compare(entry.videoStart, entry.videoEnd) >= 0 ||
        compare(entry.videoEnd, duration) > 0 ||
        compare(add(entry.sourceOffset, sub(entry.videoEnd, entry.videoStart)), entry.trackDuration) > 0
      )
        fail("NATIVE_OFFSET_INVALID", "Declared video/track interval exceeds exact duration", entry.id);
    }
    let previous = entry.videoStart;
    for (let index = 0; index < entry.marks.length; index++) {
      const mark = entry.marks[index];
      if (
        compare(mark.videoTime, entry.videoStart) < 0 ||
        compare(mark.videoTime, entry.videoEnd) > 0 ||
        (index > 0 && compare(mark.videoTime, previous) <= 0) ||
        compare(mark.trackTime, add(entry.sourceOffset, sub(mark.videoTime, entry.videoStart))) !== 0
      )
        fail(
          "NATIVE_MARK_INVALID",
          "Reviewed marks must be ordered and map exact native/video offset clocks",
          entry.id,
        );
      previous = mark.videoTime;
    }
    if (!entry.resource.rights.allowedPlacements.includes(entry.target.placement))
      fail(
        "NATIVE_RIGHTS_UNCONFIRMED",
        "Native target must be explicitly listed in supplied placement rights",
        entry.id,
      );
    const rights = evaluateResourceUsage(entry.resource, { ...use.usage, placements: [entry.target.placement] });
    for (const blocker of rights.blockers) fail("NATIVE_RIGHTS_UNCONFIRMED", blocker, entry.id);
  }
  const result = PlatformAudioHandoffSchema.parse({
    version: 1,
    status: "pending-manual",
    localStatus: findings.length ? "blocked" : "eligible-awaiting-movie",
    findings,
    movieBindings: [],
    provenance:
      "Locally checked correspondence; reviews are declarations; external placement, account availability and legal permission remain unverified",
  });
  return {
    result,
    plan,
    routing,
    routingHash: platformAudioHash({ timeline: props.timeline, routing }),
    entries: plan.entries.map((entry) => ({
      id: entry.id,
      selectionHash: nativeSelectionHash(entry),
      marksHash: nativeMarksHash(entry),
      target: entry.target,
    })),
  };
}
/** Existing release publisher must never treat a native handoff as platform-complete. */
export function deliveryStateForPlatformAudio(
  request: Pick<DeliveryRequest, "mode"> & { platformAudioPlacement?: unknown },
  blocked: boolean,
): "draft-needs-review" | "blocked" | "production-ready" {
  return request.mode === "draft" || request.platformAudioPlacement !== undefined
    ? "draft-needs-review"
    : blocked
      ? "blocked"
      : "production-ready";
}

export const platformAudioMessage = (error: unknown) =>
  String(error)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500) || "Invalid native input";
/** Caller supplies the existing delivery error result, never a native rights exception. */
export function finalizePlatformAudioEligibility(input: unknown, existingDeliveryBlocked: boolean) {
  const report = PlatformAudioHandoffSchema.parse(input);
  if (existingDeliveryBlocked)
    return PlatformAudioHandoffSchema.parse({
      ...report,
      localStatus: "blocked",
      findings: [
        ...report.findings.slice(0, 127),
        {
          code: "NATIVE_EXISTING_DELIVERY_GATES",
          message: "Existing delivery gates must clear before manual handoff readiness",
        },
      ],
    });
  return report.localStatus === "eligible-awaiting-delivery-gates"
    ? { ...report, localStatus: "ready-for-manual-placement" as const }
    : report;
}

/** Every prospective output is independently eligible; a common routing hash is not eligibility. */
export function aggregatePlatformAudioResults(
  outputs: {
    format: RenderIdentity["format"];
    captions: RenderIdentity["captions"];
    result: ReturnType<typeof PlatformAudioHandoffSchema.parse>;
  }[],
) {
  if (!outputs.length || outputs.length > 6) throw Error("Native eligibility requires bounded prospective outputs");
  const all: ReturnType<typeof PlatformAudioHandoffSchema.parse>["findings"] = [];
  let blocked = false;
  for (const output of outputs) {
    const owner = output.format + "/" + output.captions;
    blocked ||= output.result.localStatus === "blocked" || output.result.findings.length > 0;
    for (const finding of output.result.findings)
      all.push({ ...finding, message: platformAudioMessage(owner + ": " + finding.message) });
    if (output.result.localStatus === "blocked" && !output.result.findings.length)
      all.push({ code: "NATIVE_OUTPUT_BLOCKED", message: owner + ": prospective output is blocked" });
  }
  const findings =
    all.length > 128
      ? [
          ...all.slice(0, 127),
          {
            code: "NATIVE_FINDING_LIMIT",
            message: `Native output findings exceed bound; ${all.length - 127} findings omitted; all outputs remain blocked`,
          },
        ]
      : all;
  return PlatformAudioHandoffSchema.parse({
    ...outputs[0].result,
    localStatus: blocked || all.length > 128 ? "blocked" : "eligible-awaiting-movie",
    findings,
  });
}
