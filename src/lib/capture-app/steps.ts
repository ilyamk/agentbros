import { z } from "zod";

const when = {
  /** Frame the step starts on. Give this or `time`. */
  at: z.number().int().min(0).optional(),
  /** Seconds the step starts at; converted to the nearest frame. */
  time: z.number().min(0).optional(),
};

export const captureStepSchema = z
  .discriminatedUnion("action", [
    z.object({ ...when, action: z.literal("navigate"), url: z.string().min(1) }),
    z.object({ ...when, action: z.literal("click"), selector: z.string().min(1) }),
    z.object({ ...when, action: z.literal("hover"), selector: z.string().min(1) }),
    z.object({
      ...when,
      action: z.literal("type"),
      text: z.string().min(1),
      selector: z.string().min(1).optional(),
      framesPerChar: z.number().int().min(1).default(2),
    }),
    z.object({ ...when, action: z.literal("key"), key: z.string().min(1) }),
    z.object({
      ...when,
      action: z.literal("scroll"),
      dy: z.number(),
      selector: z.string().min(1).optional(),
      durationFrames: z.number().int().min(1).default(20),
    }),
    z.object({ ...when, action: z.literal("wait") }),
  ])
  .refine((step) => (step.at === undefined) !== (step.time === undefined), {
    message: "Each step needs exactly one of `at` (frame) or `time` (seconds)",
  });

export const captureScriptSchema = z.object({ steps: z.array(captureStepSchema) });

export type CaptureStep = z.infer<typeof captureStepSchema>;

/** One thing to do on one frame, before that frame's time advances. */
export type FrameAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "hover"; selector: string }
  | { kind: "focus"; selector: string }
  | { kind: "char"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dy: number; selector?: string };

export const stepFrame = (step: CaptureStep, fps: number) => step.at ?? Math.round((step.time ?? 0) * fps);

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Expands the steps into per-frame actions: typing becomes one character per `framesPerChar`, scrolling an eased series of deltas. */
export const planFrames = (steps: CaptureStep[], fps: number, frames: number): Map<number, FrameAction[]> => {
  const plan = new Map<number, FrameAction[]>();
  const add = (frame: number, action: FrameAction) => {
    if (frame >= frames) return;
    plan.set(frame, [...(plan.get(frame) ?? []), action]);
  };
  for (const step of steps) {
    const start = stepFrame(step, fps);
    switch (step.action) {
      case "navigate":
        add(start, { kind: "navigate", url: step.url });
        break;
      case "click":
      case "hover":
        add(start, { kind: step.action, selector: step.selector });
        break;
      case "key":
        add(start, { kind: "key", key: step.key });
        break;
      case "type":
        if (step.selector) add(start, { kind: "focus", selector: step.selector });
        [...step.text].forEach((char, i) => add(start + i * step.framesPerChar, { kind: "char", text: char }));
        break;
      case "scroll": {
        let done = 0;
        for (let i = 1; i <= step.durationFrames; i++) {
          const target = Math.round(step.dy * easeInOut(i / step.durationFrames));
          if (target !== done) add(start + i - 1, { kind: "scroll", dy: target - done, selector: step.selector });
          done = target;
        }
        break;
      }
      case "wait":
        break;
    }
  }
  return plan;
};
