/**
 * The timeline view's shared state (RFC 0004 WP13): the review state, the status line (G1/G2) and the proposal guard
 * (G3/G4), read with `useSyncExternalStore`. Sections keep their own form state and subscribe to
 * `proposals.onCancel` (drop drafts) and `onDisplay` (every refresh, apply, undo, redo or snapshot: clear group
 * selections, invalidate chapter inspection).
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import { ProposalGuard, ReviewApi, runReviewTask, type ReviewState, type ReviewStatus } from "./api";

export interface TimelineSnapshot {
  load: "loading" | "ready" | "error";
  state?: ReviewState;
  /** The first load's failure (the status line shows later ones). */
  loadError?: { message: string; code: string; status?: number };
  status: ReviewStatus;
  /** Counts `display()` calls; sections key derived state on it. */
  displayed: number;
}

export class TimelineController {
  readonly proposals = new ProposalGuard();
  private snapshot: TimelineSnapshot = { load: "loading", status: { kind: "idle" }, displayed: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly displayListeners = new Set<(state: ReviewState) => void>();

  constructor(readonly api: ReviewApi) {}

  readonly getSnapshot = (): TimelineSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<TimelineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  setStatus = (status: ReviewStatus): void => this.set({ status });

  /** Called after every state change; invalidates proposals first (G4). */
  onDisplay(listener: (state: ReviewState) => void): () => void {
    this.displayListeners.add(listener);
    return () => this.displayListeners.delete(listener);
  }

  /** Shows a state the server returned (state, mutate). Cancels every proposal (G4). */
  display(state: ReviewState): void {
    this.proposals.cancel();
    this.set({ state, load: "ready", loadError: undefined, displayed: this.snapshot.displayed + 1 });
    for (const listener of [...this.displayListeners]) listener(state);
  }

  /** Re-reads state (Refresh, G2). Proposals are cancelled even when the read fails. */
  async refresh(): Promise<void> {
    this.proposals.cancel();
    this.display(await this.api.state());
  }

  /** First load: an error is kept as `loadError` instead of the status line. */
  async load(): Promise<void> {
    this.set({ load: "loading" });
    try {
      this.display(await this.api.state());
    } catch (error) {
      const failure = error as { message?: string; code?: string; status?: number };
      this.set({
        load: "error",
        loadError: {
          message: failure.message ?? String(error),
          code: failure.code ?? "NETWORK",
          status: failure.status,
        },
      });
    }
  }

  /** G1/G2: every user action goes through here. Resolves true on success; never throws. */
  run(task: () => Promise<unknown>): Promise<boolean> {
    return runReviewTask(task, { setStatus: this.setStatus, onConflict: () => this.refresh() });
  }
}

export const TimelineContext = createContext<TimelineController | undefined>(undefined);

export function useTimelineController(): TimelineController {
  const controller = useContext(TimelineContext);
  if (!controller) throw new Error("useTimelineController outside <TimelineView>");
  return controller;
}

export function useTimeline(): TimelineSnapshot {
  const controller = useTimelineController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
