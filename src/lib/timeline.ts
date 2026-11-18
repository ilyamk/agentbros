import type { Scene } from "../types/video";

export type TimelineEntry = {
  scene: Scene;
  startFrame: number;
  durationInFrames: number;
  transitionFrames: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
};

/** Shared, deterministic timing for rendering, metadata, caption slices and QA. */
export function compileTimeline(scenes: Scene[], { fps = 30, talkingHead = false } = {}) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("fps must be positive");
  if (!scenes.length) throw new Error("Timeline requires at least one scene");
  const explicitWindows =
    talkingHead && scenes.every((s) => s.presenterStartSec !== undefined && s.presenterEndSec !== undefined);
  let cursor = 0;
  const entries: TimelineEntry[] = scenes.map((scene, index) => {
    const rawDuration = scene.durationInFrames ?? Math.round(4 * fps);
    if (!Number.isInteger(rawDuration) || rawDuration <= 0) throw new Error(`Invalid duration for ${scene.id}`);
    let transitionFrames =
      index === scenes.length - 1 || scene.transitionToNext === "cut" ? 0 : (scene.transitionDurationFrames ?? 12);
    if (!Number.isInteger(transitionFrames) || transitionFrames < 0)
      throw new Error(`Invalid transition for ${scene.id}`);
    const sourceStartFrame = explicitWindows ? Math.round(scene.presenterStartSec! * fps) : cursor;
    // Legacy projects padded source windows by the outgoing dissolve. Ownership
    // ends at the next window's start, so speech is never played twice.
    const nextStart = scenes[index + 1]?.presenterStartSec;
    if (
      explicitWindows &&
      (!Number.isFinite(scene.presenterStartSec) ||
        !Number.isFinite(scene.presenterEndSec) ||
        scene.presenterEndSec! <= scene.presenterStartSec!)
    )
      throw new Error(`Invalid presenter window for ${scene.id}`);
    const sourceEndFrame = explicitWindows
      ? Math.round(Math.min(scene.presenterEndSec!, nextStart ?? Infinity) * fps)
      : sourceStartFrame + rawDuration - (talkingHead ? transitionFrames : 0);
    const durationInFrames = explicitWindows
      ? sourceEndFrame - sourceStartFrame
      : rawDuration - (talkingHead ? transitionFrames : 0);
    if (sourceStartFrame < 0 || durationInFrames <= 0) throw new Error(`Invalid presenter window for ${scene.id}`);
    const entry = { scene, startFrame: cursor, durationInFrames, transitionFrames, sourceStartFrame, sourceEndFrame };
    cursor += durationInFrames - (talkingHead ? 0 : transitionFrames);
    return entry;
  });
  for (let i = 0; i < entries.length - 1; i++) {
    const a = entries[i],
      b = entries[i + 1];
    if (a.transitionFrames >= a.durationInFrames || a.transitionFrames >= b.durationInFrames)
      throw new Error(`Transition exceeds adjacent scene duration: ${a.scene.id}`);
  }
  return {
    entries,
    durationInFrames: cursor,
    contiguousPresenter: entries.every((e, i) => i === 0 || e.sourceStartFrame === entries[i - 1].sourceEndFrame),
  };
}
