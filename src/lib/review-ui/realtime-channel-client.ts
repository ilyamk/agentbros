/** Serialized inside authenticated review closure. Local transport only, no provider URLs/tokens. */
export function createReviewChannelClient(deps: {
  ticket: (input: { editorId: string; localSessionId: string }) => Promise<any>;
  socket: (ticket: any) => any;
  hash: (text: string) => Promise<string>;
  id: () => string;
  current: (reply: any) => Promise<void>;
  changed: () => void;
  status: (value: unknown) => void;
}) {
  let unknownCount = 0;
  let epoch = 0,
    socket: any,
    identity: { editorId: string; localSessionId: string } | undefined,
    opening = false,
    closing = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined,
    connectReject: ((error: Error) => void) | undefined,
    pending:
      | {
          messageId: string;
          sha256: string;
          action: string;
          expectedSequence: number;
          resolve: (reply: any) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
  const close = (reason = "Local channel closed; inspect before another explicit action") => {
    epoch++;
    clearTimeout(connectTimer);
    connectTimer = undefined;
    connectReject?.(Error(reason));
    connectReject = undefined;
    opening = false;
    identity = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Error(reason));
      pending = undefined;
    }
    const old = socket;
    socket = undefined;
    if (old) {
      closing = true;
      try {
        old.close();
      } finally {
        closing = false;
      }
    }
    deps.status(reason);
    deps.changed();
  };
  const failure = (error: unknown) => close(error instanceof Error ? error.message : String(error));
  const idValid = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/.test(id);
  const sequence = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255;
  const hashValid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  async function open(editorId: string, localSessionId: string) {
    close("Opening finite local channel");
    if (!idValid(editorId) || !idValid(localSessionId)) throw Error("Invalid local channel IDs");
    const ticketEpoch = epoch;
    opening = true;
    deps.changed();
    try {
      const ticket = await deps.ticket({ editorId, localSessionId });
      if (ticketEpoch !== epoch) throw Error("Channel opening invalidated");
      if (
        ticket.version !== 1 ||
        ticket.editorId !== editorId ||
        ticket.localSessionId !== localSessionId ||
        ticket.path !== "/api/realtime/channel" ||
        ticket.protocol !== "avc-local-editor-v1" ||
        !hashValid(ticket.ticket) ||
        !sequence(ticket.sequence) ||
        !hashValid(ticket.stateSha256) ||
        ticket.expiresAt <= Date.now() ||
        ticket.expiresAt > Date.now() + 5000 ||
        ticket.providerAck !== false ||
        ticket.providerPersistent !== false ||
        ticket.liveVerified !== false
      )
        throw Error("Invalid local admission ticket");
      unknownCount = ticket.unresolvedCount ?? 0;
      identity = { editorId, localSessionId };
      socket = deps.socket(ticket);
      const owned = socket;
      await new Promise<void>((resolve, reject) => {
        connectReject = reject;
        connectTimer = setTimeout(() => failure("Local channel connect deadline"), 5000);
        owned.onopen = () => {
          if (ticketEpoch !== epoch || owned !== socket) return;
          clearTimeout(connectTimer);
          connectTimer = undefined;
          connectReject = undefined;
          opening = false;
          resolve();
          deps.changed();
        };
        owned.onclose = () => {
          if (owned === socket && !closing)
            failure("Local channel disconnected; unknown outcomes require inspection, no replay");
        };
        owned.onerror = () => {
          if (owned === socket) failure("Local channel transport error; no replay");
        };
        owned.onmessage = (event: { data: unknown }) => {
          void receive(event.data, ticketEpoch, owned).catch((error) => {
            if (ticketEpoch === epoch && owned === socket) failure(error);
          });
        };
      });
      return ticket;
    } catch (error) {
      if (ticketEpoch === epoch) failure(error);
      throw error;
    }
  }
  async function receive(raw: unknown, ticketEpoch: number, owned: any) {
    if (ticketEpoch !== epoch || owned !== socket) return;
    if (typeof raw !== "string" || new TextEncoder().encode(raw).length > 65536)
      throw Error("Invalid bounded local reply");
    const reply = JSON.parse(raw),
      slot = pending;
    if (
      !slot ||
      reply.version !== 1 ||
      reply.editorId !== identity?.editorId ||
      reply.localSessionId !== identity?.localSessionId ||
      reply.messageId !== slot.messageId ||
      reply.messageSha256 !== slot.sha256 ||
      reply.action !== slot.action ||
      reply.expectedSequence !== slot.expectedSequence ||
      !["ok", "conflict", "refused", "uncertain"].includes(reply.outcome) ||
      typeof reply.historical !== "boolean" ||
      reply.providerAck !== false ||
      reply.providerPersistent !== false ||
      reply.liveVerified !== false ||
      !sequence(reply.current?.sequence) ||
      !hashValid(reply.current?.stateSha256) ||
      !Array.isArray(reply.unresolved) ||
      reply.unresolved.length > 64
    )
      throw Error("Local reply identity/correlation/protocol mismatch");
    const keys = [
      "version",
      "localSessionId",
      "editorId",
      "messageId",
      "messageSha256",
      "action",
      "outcome",
      "reason",
      "expectedSequence",
      "resultingSequence",
      "stateSha256",
      "current",
      "unresolved",
      "unresolvedCount",
      "unresolvedTruncated",
      "association",
      "historical",
      "providerAck",
      "providerPersistent",
      "liveVerified",
    ];
    const count = reply.unresolvedCount ?? reply.unresolved.length;
    if (
      Object.keys(reply).some((key) => !keys.includes(key)) ||
      !Number.isSafeInteger(count) ||
      count < reply.unresolved.length ||
      count > 2048 ||
      reply.unresolved.some(
        (item: any) => !idValid(item.localSessionId) || !idValid(item.messageId) || !hashValid(item.intentSha256),
      ) ||
      !Number.isFinite(reply.current.committedPlanningUsd) ||
      reply.current.committedPlanningUsd < 0 ||
      !Number.isFinite(reply.current.ceilingUsd) ||
      reply.current.ceilingUsd <= 0 ||
      (reply.resultingSequence === undefined) !== (reply.stateSha256 === undefined) ||
      (reply.resultingSequence !== undefined && (!sequence(reply.resultingSequence) || !hashValid(reply.stateSha256)))
    )
      throw Error("Local reply closed metadata mismatch");
    unknownCount = count;
    // Historical resultingSequence is never current editor state; authenticate current readbacks separately.
    await deps.current(reply);
    if (ticketEpoch !== epoch || owned !== socket || slot !== pending) return;
    clearTimeout(slot.timer);
    pending = undefined;
    slot.resolve(reply);
    deps.status({
      outcome: reply.outcome,
      historical: reply.historical,
      resultingSequence: reply.resultingSequence,
      currentSequence: reply.current.sequence,
      unresolved: reply.unresolved,
      unresolvedCount: reply.unresolvedCount,
      association: reply.association,
      providerAck: false,
      providerPersistent: false,
      liveVerified: false,
    });
    deps.changed();
  }
  async function send(action: string, extra: Record<string, unknown>, expectedSequence: number) {
    if (unknownCount > 0 && !["status", "reconcile"].includes(action))
      throw Error("Unresolved local outcome requires explicit reconciliation");
    if (!identity || !socket || opening || pending) throw Error("Open one local channel and await its pending reply");
    if (!sequence(expectedSequence)) throw Error("Invalid editor CAS");
    const ticketEpoch = epoch,
      owned = socket,
      messageId = deps.id(),
      payload = { ...extra, version: 1, ...identity, messageId, expectedSequence, action };
    if (!idValid(messageId)) throw Error("Invalid message ID");
    const raw = JSON.stringify(payload);
    if (new TextEncoder().encode(raw).length > 16384) throw Error("Local message exceeds 16 KiB");
    // Reserve the single reply slot before hashing/transport. No concurrent hash can create a second command.
    let resolve!: (reply: any) => void, reject!: (error: Error) => void;
    const result = new Promise<any>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    const slot = {
      messageId,
      sha256: "",
      action,
      expectedSequence,
      resolve,
      reject,
      timer: setTimeout(() => failure("Local reply deadline; inspect without replay"), 3000),
    };
    pending = slot;
    deps.changed();
    void deps
      .hash(raw)
      .then((hash) => {
        slot.sha256 = hash;
        if (ticketEpoch !== epoch || owned !== socket || pending !== slot) throw Error("Local send invalidated");
        owned.send(raw);
      })
      .catch((error) => {
        if (pending === slot) {
          clearTimeout(slot.timer);
          pending = undefined;
          reject(error instanceof Error ? error : Error(String(error)));
          deps.changed();
        }
      });
    return result;
  }
  return {
    open,
    send,
    close,
    active: () => Boolean(identity && socket && !opening),
    busy: () => opening || Boolean(pending),
    blocked: () => Boolean(identity && unknownCount > 0),
  };
}
