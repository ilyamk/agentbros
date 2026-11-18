import { SceneSchema } from "../../types/video";
import { AuthoredCopyCommandSchema, type AuthoredCopyCommand } from "../../types/authored-copy";
import type { TimelineIR, TimelineClip } from "../../types/timeline";
/** Structural authority only; project routes separately enforce source-owned workflow refusal. */
export function authoredCopyTarget(
  ir: TimelineIR,
  trackId: string,
  clipId: string,
  target: AuthoredCopyCommand["target"],
) {
  const track = ir.tracks.find((t) => t.id === trackId),
    clip = track?.clips.find((c) => c.id === clipId);
  if (track?.kind !== "visual" || !clip) throw Error("Authored copy requires an existing visual scene");
  if (
    ir.tracks.some((t) => t.kind === "presenter") ||
    (ir.legacyProject?.talkingHead as { enabled?: unknown } | undefined)?.enabled === true
  )
    throw Error("Authored copy refuses talking-head scenes");
  if (
    ir.legacyProject &&
    (ir.legacyProject.educational === true ||
      ["claims", "declaredClaims", "facts", "recipe"].some((key) => Object.hasOwn(ir.legacyProject!, key)))
  )
    throw Error("Authored copy refuses declared factual/educational/recipe snapshots");
  const scene = SceneSchema.parse(clip.payload?.scene),
    raw = clip.payload!.scene as Record<string, unknown>;
  if (
    clip.assetId !== `scene:${scene.id}` ||
    scene.leftPanel ||
    scene.imageUrl !== undefined ||
    scene.presenterStartSec !== undefined ||
    scene.presenterEndSec !== undefined
  )
    throw Error("Authored copy refuses media/proof/presenter scenes");
  for (const key of [
    "claims",
    "declaredClaims",
    "facts",
    "claimIds",
    "factualClaims",
    "sourceLabel",
    "sourceLabels",
    "evidence",
    "declarations",
  ])
    if (Object.hasOwn(raw, key) || Object.hasOwn(clip.payload!, key))
      throw Error("Authored copy refuses factual/source declarations");
  if (target === "legacy") {
    if (scene.template || !["title", "feature", "product", "cta"].includes(scene.visualType))
      throw Error("Unsupported legacy copy scene");
    return raw;
  }
  if (scene.visualType !== "title" || scene.template?.id !== "scene.hook" || scene.template.version !== 1)
    throw Error("Authored copy requires exact scene.hook v1 title");
  return (raw.template as { props: Record<string, unknown> }).props;
}
export function patchAuthoredCopy(ir: TimelineIR, clip: TimelineClip, command: AuthoredCopyCommand) {
  const checked = AuthoredCopyCommandSchema.parse(command),
    target = authoredCopyTarget(ir, checked.trackId, checked.clipId, checked.target);
  if (checked.headline !== undefined) target.headline = checked.headline;
  if (checked.subtext === null) delete target.subtext;
  else if (checked.subtext !== undefined) target.subtext = checked.subtext;
  SceneSchema.parse(clip.payload!.scene);
}
