/**
 * State machine of the timeline's offline realtime editor (RU-R, RU-RC, RU-RS), a port of review:ui's
 * `realtime-client.ts` closure and `realtime-still-client.ts` without the DOM: React reads {@link RealtimeSnapshot}
 * through `subscribe`/`getSnapshot` and passes form values into the action methods.
 *
 * Rules kept from review:ui:
 * - Every mutation is sent once (HTTP, or the open local channel for the channel's actions), then one read-only
 *   refresh; nothing is ever re-sent (RU-R). Errors show the server's message plus "no automatic replay".
 * - Reads are single-flight and epoch-guarded; a late reply after a stop, an editor change or a hidden page is dropped.
 * - The background re-read runs every 2.5 s only while the panel is open, the page visible and no channel is active
 *   or busy (RU-R03). Panel toggle, editor change, Refresh, visibility change, page hide and unmount close the channel.
 * - The channel is `createReviewChannelClient` unchanged over `api.channelTransport()` (ticket in the subprotocol,
 *   never in the URL); each reply is authenticated against a fresh channel-state + view readback (RU-RC04).
 * - The still form keeps its own epoch and pinned context; any identity change discards it (RU-RS03).
 *
 * Fixes over review:ui: `reconcile` is sent only over the open channel (it has no HTTP route, plan "dead" item 6), and
 * an HTTP-only action is refused while the channel is active instead of being sent to the channel schema.
 */
import { createReviewChannelClient, type ChannelTicket, type ReviewApi } from "../api";
import {
  byteLength,
  checkStillListing,
  derivePatch,
  derivePrefill,
  disabledMatrix,
  editorSummary,
  HTTP_ONLY_ACTIONS,
  MAX_INLINE_REQUEST_BYTES,
  MAX_STILL_PAYLOAD_BYTES,
  POLL_MS,
  positiveBound,
  stillIdentity,
  stillPayload,
  type ChannelState,
  type DeriveForm,
  type Disabled,
  type DisplayValue,
  type RealtimeEditorListing,
  type RealtimeEditorView,
  type StillContext,
  type StillForm,
  type StillSource,
  type UnresolvedItem,
} from "./realtime-model";
import { realtimeEn } from "./realtime.strings";

export type RealtimeMessages = { [K in keyof (typeof realtimeEn)["msg"]]: string };

export interface StatusLine {
  value: DisplayValue;
  tone: "info" | "error";
}

export interface RealtimeSnapshot {
  panelOpen: boolean;
  editors: RealtimeEditorListing[];
  selectedEditor: string;
  current?: RealtimeEditorView;
  summary: DisplayValue;
  status: StatusLine;
  requestDetail?: unknown;
  busy: boolean;
  historyBlocked: boolean;
  /** Set by "Edit as new local draft"; `stamp` changes on every prefill so the form resets. */
  composer?: { editorId: string; sourceRevision: string; prefill: DeriveForm; stamp: number };
  channel: {
    active: boolean;
    busy: boolean;
    blocked: boolean;
    summary: DisplayValue;
    unresolved: UnresolvedItem[];
  };
  still: {
    pending: boolean;
    ready: boolean;
    context?: StillContext;
    sources: StillSource[];
    selected: string;
    summary: DisplayValue;
  };
  disabled: Disabled;
}

type RealtimeApi = Pick<ReviewApi, "realtime" | "channelTransport">;

export interface RealtimeControllerDeps {
  api: RealtimeApi;
  messages: RealtimeMessages;
  /** `document.hidden` (the page is not visible). */
  hidden?: () => boolean;
  /** SHA-256 hex of a UTF-8 string (default: Web Crypto). */
  hash?: (text: string) => Promise<string>;
  /** Message IDs (default: `crypto.randomUUID`). */
  id?: () => string;
  /** WebSocket constructor for the channel (default: the global). */
  WebSocketImpl?: typeof WebSocket;
  now?: () => Date;
}

