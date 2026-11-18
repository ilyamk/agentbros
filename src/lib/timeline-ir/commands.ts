import { patchAuthoredCopy } from "./authored-copy";
import { EditCommandSchema, VisualReframesSchema, type EditCommand, type TimelineIR } from "../../types/timeline";
import { validateTimeline, clipDuration, outputToSource, compileTimelineIR } from "./compiler";
import { add, sub, compare, fraction } from "./rational";
import { replaceSpeechOnTimeline } from "./speech-replacement";

const PLAIN_VISUAL_KEYS = ["originalHash", "reframe"];
const RECORDING_PICTURE_KEYS = [...PLAIN_VISUAL_KEYS, "volume", "sourceHash", "editHash", "transform"];
/**
 * Payloads a crop can be set on: a plain visual, or a recording-edit picture clip (`sourceHash`, `editHash`,
 * `volume`, and a punch-in `transform`, which scales the cropped frame about its centre). Everything else is authored.
 */
export function reframeablePayload(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return true;
  const keys = Object.keys(payload);
  if (keys.every((key) => PLAIN_VISUAL_KEYS.includes(key))) return true;
  if (
    typeof payload.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.sourceHash) ||
    typeof payload.editHash !== "string" ||
    !keys.every((key) => RECORDING_PICTURE_KEYS.includes(key))
  )
    return false;
  const transform = payload.transform;
  if (transform === undefined) return true;
  return (
    !!transform &&
    typeof transform === "object" &&
    Object.entries(transform).every(
      ([key, value]) =>
        ["scale", "x", "y", "rotation"].includes(key) && typeof value === "number" && Number.isFinite(value),
    )
  );
}

type OverlayCommand = Extract<EditCommand, { type: "add-overlay" | "update-overlay" | "remove-overlay" }>;
/** Overlays never move with other edits; an empty list is removed so the timeline hashes as one that never had any. */
function editOverlay(ir: TimelineIR, cmd: OverlayCommand) {
  const overlays = ir.overlays ?? [];
  if (cmd.type === "add-overlay") {
    if (overlays.some((overlay) => overlay.id === cmd.overlay.id))
      throw new Error(`Overlay already exists: ${cmd.overlay.id}`);
    ir.overlays = [...overlays, structuredClone(cmd.overlay)];
    return;
  }
  const index = overlays.findIndex((overlay) => overlay.id === cmd.overlayId);
  if (index < 0) throw new Error(`Overlay not found: ${cmd.overlayId}`);
  if (cmd.type === "remove-overlay") {
    overlays.splice(index, 1);
    if (overlays.length) ir.overlays = overlays;
    else delete ir.overlays;
    return;
  }
  const { type: _type, overlayId: _id, ...changes } = cmd;
  const next = { ...overlays[index]!, ...structuredClone(changes) };
  if (changes.block !== undefined && changes.block !== overlays[index]!.block) delete next.offset;
  overlays[index] = next;
}

