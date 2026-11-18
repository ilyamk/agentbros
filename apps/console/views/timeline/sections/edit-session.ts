/**
 * The edit section's state machine (RU-T, RU-P, RU-AU, RU-K; G3–G6 of the review:ui parity checklist), read
 * with `useSyncExternalStore`. It is review:ui's main closure (selection, operation form, `#command`, the pinned
 * draft, `#dry-run`, the group selection and the live pointer drag) over the frame's controller:
 *
 * - every action runs through `controller.run` (G1/G2); client refusals are translated before they reach the status;
 * - every invalidator calls `controller.proposals.cancel()` (G4), and the cancel listener drops the draft, restores a
 *   drag and, unless only the command text was typed, clears the command (G3);
 * - late replies are checked against live values (`controller.getSnapshot()`, this session's fields), never against
 *   values captured by the handler;
 * - Apply (G5) refuses a specialized proposal whose command was edited by hand: its own checks would be skipped
 *   (parity plan defect 3). Dry run validates the edited command as a generic edit, explicitly.
 */
import { format } from "@/i18n";
import type { Widen } from "@/i18n/types";
import {
  applyProposal,
  ReviewRequestError,
  validateCommand,
  type ProposalBinding,
  type ReviewState,
  type Rational,
} from "../api";
import type { TimelineController } from "../controller";
import {
  currentClip,
  defaultFields,
  EditInputError,
  gainCommand,
  groupMoveRequest,
  isSpecialized,
  prepareRequest,
  reframeSignature,
  structuredCommand,
  toggleGroupMember,
  type ClipRef,
  type FieldValues,
  type GenericOperation,
  type Operation,
  type SpecializedOperation,
} from "./edit-commands";
import {
  passedThreshold,
  pointerCommand,
  POINTER_MESSAGES,
  previewStyle,
  type Drag,
  type LaneBox,
  type PreviewStyle,
} from "./edit-pointer";
import { editEn } from "./edit.strings";

export type EditStrings = Widen<typeof editEn>;

/** What `#dry-run` shows (G6). */
export type DryRunDisplay =
  | { kind: "empty" }
  | { kind: "message"; key: keyof typeof editEn.display }
  | { kind: "error"; message: string }
  | { kind: "result"; value: Record<string, unknown> };

/** The pinned proposal; `origin` is the specialized operation (or the group move) that prepared it. */
export interface SessionDraft {
  command: unknown;
  revision: number;
  origin?: SpecializedOperation | "group";
}

export interface EditSnapshot {
  selected?: ClipRef;
  operation: Operation;
  values: FieldValues;
  /** Bumps whenever the form is rebuilt (selection, operation, display), like review:ui `fields()`. */
  formKey: number;
  commandText: string;
  draft?: SessionDraft;
  /**
   * The command a specialized route (or the group move) prepared, kept while its text stays in `#command` even after
   * typing drops the draft: Apply refuses an edited copy of it (defect 3). A generic Dry run or a clear forgets it.
   */
  prepared?: { command: unknown; origin: SpecializedOperation | "group" };
  dryRun: DryRunDisplay;
  group: ClipRef[];
  groupNum: string;
  groupDen: string;
  /** The dragged clip and its preview (RU-T16). */
  drag?: ClipRef & { preview?: PreviewStyle };
}

type LiveDrag = Drag & { release: () => void };

export class EditSession {
  private snapshot: EditSnapshot = {
    operation: "move",
    values: {},
    formKey: 0,
    commandText: "",
    dryRun: { kind: "empty" },
    group: [],
    groupNum: "30",
    groupDen: "1",
  };
  private readonly listeners = new Set<() => void>();
  private live?: LiveDrag;
  private strings: EditStrings = editEn;
  constructor(readonly controller: TimelineController) {}

  /** Listens to the controller's cancels (G3/G4) and displays; returns the detach function (an effect's cleanup). */
  attach(): () => void {
    const off = [
      this.controller.proposals.onCancel(({ clearCommand }) => this.onCancel(clearCommand)),
      this.controller.onDisplay((state) => this.onDisplay(state)),
    ];
    return () => {
      for (const detach of off) detach();
    };
  }

  setStrings(strings: EditStrings): void {
    this.strings = strings;
  }

  readonly getSnapshot = (): EditSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<EditSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private get api() {
    return this.controller.api;
  }