const webHash = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class RealtimeEditorController {
  messages: RealtimeMessages;
  private readonly api: RealtimeApi;
  private readonly hidden: () => boolean;
  private readonly now: () => Date;
  private readonly channel: ReturnType<typeof createReviewChannelClient>;

  private panelOpen = false;
  private editors: RealtimeEditorListing[] = [];
  private selectedEditor = "";
  private current: RealtimeEditorView | undefined;
  private summary: DisplayValue = "";
  private status: StatusLine = { value: "", tone: "info" };
  private requestDetail: unknown;
  private busy = false;
  private reading = false;
  private historyBlocked = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private composer: RealtimeSnapshot["composer"];
  private stamp = 0;
  private channelSummary: DisplayValue = "";
  private unresolved: UnresolvedItem[] = [];
  private unresolvedStateSha = "";
  private disposed = false;

  // RU-RS: the still form's own epoch, single-flight flag and pinned context.
  private stillEpoch = 0;
  private stillPending = false;
  private stillContext: StillContext | undefined;
  private stillSources: StillSource[] = [];
  private stillSelected = "";
  private stillSummary: DisplayValue;
  private observedIdentity: string;

  private snapshot: RealtimeSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(deps: RealtimeControllerDeps) {
    this.api = deps.api;
    this.messages = deps.messages;
    this.hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.hidden);
    this.now = deps.now ?? (() => new Date());
    const transport = deps.api.channelTransport(deps.WebSocketImpl);
    this.channel = createReviewChannelClient({
      ticket: transport.ticket,
      socket: (ticket: ChannelTicket) => transport.socket(ticket),
      hash: deps.hash ?? webHash,
      id: deps.id ?? (() => crypto.randomUUID()),
      current: (reply) => this.verifyReply(reply),
      changed: () => {
        this.notify();
        this.schedule();
      },
      status: (value) => {
        this.channelSummary = value as DisplayValue;
        this.notify();
      },
    });
    this.stillSummary = this.messages.stillHint;
    this.observedIdentity = this.identity();
    this.snapshot = this.build();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // External store

  readonly getSnapshot = (): RealtimeSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private isOpen = () => this.panelOpen && !this.hidden() && !this.disposed;
  private blocked = () => this.historyBlocked || this.channel.blocked();
  private stillReady = () =>
    this.isOpen() && !!this.current && !this.blocked() && !this.channel.active() && !this.channel.busy();

  private identity() {
    return stillIdentity({
      editorId: this.current?.editorId,
      sequence: this.current?.sequence,
      active: this.isOpen(),
      blocked: this.blocked(),
      channelActive: this.channel?.active() ?? false,
      channelBusy: this.channel?.busy() ?? false,
    });
  }

  private build(): RealtimeSnapshot {
    const channel = {
      active: this.channel.active(),
      busy: this.channel.busy(),
      blocked: this.channel.blocked(),
    };
    return {
      panelOpen: this.panelOpen,
      editors: this.editors,
      selectedEditor: this.selectedEditor,
      current: this.current,
      summary: this.summary,
      status: this.status,
      requestDetail: this.requestDetail,
      busy: this.busy,
      historyBlocked: this.historyBlocked,
      composer: this.composer,
      channel: { ...channel, summary: this.channelSummary, unresolved: this.unresolved },
      still: {
        pending: this.stillPending,
        ready: this.stillReady(),
        context: this.stillContext,
        sources: this.stillSources,
        selected: this.stillSelected,
        summary: this.stillSummary,
      },
      disabled: disabledMatrix({
        busy: this.busy,
        current: this.current,
        historyBlocked: this.historyBlocked,
        channel,
        composer: this.composer,
      }),
    };
  }

  /** review:ui's `enabled()` + the still client's `sync()`: identity check first, then a new snapshot. */
  private notify(): void {
    const now = this.identity();
    if (now !== this.observedIdentity) {
      this.observedIdentity = now;
      this.invalidateStill();
    }
    this.snapshot = this.build();
    for (const listener of [...this.listeners]) listener();
  }

  private setStatus(value: DisplayValue, tone: StatusLine["tone"] = "info"): void {
    this.status = { value, tone };
    this.notify();
  }

  private fail = (error: unknown) => this.setStatus(messageOf(error), "error");

  // -------------------------------------------------------------------------------------------------------------------
  // Lifecycle (RU-R03, RU-R18)

  private stop(): void {
    this.epoch++;
    this.invalidateStill();
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.isOpen() && !this.channel.active() && !this.channel.busy())
      this.timer = setTimeout(() => void this.refreshEditor().catch(this.fail), POLL_MS);
  }

  /** `<details>` toggle: close the channel, stop, re-read when now open. */
  setPanelOpen(open: boolean): void {
    if (this.disposed) return;
    this.channel.close();
    this.stop();
    this.panelOpen = open;
    this.notify();
    if (this.isOpen()) void this.refreshEditor().catch(this.fail);
  }

  /** `visibilitychange`: close the channel, stop, re-read when visible. */
  visibilityChanged(): void {
    if (this.disposed) return;
    this.channel.close();
    this.stop();
    this.notify();
    if (this.isOpen()) void this.refreshEditor().catch(this.fail);
  }

  /** `pagehide`: close the channel and stop. */
  pageHidden(): void {
    this.channel.close();
    this.stop();
  }

  /** Mount (again, under StrictMode): re-reads when the panel is already open. */
  attach(): void {
    this.disposed = false;
    if (this.isOpen()) void this.refreshEditor().catch(this.fail);
  }

  /** Unmount: as `pagehide`, and no later timer or read. */
  dispose(): void {
    this.channel.close();
    this.disposed = true;
    this.stop();
  }

  /** `Refresh editor`. */
  refreshClicked(): void {
    this.channel.close();
    this.stop();
    void this.refreshEditor().catch(this.fail);
  }

  /** The editor select (RU-R01). */
  selectEditor(editorId: string): void {
    this.channel.close();
    this.stop();
    this.selectedEditor = editorId;
    this.current = undefined;
    this.historyBlocked = false;
    this.composer = undefined;
    this.notify();
    void this.refreshEditor().catch(this.fail);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reads (RU-R01, RU-R02, RU-R09)

  private render(value: RealtimeEditorView): void {
    this.current = value;
    this.summary = editorSummary(value);
    this.notify();
  }

  private clearEditor(summary: DisplayValue): void {
    this.current = undefined;
    this.summary = summary;
  }

  /** Read-only refresh: list, view, channel-state; never writes. Throws only for the current epoch. */
  async refreshEditor(): Promise<void> {
    if (!this.isOpen() || this.busy || this.reading || this.channel.active() || this.channel.busy()) {
      this.schedule();
      return;
    }
    this.reading = true;
    const ticket = ++this.epoch;
    try {
      const list = await this.api.realtime.list();
      if (ticket !== this.epoch || !this.isOpen()) return;
      this.editors = (list.editors ?? []) as RealtimeEditorListing[];
      if (!this.editors.some((editor) => editor.editorId === this.selectedEditor))
        this.selectedEditor = this.editors[0]?.editorId ?? "";
      if (list.errors?.length) this.status = { value: list.errors as unknown[], tone: "error" };
      if (!this.selectedEditor) {
        this.clearEditor(this.messages.noEditors);
        this.notify();
        return;
      }
      const value = (await this.api.realtime.view(this.selectedEditor)) as RealtimeEditorView;
      if (ticket !== this.epoch || !this.isOpen()) return;
      const history = (await this.api.realtime.channelState(value.editorId)) as ChannelState;
      if (ticket !== this.epoch || !this.isOpen() || history.sequence !== value.sequence) return;
      this.historyBlocked = (history.unresolvedCount ?? 0) > 0;
      this.render(value);
    } catch (error) {
      if (ticket === this.epoch && this.isOpen()) {
        this.clearEditor(this.messages.notVerified);
        this.composer = undefined;
        this.notify();
        throw error;
      }
    } finally {
      this.reading = false;
      this.schedule();
    }
  }

  /** `Inspect pinned request` (RU-R09): raw JSON, epoch-guarded. */
  async inspectRequest(revisionId: string): Promise<void> {
    if (!this.current || this.busy) return;
    const ticket = ++this.epoch;
    try {
      const input = await this.api.realtime.request(this.current.editorId, revisionId);
      if (ticket === this.epoch && this.isOpen()) {
        this.requestDetail = input;
        this.notify();
      }
    } catch (error) {
      if (ticket === this.epoch) this.fail(error);
    }
  }

  /** `Edit as new local draft` (RU-R10): prefill the 7 whitelisted inputs; IDs and bound cleared. */
  async editRequest(revisionId: string): Promise<void> {
    if (!this.current || this.busy) return;
    const editorId = this.current.editorId;
    const ticket = ++this.epoch;
    this.composer = undefined;
    this.notify();
    try {
      const source = await this.api.realtime.deriveSource(editorId, revisionId);
      if (ticket !== this.epoch || !this.isOpen() || this.current?.editorId !== editorId) return;
      this.composer = {
        editorId,
        sourceRevision: revisionId,
        prefill: derivePrefill((source.input ?? {}) as Record<string, unknown>),
        stamp: ++this.stamp,
      };
      this.setStatus(this.messages.editing.replace("{revision}", revisionId));
    } catch (error) {
      if (ticket === this.epoch) {
        this.composer = undefined;
        this.fail(error);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Mutations (RU-R04…R15, RU-RC06)

  /** One explicit action, sent once; then a read-only refresh. Never throws. */
  async mutate(action: string, extra: Record<string, unknown> = {}, newEditorId = ""): Promise<void> {
    if (this.busy || !this.isOpen()) return;
    const editorId = action === "create" ? newEditorId : this.current?.editorId;
    if (!editorId) return this.setStatus(this.messages.selectFirst, "error");
    if (action !== "create" && action !== "reconcile" && this.blocked())
      return this.setStatus(this.messages.unresolvedBlocks, "error");
    const viaChannel = this.channel.active() && action !== "create";
    if (action === "reconcile" && !viaChannel) return this.setStatus(this.messages.reconcileNeedsChannel, "error");
    if (viaChannel && (HTTP_ONLY_ACTIONS as readonly string[]).includes(action))
      return this.setStatus(this.messages.httpOnly, "error");
    const sequence = this.current?.sequence ?? 0;
    this.stop();
    this.busy = true;
    this.setStatus(this.messages.recording);
    try {
      const payload = { action, editorId, ...extra, ...(action !== "create" ? { expected: sequence } : {}) };
      if (byteLength(payload) > MAX_INLINE_REQUEST_BYTES) throw new Error(this.messages.inlineTooLarge);
      const value = viaChannel
        ? await this.channel.send(action, extra, sequence).then((reply: { outcome: string; reason?: string }) => {
            if (reply.outcome !== "ok") throw new Error(reply.reason || this.messages.localOutcome);
            return this.current;
          })
        : ((await this.api.realtime.mutate(payload)) as RealtimeEditorView);
      if (this.isOpen() && value) {
        if (!this.editors.some((editor) => editor.editorId === value.editorId))
          this.editors = [...this.editors, { editorId: value.editorId, sequence: value.sequence }];
        this.selectedEditor = value.editorId;
        this.render(value);
        this.setStatus(this.messages.recorded);
      }
    } catch (error) {
      this.setStatus(messageOf(error) + this.messages.noReplay, "error");
    } finally {
      this.busy = false;
      this.notify();
      // Read-only, including after an ambiguous reply. The mutation is never repeated.
      await this.refreshEditor().catch(this.fail);
    }
  }

  create(editorId: string, ceilingUsd: number) {
    return this.mutate("create", { ceilingUsd }, editorId);
  }

  /** RU-R05: inline JSON; a parse error shows in the status line and nothing is sent. */
  addInline(text: string) {
    let request: unknown;
    try {
      request = JSON.parse(text);
    } catch (error) {
      this.fail(error);
      return Promise.resolve();
    }
    return this.mutate("add", { request });
  }

  addFile(requestFile: string) {
    return this.mutate("add-file", { requestFile });
  }

  /** RU-R10 save: `valid` is the form controls' `checkValidity()`. */
  saveDerive(form: DeriveForm, valid: boolean) {
    const composer = this.composer;
    if (!composer || composer.editorId !== this.current?.editorId) return Promise.resolve();
    if (!valid || !positiveBound(form.bound)) {
      this.setStatus(this.messages.deriveInvalid, "error");
      return Promise.resolve();
    }
    return this.mutate("derive", { patch: derivePatch(composer.sourceRevision, form, this.now().toISOString()) });
  }

  /** RU-RC06: acknowledge one unknown local outcome over the open channel (no replay). */
  reconcile(item: UnresolvedItem) {
    return this.mutate("reconcile", {
      targetLocalSessionId: item.localSessionId,
      pendingMessageId: item.messageId,
      intentSha256: item.intentSha256,
      currentStateSha256: this.unresolvedStateSha,
      acknowledge: "unknown-local-outcome-no-replay",
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Channel (RU-RC)

  /** The channel's `current` hook: a reply counts only after a matching channel-state + view readback (RU-RC04). */
  private async verifyReply(reply: {
    editorId: string;
    current: { sequence: number; stateSha256: string };
    unresolved: UnresolvedItem[];
  }): Promise<void> {
    const editorId = reply.editorId;
    const ticket = this.epoch;
    const verified = (await this.api.realtime.channelState(editorId)) as ChannelState;
    const value = (await this.api.realtime.view(editorId)) as RealtimeEditorView;
    if (
      ticket !== this.epoch ||
      !this.isOpen() ||
      this.selectedEditor !== editorId ||
      verified.sequence !== reply.current.sequence ||
      verified.stateSha256 !== reply.current.stateSha256 ||
      value.sequence !== reply.current.sequence
    )
      throw new Error(this.messages.readbackChanged);
    this.historyBlocked = (verified.unresolvedCount ?? 0) > 0;
    this.unresolved = reply.unresolved.map(({ localSessionId, messageId, intentSha256 }) => ({
      localSessionId,
      messageId,
      intentSha256,
    }));
    this.unresolvedStateSha = reply.current.stateSha256;
    this.render(value);
  }

  /** `Open local channel` (RU-RC02): one ticket, one socket, one `status`; no reconnect. */
  async openChannel(localSessionId: string): Promise<void> {
    if (!this.current || this.busy) return;
    const editorId = this.current.editorId;
    this.stop();
    try {
      const ticket = await this.channel.open(editorId, localSessionId);
      await this.channel.send("status", {}, ticket.sequence);
    } catch (error) {
      this.setStatus(messageOf(error) + this.messages.noReconnect, "error");
    }
  }

  /** `Close channel` (RU-RC07): explicit, never replays or refunds, then a read-only refresh. */
  closeChannel(): void {
    this.channel.close();
    this.unresolved = [];
    this.stop();
    void this.refreshEditor().catch(this.fail);
  }

  /** `Inspect channel status` at the current sequence. */
  inspectChannel(): void {
    if (this.current) void this.channel.send("status", {}, this.current.sequence).catch(this.fail);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Still draft (RU-RS)

  private invalidateStill(): void {
    this.stillEpoch++;
    this.stillContext = undefined;
    this.stillSources = [];
    this.stillSelected = "";
    this.stillSummary = this.messages.stillHint;
  }

  /** RU-RS01: metadata only, refused while the channel is open or busy or the editor is blocked. */
  async loadStills(): Promise<void> {
    if (this.stillPending || !this.stillReady()) return this.setStatus(this.messages.stillCloseChannel, "error");
    const { editorId, sequence } = this.current!;
    const ticket = ++this.stillEpoch;
    this.stillPending = true;
    this.stillContext = undefined;
    this.notify();
    try {
      const value = await this.api.realtime.stillSources();
      if (
        ticket !== this.stillEpoch ||
        !this.stillReady() ||
        this.current?.editorId !== editorId ||
        this.current?.sequence !== sequence
      )
        return;
      const checked = checkStillListing(value);
      this.stillSources = checked.sources;
      this.stillContext = { editorId, sequence, registrySha256: checked.registrySha256 };
      this.stillSelected = "";
      this.stillSummary = {
        registrySha256: checked.registrySha256,
        metadataOnly: true,
        sources: checked.sources.length,
      };
    } catch (error) {
      if (ticket === this.stillEpoch) {
        this.stillContext = undefined;
        this.status = { value: messageOf(error), tone: "error" };
      }
    } finally {
      this.stillPending = false;
      this.notify();
    }
  }

  /** Choosing a source bumps the still epoch (a pending save's reply is then discarded). */
  chooseStill(assetId: string): void {
    this.stillEpoch++;
    this.stillSelected = assetId;
    this.notify();
  }

  /** RU-RS02: one `add-asset` over HTTP, never retried, then a read-only refresh. `valid` = `checkValidity()`. */
  async saveStill(form: StillForm, valid: boolean): Promise<void> {
    if (this.stillPending || !this.stillReady() || !this.stillContext) return;
    const context = this.stillContext;
    const source = this.stillSources.find((item) => item.assetId === this.stillSelected);
    const state = this.current!;
    if (!source || context.editorId !== state.editorId || context.sequence !== state.sequence) return;
    if (!valid || !positiveBound(form.bound)) return this.setStatus(this.messages.stillInvalid, "error");
    const payload = stillPayload(context, source, form);
    if (byteLength(payload) > MAX_STILL_PAYLOAD_BYTES) return this.setStatus(this.messages.stillTooLarge, "error");
    const { editorId, sequence } = state;
    const assetId = source.assetId;
    const ticket = ++this.stillEpoch;
    this.stillPending = true;
    this.notify();
    try {
      const value = (await this.api.realtime.mutate(payload)) as RealtimeEditorView;
      if (
        ticket !== this.stillEpoch ||
        !this.stillReady() ||
        this.current?.editorId !== editorId ||
        this.current?.sequence !== sequence ||
        this.stillSelected !== assetId
      )
        return;
      this.render(value);
      this.stillSummary = (value.sourceInput ?? null) as DisplayValue;
      this.setStatus(this.messages.stillSaved);
    } catch (error) {
      if (ticket === this.stillEpoch) this.setStatus(messageOf(error) + this.messages.stillNoReplay, "error");
    } finally {
      this.stillPending = false;
      this.notify();
      await this.refreshEditor().catch(() => {});
    }
  }
}
