import path from "node:path";
import { RealtimeEditorStore, type RealtimeEditor } from "./editor";
import { LocalEditorJournal } from "./channel-journal";
import { channelJson } from "./channel-files";
import {
  LocalEditorMessageSchema,
  LocalEditorReplySchema,
  type LocalEditorMessage,
  type LocalEditorReply,
  type LocalEditorLimitsSchema,
} from "./channel-types";
import type { z } from "zod";
/** Trusted local interface only. No URL, provider/token/execute function or wire adapter. */
export interface LocalEditorTransport {
  onMessage(listener: (bytes: Uint8Array) => void): () => void;
  onClose(listener: () => void): () => void;
  send(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  close(): void;
}
/** Finite local message channel over offline editor actions; separate from provider sockets. */
export class LocalEditorChannel {
  readonly store: RealtimeEditorStore;
  readonly journal: LocalEditorJournal;
  private closed = false;
  private busy = false;
  private replyPending = false;
  private cleanup: (() => void)[] = [];
  private totalTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private transport?: LocalEditorTransport;
  private closeReason?: string;
  constructor(
    root: string,
    projectId: string,
    editorId: string,
    localSessionId: string,
    limits?: z.input<typeof LocalEditorLimitsSchema>,
  ) {
    this.store = new RealtimeEditorStore(root, projectId, editorId);
    this.journal = new LocalEditorJournal(this.store, localSessionId, limits);
    this.totalTimer = setTimeout(
      () => this.close("Local channel total deadline"),
      Math.max(0, this.journal.meta.expiresAt - Date.now()),
    );
    this.resetIdle();
  }
  private resetIdle() {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close("Local channel idle deadline"), this.journal.meta.limits.idleMs);
  }
  private current(state: RealtimeEditor) {
    return {
      sequence: state.sequence,
      stateSha256: this.journal.snapshot(state).sha256,
      committedPlanningUsd: state.committedUsd,
      ceilingUsd: state.ceilingUsd,
      ...(state.queued ? { queued: state.queued } : {}),
      ...(state.inFlight ? { inFlight: state.inFlight } : {}),
      ...(state.selected ? { selected: state.selected } : {}),
    };
  }
  private reply(
    message?: LocalEditorMessage,
    outcome: LocalEditorReply["outcome"] = "ok",
    reason?: string,
  ): LocalEditorReply {
    const state = this.store.read();
    return LocalEditorReplySchema.parse({
      version: 1,
      localSessionId: this.journal.localSessionId,
      editorId: this.store.editorId,
      ...(message
        ? { messageId: message.messageId, action: message.action, expectedSequence: message.expectedSequence }
        : {}),
      outcome,
      ...(reason ? { reason: reason.slice(0, 512) } : {}),
      current: this.current(state),
      ...this.journal.barrier(),
      historical: false,
      providerAck: false,
      providerPersistent: false,
      liveVerified: false,
    });
  }
  inspect() {
    this.journal.beginVerification();
    return this.reply(undefined, this.journal.unresolved().length ? "uncertain" : "ok");
  }
  /** Direct local acceptance path, also used by injected transport. Never invokes inference. */
  async accept(bytes: Uint8Array): Promise<LocalEditorReply> {
    if (this.closed) throw Error("Local channel closed");
    this.resetIdle();
    if (this.busy) {
      try {
        const entry = this.journal.receive(bytes, undefined, undefined, false);
        const refused = this.reply(undefined, "refused", "Local channel concurrent input/backpressure");
        refused.messageSha256 = entry.ingress.messageSha256;
        this.journal.finish(entry, refused, this.journal.pins(this.store.read()));
      } finally {
        this.close("Local channel concurrent input/backpressure");
      }
      throw Error("Local channel concurrent input/backpressure");
    }
    this.journal.beginVerification();
    this.busy = true;
    try {
      return await this.handle(bytes);
    } catch (e) {
      this.close("Local protocol/integrity/capacity failure");
      throw e;
    } finally {
      this.busy = false;
    }
  }
  private async handle(bytes: Uint8Array): Promise<LocalEditorReply> {
    this.journal.assertActive();
    const initialDiscovery = this.journal.discover(),
      prior = initialDiscovery.histories.find((h) => h.meta.localSessionId === this.journal.localSessionId)!.entries;
    let message: LocalEditorMessage | undefined, invalid: string | undefined;
    try {
      if (bytes.byteLength > this.journal.meta.limits.maxMessageBytes)
        throw Error("Local channel message exceeds bound");
      message = LocalEditorMessageSchema.parse(channelJson(bytes));
      if (message.localSessionId !== this.journal.localSessionId || message.editorId !== this.store.editorId)
        throw Error("Local channel wrong session/editor");
    } catch {
      message = undefined;
      invalid = "Local channel invalid closed message schema/identity/UTF8/byte bound";
    }
    const state = this.store.read(),
      initial = this.journal.snapshot(state);
    const previous = message && prior.find((e) => e.ingress.message?.messageId === message!.messageId);
    const pending = this.journal.unresolved(initialDiscovery);
    const conflict = message && message.action !== "status" && message.expectedSequence !== state.sequence;
    const blocked = message && message.action !== "status" && message.action !== "reconcile" && pending.length > 0;
    const intent = !!message && !previous && !conflict && !blocked && message.action !== "status";
    this.journal.recheck(initialDiscovery);
    this.journal.assertActive();
    const entry = this.journal.receive(bytes, message, initial, intent);
    this.journal.recheck(initialDiscovery, [`${String(entry.ingress.index).padStart(3, "0")}.ingress.json`]);
    let guarded = this.journal.discover();
    this.journal.assertActive();
    const uncertain = (reason: string) => {
      const reply = this.reply(message, "uncertain", reason);
      reply.messageSha256 = entry.ingress.messageSha256;
      return reply;
    };
    const finish = (
      reply: LocalEditorReply,
      pins = this.journal.pins(this.store.read()),
      acknowledges?: string,
      acknowledgementSha256?: string,
    ) => {
      reply.messageSha256 = entry.ingress.messageSha256;
      if (Date.now() >= this.journal.meta.expiresAt || this.closed) {
        this.close("Local channel deadline/close before outcome");
        throw Error("Local outcome deadline expired");
      }
      this.journal.recheck(guarded);
      this.journal.assertActive();
      this.journal.finish(entry, reply, pins, acknowledges, acknowledgementSha256);
      this.journal.assertActive();
      return reply;
    };
    if (!message) return finish(this.reply(undefined, "refused", invalid));
    if (previous) {
      if (previous.ingress.messageSha256 !== entry.ingress.messageSha256)
        return finish(this.reply(message, "refused", "Repeated message ID changed exact bytes"));
      if (!previous.outcome || previous.failure)
        return finish(this.reply(message, "uncertain", "Pending local intent will never replay automatically"));
      const historical = LocalEditorReplySchema.parse({
        ...previous.outcome.reply,
        current: this.current(this.store.read()),
        ...this.journal.barrier(),
        historical: true,
      });
      const pins = new Map(
        [...previous.outcome.pins, ...this.journal.pins(this.store.read())].map((pin) => [pin.path, pin]),
      );
      return finish(historical, [...pins.values()]);
    }
    if (conflict)
      return finish(this.reply(message, "conflict", "Editor CAS changed; inspect current state without replay"));
    if (blocked)
      return finish(
        this.reply(message, "uncertain", "Unresolved local intent requires explicit checked reconciliation"),
      );
    if (message.action === "status") return finish(this.reply(message), this.journal.pins(state));
    // Yield between durable intent and action: abort cannot silently execute after disconnect.
    await Promise.resolve();
    if (Date.now() >= this.journal.meta.expiresAt) this.close("Local channel deadline after intent");
    if (this.closed || this.controller.signal.aborted)
      return uncertain("Disconnected/deadline after intent; no automatic replay");
    this.journal.recheck(guarded);
    this.journal.assertActive();
    if (this.journal.snapshot(this.store.read()).sha256 !== initial.sha256)
      return uncertain("Editor changed before action; no automatic replay");
    if (message.action === "reconcile") {
      const targetSession = message.targetLocalSessionId ?? this.journal.localSessionId;
      const target = initialDiscovery.histories
        .find((h) => h.meta.localSessionId === targetSession)
        ?.entries.find(
          (e) => e.sha256 === message.intentSha256 && e.ingress.message?.messageId === message.pendingMessageId,
        );
      if (
        !target ||
        !pending.some((p) => p.localSessionId === targetSession && p.intentSha256 === target.sha256) ||
        message.currentStateSha256 !== initial.sha256
      )
        return uncertain("Reconciliation must bind exact pending session/intent and current checked snapshot");
      const acknowledgementSha256 = this.journal.acknowledge(
        entry,
        targetSession,
        target.sha256,
        initial,
        state.sequence,
        guarded,
      );
      guarded = this.journal.discover();
      this.journal.assertActive();
      const reply = this.reply(
        message,
        "ok",
        "Acknowledged unknown local outcome; original action not replayed or certified",
      );
      const remaining = this.journal
        .unresolved(guarded)
        .filter(
          (p) =>
            !(p.localSessionId === targetSession && p.intentSha256 === target.sha256) &&
            !(p.localSessionId === this.journal.localSessionId && p.intentSha256 === entry.sha256),
        );
      reply.unresolved = remaining.slice(0, 64);
      reply.unresolvedCount = remaining.length;
      reply.unresolvedTruncated = remaining.length > 64;
      reply.resultingSequence = state.sequence;
      reply.stateSha256 = initial.sha256;
      return finish(reply, this.journal.pins(state), target.sha256, acknowledgementSha256);
    }
    let result: RealtimeEditor;
    try {
      switch (message.action) {
        case "derive":
          result = this.store.derive(message.expectedSequence, message.patch);
          break;
        case "queue":
          result = this.store.queue(message.expectedSequence, message.revisionId);
          break;
        case "handoff":
          result = this.store.handoff(message.expectedSequence);
          break;
        case "cancel":
          result = this.store.cancel(message.expectedSequence);
          break;
        case "recover":
          result = this.store.recover(message.expectedSequence);
          break;
        case "select":
          result = this.store.select(message.expectedSequence, message.revisionId);
          break;
        case "complete": {
          if (path.isAbsolute(message.manifest) || message.manifest.includes("\\"))
            throw Error("Manifest must be project-relative");
          const file = path.resolve(this.store.root, "public/projects", this.store.projectId, message.manifest);
          const directory = path.join(this.store.root, "public/projects", this.store.projectId, "pipeline/realtime");
          if (!file.startsWith(directory + path.sep)) throw Error("Manifest outside project capture directory");
          result = this.store.complete(message.expectedSequence, message.revisionId, file);
          break;
        }
      }
      // A fault/abort after editor publication must leave the intent unresolved.
      await Promise.resolve();
      if (Date.now() >= this.journal.meta.expiresAt) this.close("Local channel deadline after possible mutation");
      if (this.closed || this.controller.signal.aborted)
        return uncertain("Disconnected/deadline after possible local mutation; inspect without replay");
      const verified = this.store.read();
      if (
        verified.sequence !== result.sequence ||
        this.journal.snapshot(verified).sha256 !== this.journal.snapshot(result).sha256
      )
        throw Error("Editor changed before outcome publication");
      const reply = this.reply(message);
      reply.resultingSequence = result.sequence;
      reply.stateSha256 = this.journal.snapshot(result).sha256;
      const remaining = this.journal
        .unresolved()
        .filter((p) => !(p.localSessionId === this.journal.localSessionId && p.intentSha256 === entry.sha256));
      reply.unresolved = remaining.slice(0, 64);
      reply.unresolvedCount = remaining.length;
      reply.unresolvedTruncated = remaining.length > 64;
      const id =
        "revisionId" in message
          ? message.revisionId
          : message.action === "derive"
            ? message.patch.revisionId
            : (result.inFlight ?? result.queued ?? result.selected);
      const revision = result.revisions.find((r) => r.revisionId === id);
      if (revision)
        reply.association = {
          revisionId: revision.revisionId,
          requestSha256: revision.request.sha256,
          inputHash: revision.inputHash,
          sessionId: revision.sessionId,
          ...(revision.result ? { manifestSha256: revision.result.sha256 } : {}),
        };
      return finish(reply, this.journal.pins(verified));
    } catch {
      return uncertain("Local action or receipt failed after intent; outcome unknown, never replay");
    }
  }
  /** Attaches one trusted local transport; adapter/auth policy is deliberately external. */
  attach(transport: LocalEditorTransport, signal?: AbortSignal) {
    if (this.transport || this.closed) throw Error("Local channel already attached/closed");
    if (signal?.aborted) {
      this.close("Aborted before attach");
      return;
    }
    this.transport = transport;
    const resetIdle = () => this.resetIdle();
    const abort = () => this.close("Local channel aborted");
    try {
      const retain = (off: () => void) => {
        if (this.closed) {
          off();
          return false;
        }
        this.cleanup.push(off);
        return true;
      };
      if (!retain(transport.onClose(() => this.close("Local transport disconnected")))) return;
      if (
        !retain(
          transport.onMessage((bytes) => {
            if (this.closed) return;
            resetIdle();
            if (this.replyPending) {
              try {
                const entry = this.journal.receive(bytes, undefined, undefined, false);
                const refused = this.reply(undefined, "refused", "Local channel backpressure");
                refused.messageSha256 = entry.ingress.messageSha256;
                this.journal.finish(entry, refused, this.journal.pins(this.store.read()));
              } catch {
                /* Capacity refusal closes permanently. */
              }
              this.close("Local channel backpressure");
              return;
            }
            this.replyPending = true;
            void this.accept(bytes)
              .then((reply) => this.send(reply))
              .catch(() => this.close("Local protocol/action/reply failed"))
              .finally(() => {
                this.replyPending = false;
              });
          }),
        )
      )
        return;
      signal?.addEventListener("abort", abort, { once: true });
      this.cleanup.push(() => signal?.removeEventListener("abort", abort));
      if (signal?.aborted) {
        this.close("Local channel aborted during attach");
        return;
      }
      resetIdle();
    } catch (e) {
      this.close("Local transport setup failed");
      throw e;
    }
  }
  private async send(reply: LocalEditorReply) {
    if (this.closed || !this.transport) return;
    const bytes = Buffer.from(JSON.stringify(LocalEditorReplySchema.parse(reply)));
    if (bytes.length > this.journal.meta.limits.maxReplyBytes) throw Error("Local channel reply exceeds bound");
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      await Promise.race([
        this.transport.send(bytes, this.controller.signal),
        new Promise<never>((_, reject) => {
          abort = () => reject(Error("Local reply aborted"));
          this.controller.signal.addEventListener("abort", abort, { once: true });
          if (this.controller.signal.aborted) abort();
          timer = setTimeout(
            () => reject(Error("Local reply settlement timed out")),
            this.journal.meta.limits.settleMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) this.controller.signal.removeEventListener("abort", abort);
    }
  }
  close(reason = "Local channel closed") {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.controller.abort();
    clearTimeout(this.totalTimer);
    clearTimeout(this.idleTimer);
    this.totalTimer = undefined;
    this.idleTimer = undefined;
    for (const cleanup of this.cleanup.splice(0)) {
      try {
        cleanup();
      } catch {
        /* Finish other owned handlers. */
      }
    }
    try {
      this.transport?.close();
    } catch {
      /* Local transport failure cannot prevent lease cleanup. */
    } finally {
      try {
        this.journal.release();
      } catch {
        this.closeReason = `${reason}; owned lease release refused by integrity/IO guard`;
      }
    }
  }
  diagnostics() {
    return {
      closed: this.closed,
      reason: this.closeReason,
      secondaryFailure: this.journal.secondaryFailure,
      handlers: this.cleanup.length,
      busy: this.busy,
      timers: Number(!!this.totalTimer) + Number(!!this.idleTimer),
      providerAck: false as const,
    };
  }
}