  private get guard() {
    return this.controller.proposals;
  }

  /** The state the frame shows now (late-reply checks read this, never a captured copy). */
  private state(): ReviewState {
    const state = this.controller.getSnapshot().state;
    if (!state) throw new Error("Review state is not loaded");
    return state;
  }

  private revision(): number {
    const revision = this.state().revision;
    if (revision === null) throw new EditInputError("uninitialized");
    return revision;
  }

  /** The G3 binding of a specialized prepare, from live values. */
  private binding(): ProposalBinding {
    const { selected, operation, values } = this.snapshot;
    return {
      revision: this.controller.getSnapshot().state?.revision ?? null,
      trackId: selected?.trackId,
      clipId: selected?.clipId,
      operation,
      signature: operation === "visual-reframe" ? reframeSignature(values) : undefined,
    };
  }

  /** A browser refusal or a known pointer message in the current language; anything else unchanged. */
  translate(error: unknown): string {
    if (error instanceof EditInputError)
      return error.group === "unsupported"
        ? this.strings.unsupported[error.key as keyof EditStrings["unsupported"]]
        : this.strings.error[error.key as keyof EditStrings["error"]];
    const message = error instanceof Error ? error.message : String(error);
    const pointer = POINTER_MESSAGES[message];
    if (pointer) return this.strings.error[pointer];
    if (message === editEn.error.staleValidate) return this.strings.error.staleValidate;
    if (message === editEn.error.uninitialized) return this.strings.error.uninitialized;
    return message;
  }

  /** G1/G2 through the controller, with browser refusals translated. */
  run(task: () => Promise<unknown>): Promise<boolean> {
    return this.controller.run(async () => {
      try {
        await task();
      } catch (error) {
        // A server reply stays as it is (409 detection needs the class); anything else is shown translated.
        if (error instanceof ReviewRequestError) throw error;
        throw new Error(this.translate(error));
      }
    });
  }