/** Transactional reducer: input is never mutated; batches validate only after all edits. */
export function applyEdit(input: unknown, rawCommand: unknown): TimelineIR {
  const ir = structuredClone(validateTimeline(input));
  const command = EditCommandSchema.parse(rawCommand);
  const hasRemoval = (cmd: EditCommand): boolean =>
    cmd.type === "remove-visual" || (cmd.type === "batch" && cmd.commands.some(hasRemoval));
  const placedOverlays = new Set<string>();
  let removedVisual = false;
  const initialDuration = hasRemoval(command) ? compileTimelineIR(ir).duration : undefined;
  const execute = (cmd: EditCommand): void => {
    if (cmd.type === "batch") {
      cmd.commands.forEach(execute);
      return;
    }
    if (cmd.type === "add-track") {
      if (ir.tracks.some((track) => track.id === cmd.track.id)) throw new Error("Track already exists");
      ir.tracks.push(structuredClone(cmd.track));
      return;
    }
    if (cmd.type === "caption-style") {
      if (cmd.style) ir.captionStyle = cmd.style;
      else delete ir.captionStyle;
      return;
    }
    if (cmd.type === "add-overlay" || cmd.type === "update-overlay" || cmd.type === "remove-overlay") {
      editOverlay(ir, cmd);
      if (cmd.type === "remove-overlay") placedOverlays.delete(cmd.overlayId);
      else placedOverlays.add(cmd.type === "add-overlay" ? cmd.overlay.id : cmd.overlayId);
      return;
    }
    const track = ir.tracks.find((t) => t.id === cmd.trackId);
    if (!track) throw new Error(`Track not found: ${cmd.trackId}`);
    if (cmd.type === "ripple") {
      if (compare(cmd.from, fraction(0)) < 0) throw new Error("Ripple origin must be nonnegative");
      track.clips.forEach((clip) => {
        if (compare(clip.start, cmd.from) >= 0) clip.start = add(clip.start, cmd.delta);
      });
      return;
    }
    const clip = track.clips.find((c) => c.id === cmd.clipId);
    if (!clip) throw new Error(`Clip not found: ${cmd.clipId}`);
    switch (cmd.type) {
      case "speech-replacement":
        replaceSpeechOnTimeline(ir, track, clip, cmd);
        break;
      case "authored-copy":
        patchAuthoredCopy(ir, clip, cmd);
        break;
      case "reframe-visual": {
        if (track.kind !== "visual") throw Error("Reframe supports visual tracks only");
        const legacy = ir.legacyProject?.talkingHead;
        if (legacy && typeof legacy === "object" && (legacy as { enabled?: unknown }).enabled === true)
          throw Error("Reframe does not support talking-head layouts");
        if (clip.captions.length) throw Error("Reframe refuses caption-bearing clips");
        if (clip.assetId.startsWith("scene:") || !reframeablePayload(clip.payload))
          throw Error("Reframe requires plain visual without authored payload/transform");
        if (
          clip.payload?.originalHash !== undefined &&
          (typeof clip.payload.originalHash !== "string" || !/^[a-f0-9]{64}$/.test(clip.payload.originalHash))
        )
          throw Error("Reframe original metadata checksum unavailable");
        const ordered = [...track.clips].sort((a, b) => compare(a.start, b.start)),
          prior = ordered[ordered.indexOf(clip) - 1];
        if (clip.transition.kind !== "cut" || prior?.transition.kind === "fade")
          throw Error("Reframe cannot retarget attached fades");
        const positions = VisualReframesSchema.parse(clip.payload?.reframe ?? {});
        if (cmd.position === null) {
          delete positions[cmd.format];
          if (Object.keys(positions).length) clip.payload = { ...clip.payload, reframe: positions };
          else if (clip.payload) delete clip.payload.reframe;
        } else clip.payload = { ...clip.payload, reframe: { ...positions, [cmd.format]: cmd.position } };
        break;
      }
      case "remove-visual": {
        if (track.kind !== "visual") throw Error("Visual remove supports visual tracks only");
        const legacy = ir.legacyProject?.talkingHead;
        if (legacy && typeof legacy === "object" && (legacy as { enabled?: unknown }).enabled === true)
          throw Error("Visual remove does not support talking-head layouts");
        if (clip.captions.length) throw Error("Visual remove refuses caption-bearing clips");
        if (
          clip.assetId.startsWith("scene:") ||
          (clip.payload && Object.keys(clip.payload).some((key) => !["originalHash", "reframe"].includes(key)))
        )
          throw Error("Visual remove requires a plain visual without authored animation/payload");
        if (
          clip.payload?.originalHash !== undefined &&
          (typeof clip.payload.originalHash !== "string" || !/^[a-f0-9]{64}$/.test(clip.payload.originalHash))
        )
          throw Error("Visual remove original metadata checksum unavailable");
        const ordered = [...track.clips].sort((a, b) => compare(a.start, b.start)),
          prior = ordered[ordered.indexOf(clip) - 1];
        if (clip.transition.kind !== "cut" || prior?.transition.kind === "fade")
          throw Error("Visual remove cannot discard attached fades");
        track.clips.splice(track.clips.indexOf(clip), 1);
        removedVisual = true;
        break;
      }
      case "trim":
        if (compare(cmd.start, clip.source.start) < 0 || compare(cmd.end, clip.source.end) > 0)
          throw new Error("Trim cannot extend source; use replace");
        clip.source = { ...clip.source, start: cmd.start, end: cmd.end };
        break;
      case "transfer": {
        const target = ir.tracks.find((t) => t.id === cmd.targetTrackId);
        if (!target) throw new Error(`Target track not found: ${cmd.targetTrackId}`);
        if (target === track) throw new Error("Transfer requires a different target track");
        if (track.kind !== "visual" || target.kind !== "visual")
          throw new Error("Transfer supports visual tracks only");
        if (target.clips.some((c) => c.id === clip.id))
          throw new Error("Transfer clip ID already exists on target track");
        const ordered = [...track.clips].sort((a, b) => compare(a.start, b.start));
        const prior = ordered[ordered.indexOf(clip) - 1];
        if (clip.transition.kind !== "cut" || prior?.transition.kind === "fade")
          throw new Error("Transfer cannot retarget an attached fade; explicitly edit transitions first");
        track.clips.splice(track.clips.indexOf(clip), 1);
        clip.start = cmd.start;
        target.clips.push(clip);
        break;
      }
      case "audio-gain":
      case "audio-loop": {
        if (track.kind !== "music" && track.kind !== "sfx")
          throw new Error("Audio mix edits support music/SFX tracks only");
        if (cmd.type === "audio-loop" && cmd.loop === true && clip.source.start.num !== 0)
          throw new Error(
            "Loop edits require zero source origin; nonzero trimmed loops differ between playback and the local mixer",
          );
        const key = cmd.type === "audio-gain" ? "audioGain" : "loop";
        const value = cmd.type === "audio-gain" ? cmd.gain : cmd.loop;
        if (value === null) {
          if (clip.payload) delete clip.payload[key];
        } else clip.payload = { ...clip.payload, [key]: value };
        break;
      }
      case "move":
        clip.start = cmd.start;
        break;
      case "replace":
        clip.assetId = cmd.assetId;
        clip.source = cmd.source;
        if (cmd.vizRenderVariants) clip.payload = { ...clip.payload, vizRenderVariants: cmd.vizRenderVariants };
        else if (clip.payload?.vizRenderVariants) delete clip.payload.vizRenderVariants;
        if (cmd.vizBinding) clip.payload = { ...clip.payload, vizBinding: cmd.vizBinding };
        else if (clip.payload?.vizBinding) {
          delete clip.payload.vizBinding;
          if (!Object.keys(clip.payload).length) delete clip.payload;
        }
        clip.captions = [];
        break;
      case "rate":
        clip.rate = cmd.rate;
        break;
      case "transition":
        clip.transition = cmd.transition;
        break;
      case "captions":
        clip.captions = cmd.captions;
        break;
      case "split": {
        if (clip.payload?.reframe !== undefined) {
          VisualReframesSchema.parse(clip.payload.reframe);
          if (
            track.kind !== "visual" ||
            clip.assetId.startsWith("scene:") ||
            clip.captions.length ||
            !reframeablePayload(clip.payload)
          )
            throw Error("Reframed split requires a plain visual without captions/authored payload");
          const legacy = ir.legacyProject?.talkingHead;
          if (legacy && typeof legacy === "object" && (legacy as { enabled?: unknown }).enabled === true)
            throw Error("Reframed split does not support talking-head layouts");
          if (
            clip.payload.originalHash !== undefined &&
            (typeof clip.payload.originalHash !== "string" || !/^[a-f0-9]{64}$/.test(clip.payload.originalHash))
          )
            throw Error("Reframed split original metadata checksum unavailable");
          const ordered = [...track.clips].sort((a, b) => compare(a.start, b.start)),
            prior = ordered[ordered.indexOf(clip) - 1];
          if (clip.transition.kind !== "cut" || prior?.transition.kind === "fade")
            throw Error("Reframed split requires no attached fades");
        }
        const end = add(clip.start, clipDuration(clip, ir.timebase));
        if (compare(cmd.at, clip.start) <= 0 || compare(cmd.at, end) >= 0)
          throw new Error("Split must be inside clip output interval");
        if (track.clips.some((c) => c.id === cmd.newClipId)) throw new Error("Split ID already exists");
        const sourceFrame = outputToSource(clip, cmd.at, ir.timebase);
        const right = structuredClone(clip);
        right.id = cmd.newClipId;
        right.start = cmd.at;
        right.source.start = sourceFrame;
        clip.source.end = sourceFrame;
        clip.transition = { kind: "cut" };
        track.clips.push(right);
        break;
      }
    }
  };
  execute(command);
  const result = validateTimeline(ir);
  if (placedOverlays.size) {
    const duration = compileTimelineIR(result).duration;
    for (const overlay of result.overlays ?? [])
      if (placedOverlays.has(overlay.id) && compare(overlay.end, duration) > 0)
        throw Error(`Overlay ${overlay.id} ends after the timeline`);
  }
  if (removedVisual && compare(initialDuration!, compileTimelineIR(result).duration) !== 0)
    throw Error("Visual remove must preserve the exact final timeline duration; gap only, no ripple");
  return result;
}
