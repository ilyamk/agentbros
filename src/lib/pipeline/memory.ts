/** The user's memory as next-step answers read it: from memory/index.json while it is fresh, else from the entry files. Reads only. */
import { loadMemory, queryMemory, readFreshIndex, type MemoryQuery, type PreloadedEntry } from "../memory";
import type { MemoryRef } from "../../types/memory";

export type MemoryStore = { entries: PreloadedEntry[]; warnings: string[]; fromIndex: boolean };

/** A step value no scope can hold (scope steps are lower-case ids and digits), so only entries scoped to no step match. */
export const NO_STEP = "(none)";

/** index.json while its per-file fingerprints match (readFreshIndex); otherwise loadMemory. Never writes: a stale index waits for `pnpm memory --reindex`. */
export function loadMemoryFast(root?: string): MemoryStore {
  const fresh = readFreshIndex(root);
  return fresh ? { ...fresh, fromIndex: true } : { ...loadMemory(root), fromIndex: false };
}

/** memoryFor over a loaded store: the bound playbook, the step (NO_STEP when unknown), the platform when known and the project (entries of another project are left out). */
export function scopedMemory(
  store: MemoryStore,
  ctx: { playbook: string; step?: string; platform?: string; project?: string },
  root?: string,
  narrow: Pick<MemoryQuery, "types" | "limit" | "maxChars"> = {},
): MemoryRef[] {
  return queryMemory({ ...ctx, step: ctx.step ?? NO_STEP, ...narrow }, root, store.entries);
}

// --- Capture hints ---

/** When a next-step answer stands where the user's words or a delivery should be recorded. */
export type CaptureMoment = "verdict" | "choice" | "rejection" | "delivery";

/** `capture`: ready-to-fill `pnpm memory` templates for this moment, never pre-filled with guessed words. */
export type Capture = { moment: CaptureMoment; hint: string; commands: string[] };

/** `measured`: the passed delivery report a delivery episode cites. */
export type CaptureScope = { project: string; playbook?: string; step?: string; platform?: string; measured?: string };

const CAPTURE_RULE =
  "record only the user's own words; acceptance without words is an episode, not a lesson. Leaf agents propose; the orchestrator writes.";

const CAPTURE_HINTS: Record<CaptureMoment, string> = {
  verdict: `At the user's answer, ${CAPTURE_RULE}`,
  choice: `If the choice should hold for later films, ${CAPTURE_RULE}`,
  rejection: `Query first: a matching observation or gap gets --seen, a matching lesson nothing new; otherwise ${CAPTURE_RULE}`,
  delivery: "Delivered: one measured episode per project (query first; skip it if one exists), then consolidate.",
};

/** The capture field of a next-step answer, scoped to the flags that are known (an unbound project gets no --playbook). */
export function captureFor(moment: CaptureMoment, scope: CaptureScope): Capture {
  const playbook = scope.playbook ? ` --playbook ${scope.playbook}` : "";
  const step = scope.step ? ` --step ${scope.step}` : "";
  const platform = scope.platform ? ` --platform ${scope.platform}` : "";
  const add = (types: string) =>
    `pnpm memory --add --type ${types} --summary "<one line, no brand>" --quote "<the user's words>"${playbook}${step}${platform}`;
  const commands: Record<CaptureMoment, string[]> = {
    verdict: [add("<decision|preference|lesson>")],
    choice: [add("<decision|preference>")],
    rejection: [
      `pnpm memory --query "<what was rejected>"${playbook}${step}`,
      `pnpm memory --seen <observation or gap id> --evidence "<the user's words>"`,
      add("lesson"),
    ],
    delivery: [
      `pnpm memory --query "<film>" --type episode --project ${scope.project}`,
      `pnpm memory --add --type episode --summary "<one line, no brand>" --measured "${scope.measured ?? "<delivery check report>"}" --project ${scope.project}${playbook}${platform}`,
      "pnpm memory --consolidate",
    ],
  };
  return { moment, hint: CAPTURE_HINTS[moment], commands: commands[moment] };
}
