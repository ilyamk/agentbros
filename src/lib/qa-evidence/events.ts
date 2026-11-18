import { compileTimeline } from "../timeline";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { renderBoundary } from "../timeline-ir/render";
import type { ProjectVideoProps } from "../project-props";
export type EvidenceEvent = { frame: number; reasons: string[] };
export function planEvidenceEvents(
  props: ProjectVideoProps,
  fps = 30,
): { durationInFrames: number; events: EvidenceEvent[] } {
  const frames = new Map<number, Set<string>>();
  let durationInFrames = 0;
  const add = (frame: number, reason: string) => {
    frame = Math.max(0, Math.min(durationInFrames - 1, Math.round(frame)));
    if (!frames.has(frame)) frames.set(frame, new Set());
    frames.get(frame)!.add(reason);
  };
  if (props.timeline) {
    const compiled = compileTimelineIR(props.timeline);
    durationInFrames = renderBoundary(compiled.duration, compiled.timebase, fps);
    for (const track of compiled.tracks)
      for (const clip of track.clips) {
        const start = renderBoundary(clip.start, compiled.timebase, fps),
          end = renderBoundary(clip.end, compiled.timebase, fps);
        add(start, `${track.id}/${clip.id}:start`);
        add(end - 1, `${track.id}/${clip.id}:end`);
        if (props.captionsEnabled !== false)
          for (const word of clip.captions) {
            const startWord = renderBoundary(word.start, compiled.timebase, fps),
              endWord = renderBoundary(word.end, compiled.timebase, fps);
            add(startWord, `${clip.id}/${word.id}:caption-start`);
            add(Math.floor((startWord + endWord) / 2), `${clip.id}/${word.id}:caption-active`);
          }
        if (clip.transition.kind === "fade") {
          const fade = renderBoundary(clip.transition.duration, compiled.timebase, fps);
          for (const offset of [0, Math.floor(fade / 2), fade - 1]) add(end + offset, `${clip.id}:transition`);
        }
        if (track.kind === "visual") add(start + Math.min(30, Math.floor((end - start) / 2)), `${clip.id}:reveal-hold`);
        add(Math.max(start, end - 10), `${clip.id}:final-reveal-hold`);
      }
  } else {
    const compiled = compileTimeline(props.scenes, {
      fps,
      talkingHead: !!props.talkingHead?.enabled,
    });
    durationInFrames = compiled.durationInFrames;
    for (const e of compiled.entries) {
      if (props.captionsEnabled !== false && e.scene.template && "words" in e.scene.template.props)
        for (const word of e.scene.template.props.words)
          add(e.startFrame + Math.round(((word.start + word.end) * fps) / 2), `${e.scene.id}:caption-active`);
      add(e.startFrame, `${e.scene.id}:start`);
      add(e.startFrame + e.durationInFrames - 1, `${e.scene.id}:end`);
      add(e.startFrame + Math.min(30, Math.floor(e.durationInFrames / 2)), `${e.scene.id}:reveal-hold`);
      add(e.startFrame + Math.max(0, e.durationInFrames - 10), `${e.scene.id}:final-reveal-hold`);
      if (e.scene.visualType === "cta" || e.scene.id === "cta")
        add(e.startFrame + Math.floor(e.durationInFrames / 2), `${e.scene.id}:cta`);
      if (e.transitionFrames)
        for (const offset of [0, Math.floor(e.transitionFrames / 2), e.transitionFrames - 1])
          add(
            e.startFrame + e.durationInFrames - (props.talkingHead?.enabled ? 0 : e.transitionFrames) + offset,
            `${e.scene.id}:transition`,
          );
    }
  }
  add(0, "first");
  add(durationInFrames - 1, "last");
  return {
    durationInFrames,
    events: [...frames].sort(([a], [b]) => a - b).map(([frame, reasons]) => ({ frame, reasons: [...reasons] })),
  };
}