  private stale(what: SpecializedOperation | "group"): string {
    return format(this.strings.error.stale, { what: this.strings.stale[what] });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // G3/G4: cancel and display

  private onCancel(clearCommand: boolean): void {
    const live = this.live;
    this.live = undefined;
    if (live) {
      try {
        live.release();
      } catch {
        // capture already gone
      }
    }
    this.set({
      draft: undefined,
      drag: undefined,
      ...(clearCommand
        ? { commandText: "", prepared: undefined, dryRun: { kind: "message", key: "cancelled" } as const }
        : {}),
    });
  }

  private formFor(state: ReviewState, selected: ClipRef | undefined, operation: Operation): FieldValues {
    if (!selected) return {};
    try {
      const { track, clip } = currentClip(state, selected);
      return defaultFields(operation, state, track, clip);
    } catch {
      return {};
    }
  }

  /** Every display: the selection survives only if its clip still exists; the group selection clears (RU-T03, P06). */
  private onDisplay(state: ReviewState): void {
    let selected = this.snapshot.selected;
    if (selected) {
      try {
        currentClip(state, selected);
      } catch {
        selected = undefined;
      }
    }
    this.set({
      selected,
      values: this.formFor(state, selected, this.snapshot.operation),
      formKey: this.snapshot.formKey + 1,
      group: [],
    });
  }

  /** The Cancel proposal button and Escape (RU-T19, RU-K01). */
  cancel(): void {
    this.guard.cancel();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Selection and form

  /** RU-T03: selecting a clip cancels the proposal and rebuilds the form. */
  select(ref: ClipRef): void {
    this.guard.cancel();
    this.set({
      selected: { ...ref },
      values: this.formFor(this.state(), ref, this.snapshot.operation),
      formKey: this.snapshot.formKey + 1,
    });
  }

  /** RU-T04: the picker cancels and rebuilds the fields; with no selection it reports "Select a clip first". */
  setOperation(operation: Operation): Promise<boolean> {
    this.set({ operation });
    return this.run(async () => {
      this.guard.cancel();
      const state = this.state();
      currentClip(state, this.snapshot.selected);
      this.set({ values: this.formFor(state, this.snapshot.selected, operation), formKey: this.snapshot.formKey + 1 });
    });
  }

  /** RU-K08: any input or change in the fields invalidates the proposal. */
  setField(id: string, value: string | boolean): void {
    this.set({ values: { ...this.snapshot.values, [id]: value } });
    this.guard.cancel();
  }

  /** RU-K07: typing in the command drops the draft and keeps the text. */
  setCommandText(text: string): void {
    this.set({ commandText: text });
    this.guard.cancel({ clearCommand: false });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Prepare, dry run, apply, undo, redo

  /** Generic validate (Dry run; RU-T11, T12): pins `{command, revision}` only if nothing changed meanwhile. */
  private async validate(command?: unknown, revision?: number): Promise<void> {
    const parsed = command === undefined ? JSON.parse(this.snapshot.commandText) : command;
    const { draft, validated } = await validateCommand(this.api, this.guard, revision ?? this.revision(), parsed);
    this.set({
      draft: { command: draft.command, revision: draft.revision },
      prepared: undefined,
      dryRun: {
        kind: "result",
        value: {
          revision: validated.revision,
          proposedHash: validated.timelineHash,
          durationInFrames: validated.snapshot.durationInFrames,
        },
      },
    });
  }

  dryRun(): Promise<boolean> {
    return this.run(() => this.validate());
  }

  /** `Prepare validated edit`: a specialized route, or the structured command through the generic dry-run. */
  prepare(): Promise<boolean> {
    return this.run(async () => {
      const operation = this.snapshot.operation;
      if (isSpecialized(operation)) return this.prepareSpecialized(operation);
      const command = structuredCommand(
        operation as GenericOperation,
        this.state(),
        this.snapshot.selected,
        this.snapshot.values,
      );
      this.set({ commandText: JSON.stringify(command, null, 2) });
      await this.validate(command);
    });
  }

  private async prepareSpecialized(operation: SpecializedOperation): Promise<void> {
    const state = this.state();
    const revision = this.revision();
    const request = prepareRequest(operation, state, this.snapshot.selected, this.snapshot.values);
    const binding = this.binding();
    this.guard.cancel();
    const ticket = this.guard.begin(binding);
    const result = await this.api.propose(request.route, request.body);
    this.guard.assertCurrent(ticket, this.binding(), this.stale(operation));
    this.set({
      commandText: JSON.stringify(result.command, null, 2),
      draft: { command: result.command, revision, origin: operation },
      prepared: { command: result.command, origin: operation },
      dryRun: { kind: "result", value: request.display(result) },
    });
  }

  /** `Prepare mute` / `Prepare gain reset` (RU-AU03): build and validate at once. */
  prepareGain(gain: 0 | null): Promise<boolean> {
    return this.run(async () => {
      const { track, clip } = currentClip(this.state(), this.snapshot.selected);
      const command = gainCommand({ trackId: track.id, clipId: clip.id }, gain);
      this.set({ commandText: JSON.stringify(command, null, 2) });
      await this.validate(command);
    });
  }

  /** G5 (RU-T13). */
  apply(): Promise<boolean> {
    return this.run(async () => {
      const { draft, prepared, commandText } = this.snapshot;
      if (this.live) throw new EditInputError("pointerActive");
      if (!commandText.trim()) throw new EditInputError("emptyCommand");
      if (prepared) {
        let edited = true;
        try {
          edited = JSON.stringify(JSON.parse(commandText)) !== JSON.stringify(prepared.command);
        } catch {
          // invalid JSON: applyProposal reports the parse error
          edited = false;
        }
        if (edited) {
          const operation =
            prepared.origin === "group" ? this.strings.group.legend : this.strings.operations[prepared.origin];
          throw new Error(format(this.strings.error.editedProposal, { operation }));
        }
      }
      const { state } = await applyProposal(this.api, this.guard, {
        draft: draft && { command: draft.command, revision: draft.revision },
        commandText,
        pointerActive: false,
        revision: this.state().revision,
      });
      this.controller.display(state);
      this.set({ dryRun: { kind: "message", key: "applied" } });
    });
  }

  /** RU-T14: Undo / Redo with the current revision as CAS. */
  history(action: "undo" | "redo"): Promise<boolean> {
    return this.run(async () => {
      this.controller.display(await this.api.mutate({ action, expectedRevision: this.revision() }));
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // RU-P06: group move

  toggleGroup(member: ClipRef, checked: boolean): void {
    this.guard.cancel();
    try {
      this.set({ group: toggleGroupMember(this.snapshot.group, member, checked) });
    } catch (error) {
      this.controller.setStatus({ kind: "error", message: this.translate(error) });
    }
  }

  setGroupDelta(part: "num" | "den", value: string): void {
    this.set(part === "num" ? { groupNum: value } : { groupDen: value });
    this.guard.cancel();
  }

  clearGroup(): void {
    this.guard.cancel();
    this.set({ group: [] });
  }

  prepareGroup(): Promise<boolean> {
    return this.run(async () => {
      const revision = this.revision();
      const { body, signature } = groupMoveRequest(
        this.snapshot.group,
        this.snapshot.groupNum,
        this.snapshot.groupDen,
        revision,
      );
      const members = (body.members as unknown[]).length;
      this.guard.cancel();
      const ticket = this.guard.begin({ revision, signature });
      const result = await this.api.propose("group-move-proposal", body);
      const now = {
        revision: this.controller.getSnapshot().state?.revision ?? null,
        signature: JSON.stringify(this.snapshot.group),
      };
      this.guard.assertCurrent(ticket, now, this.stale("group"));
      this.set({
        commandText: JSON.stringify(result.command, null, 2),
        draft: { command: result.command, revision, origin: "group" },
        prepared: { command: result.command, origin: "group" },
        dryRun: {
          kind: "result",
          value: {
            revision: result.revision,
            proposedHash: result.timelineHash,
            durationInFrames: result.snapshot.durationInFrames,
            groupMembers: members,
          },
        },
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // RU-T16–T18, RU-K03–K06: pointer

  get pointerActive(): boolean {
    return this.live !== undefined;
  }

  /** Primary-button press on a visual clip or one of its edges: selects it and starts a (not yet moved) drag. */
  pointerDown(input: {
    ref: ClipRef;
    mode: Drag["mode"];
    pointerId: number;
    x: number;
    y: number;
    grabFrames: number;
    release: () => void;
  }): boolean {
    const state = this.controller.getSnapshot().state;
    if (!state || state.revision === null || !state.timebase) return false;
    this.guard.cancel();
    this.select(input.ref);
    const { track, clip } = currentClip(state, input.ref);
    this.live = {
      pointerId: input.pointerId,
      mode: input.mode,
      track,
      clip,
      x: input.x,
      y: input.y,
      grabFrames: input.grabFrames,
      revision: state.revision,
      duration: state.durationInFrames,
      timebase: state.timebase as Rational,
      moved: false,
      release: input.release,
    };
    return true;
  }

  pointerMove(pointerId: number, x: number, y: number, lanes: readonly LaneBox[]): void {
    const drag = this.live;
    if (!drag || drag.pointerId !== pointerId) return;
    drag.moved ||= passedThreshold(drag, x, y);
    if (!drag.moved) return;
    try {
      const command = pointerCommand(drag, x, y, lanes);
      this.set({
        drag: { trackId: drag.track.id, clipId: drag.clip.id, preview: previewStyle(drag, command, lanes) },
        dryRun: { kind: "message", key: "pointerPreview" },
      });
    } catch (error) {
      this.set({ dryRun: { kind: "error", message: this.translate(error) } });
    }
  }

  /** Release: cancels the drag, then (if it moved) validates the proposal with a dry-run only, never Apply. */
  pointerUp(pointerId: number, x: number, y: number, lanes: readonly LaneBox[]): boolean {
    const drag = this.live;
    if (!drag || drag.pointerId !== pointerId) return false;
    this.guard.cancel();
    if (!drag.moved) return false;
    void this.run(async () => {
      const command = pointerCommand(drag, x, y, lanes);
      this.set({ commandText: JSON.stringify(command, null, 2) });
      await this.validate(command, drag.revision);
    });
    return true;
  }

  /** `pointercancel`, `lostpointercapture` (for the live pointer only). */
  pointerCancel(pointerId?: number): void {
    if (this.live && (pointerId === undefined || this.live.pointerId === pointerId)) this.guard.cancel();
  }
}

/** What every part of the edit section receives. */
export interface EditPartProps {
  state: ReviewState;
  api: import("../api").ReviewApi;
  session: EditSession;
  snap: EditSnapshot;
  t: EditStrings;
}
