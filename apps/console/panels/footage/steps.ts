/**
 * Footage panels by footage:next step (RFC 0004 §5.2, US19). Step ids are footage:next's `STEP` ids
 * (src/lib/footage/next.ts); the when, weight and collapse rules are the shared ones of ../groups.ts.
 */
import type { FootageMaterial, ProjectView } from "@contract";
import { groupHelpers } from "../groups";

export const FOOTAGE_GROUPS = {
  source: ["setup", "0-source"],
  transcript: ["1-transcript", "1-speech-mask", "2-shots"],
  plan: ["3-recut-plan", "4-approve", "4-create"],
  captions: ["5-captions"],
  shorts: ["6-shorts"],
  cameras: ["7-cameras"],
  reframe: ["8-reframe"],
  render: ["9-render", "done"],
} as const satisfies Record<string, readonly string[]>;

export type FootageGroup = keyof typeof FOOTAGE_GROUPS;

const footage = groupHelpers<FootageGroup>(FOOTAGE_GROUPS);

export const FOOTAGE_GROUP_ORDER = footage.order;
export const {
  groupSteps: footageGroupSteps,
  groupDecisions: footageGroupDecisions,
  isCurrentGroup: isCurrentFootageGroup,
  isWaitingGroup: isWaitingFootageGroup,
  isReached: isFootageGroupReached,
  leadStep: footageLeadStep,
  groupWeight: footageGroupWeight,
  groupCollapsed: footageGroupCollapsed,
} = footage;

/** The view's footage material, or an empty object (every section optional). */
export const material = (view: ProjectView): FootageMaterial => view.footage ?? {};

/** Seconds as `m:ss.s` (cuts and words need tenths). */
export function secClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const tenths = Math.round(safe * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
