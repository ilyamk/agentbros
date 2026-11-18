/**
 * Status vocabulary (RFC 0004 §10.1): every contract step status maps to one visual tone, and every tone has a colour
 * token and an icon, so colour is never the only signal.
 */
import type { StepStatus } from "@contract";
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  Hand,
  History,
  OctagonX,
  SkipForward,
  type LucideIcon,
} from "lucide-react";

export const TONES = [
  "done",
  "current",
  "blocked",
  "stale",
  "skipped",
  "invalid",
  "paused",
  "waiting",
  "upcoming",
] as const;
export type Tone = (typeof TONES)[number];

export const TONE_ICON: Record<Tone, LucideIcon> = {
  done: CircleCheck,
  current: CircleDot,
  blocked: Ban,
  stale: History,
  skipped: SkipForward,
  invalid: OctagonX,
  paused: CirclePause,
  waiting: Hand,
  upcoming: CircleDashed,
};

/** Text colour class of a tone (the tokens keep 4.5:1 on background, card and muted in both themes). */
export const TONE_TEXT: Record<Tone, string> = {
  done: "text-status-done",
  current: "text-status-current",
  blocked: "text-status-blocked",
  stale: "text-status-stale",
  skipped: "text-status-skipped",
  invalid: "text-status-invalid",
  paused: "text-status-paused",
  waiting: "text-status-waiting",
  upcoming: "text-muted-foreground",
};

export const TONE_BG: Record<Tone, string> = {
  done: "bg-status-done",
  current: "bg-status-current",
  blocked: "bg-status-blocked",
  stale: "bg-status-stale",
  skipped: "bg-status-skipped",
  invalid: "bg-status-invalid",
  paused: "bg-status-paused",
  waiting: "bg-status-waiting",
  upcoming: "bg-muted-foreground",
};

export const TONE_BORDER: Record<Tone, string> = {
  done: "border-status-done/50",
  current: "border-status-current/60",
  blocked: "border-status-blocked/60",
  stale: "border-status-stale/60",
  skipped: "border-status-skipped/50",
  invalid: "border-status-invalid/60",
  paused: "border-status-paused/60",
  waiting: "border-status-waiting/60",
  upcoming: "border-border",
};

/** Tone of a step status; `ready` is current on the current step and upcoming elsewhere. */
export function stepTone(status: StepStatus, isCurrent = false): Tone {
  switch (status) {
    case "done":
      return "done";
    case "skipped":
      return "skipped";
    case "blocked":
    case "failing":
      return "blocked";
    case "invalid":
      return "invalid";
    case "stale":
    case "unsealed":
      return "stale";
    case "awaiting-gate":
      return "waiting";
    case "running":
      return "current";
    case "ready":
      return isCurrent ? "current" : "upcoming";
    case "pending":
      return isCurrent ? "current" : "upcoming";
  }
}

export const CONTROL_TONE = { running: "current", paused: "paused", stopped: "blocked" } as const satisfies Record<
  string,
  Tone
>;
