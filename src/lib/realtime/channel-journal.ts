import path from "node:path";
import { z } from "zod";
import { readdirSync, mkdirSync, lstatSync, unlinkSync, openSync, closeSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { digest } from "../jobs/model-artifacts";
import { RealtimeEditorStore, RealtimeEditorSchema, type RealtimeEditor } from "./editor";
import { channelBoundary, channelRead, channelWrite, channelJson } from "./channel-files";
import {
  ChannelFilePinSchema,
  LocalChannelIdSchema,
  LocalEditorLimitsSchema,
  LocalEditorMessageSchema,
  LocalEditorReplySchema,
  DEFAULT_LOCAL_EDITOR_LIMITS,
  type LocalEditorReply,
  type LocalEditorMessage,
} from "./channel-types";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const metaSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    editorId: LocalChannelIdSchema,
    localSessionId: LocalChannelIdSchema,
    createdAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
    limits: LocalEditorLimitsSchema,
  })
  .strict();
const ingressSchema = z
  .object({
    version: z.literal(1),
    index: z.number().int().min(0).max(63),
    receivedBytes: z.number().int().nonnegative().safe(),
    rawBase64: z.string().max(22000).optional(),
    messageSha256: hash.optional(),
    message: LocalEditorMessageSchema.optional(),
    intent: z.boolean(),
    before: ChannelFilePinSchema.optional(),
  })
  .strict();
const outcomeSchema = z
  .object({
    version: z.literal(1),
    ingressSha256: hash,
    reply: LocalEditorReplySchema,
    pins: z.array(ChannelFilePinSchema).max(130),
    acknowledges: hash.optional(),
    acknowledgementSha256: hash.optional(),
  })
  .strict();
const leaseSchema = z
  .object({ pid: z.number().int().positive(), nonce: z.string().uuid(), localSessionId: LocalChannelIdSchema })
  .strict();
type Ingress = z.infer<typeof ingressSchema>;
const ackFailureSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    editorId: LocalChannelIdSchema,
    activeLocalSessionId: LocalChannelIdSchema,
    index: z.number().int().min(0).max(63),
    ingressSha256: hash,
    acknowledgementSha256: hash,
    outcomeSha256: hash,
    expiresAt: z.number().int().nonnegative().safe(),
    observedAt: z.number().int().nonnegative().safe(),
    reason: z.literal("observed-post-publication-expiry"),
  })
  .strict();
const ackSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    editorId: LocalChannelIdSchema,
    activeLocalSessionId: LocalChannelIdSchema,
    targetLocalSessionId: LocalChannelIdSchema,
    activeIndex: z.number().int().min(0).max(63),
    activeIngressSha256: hash,
    targetMetadataSha256: hash,
    targetIndex: z.number().int().min(0).max(63),
    targetIngressSha256: hash,
    targetMessageId: LocalChannelIdSchema,
    targetOutcomeSha256: hash.optional(),
    targetFailureSha256: hash.optional(),
    targetBefore: ChannelFilePinSchema,
    current: ChannelFilePinSchema,
    expectedSequence: z.number().int().min(0).max(255),
    acknowledge: z.literal("unknown-local-outcome-no-replay"),
  })
  .strict();
type Entry = {
  ingress: Ingress;
  sha256: string;
  outcome?: z.infer<typeof outcomeSchema>;
  outcomeSha256?: string;
  failure?: { value: z.infer<typeof ackFailureSchema>; sha256: string };
  acknowledgement?: { value: z.infer<typeof ackSchema>; sha256: string };
};
type History = { directory: string; metadataSha256: string; meta: z.infer<typeof metaSchema>; entries: Entry[] };
type Discovery = {
  histories: History[];
  members: { directory: string; names: string[]; absent?: boolean }[];
  pins: z.infer<typeof ChannelFilePinSchema>[];
};
/** Private local receipts, never accepted capture caches or authoritative provider evidence. */
class LocalEditorHistoryReader {
  constructor(readonly store: RealtimeEditorStore) {}
  protected ownSession(): { directory: string; meta: z.infer<typeof metaSchema> } | undefined {
    return undefined;
  }
  get parentDirectory() {
    return path.join(this.store.root, ".cache/realtime-channels", this.store.projectId, digest(this.store.editorId));
  }
  private verifiedBytes = 0;
  beginVerification() {
    this.verifiedBytes = 0;
  }
  private charge(bytes: number) {
    this.verifiedBytes += bytes;
    if (this.verifiedBytes > 256 * 1024 * 1024) throw Error("Local channel aggregate verification byte bound exceeded");
  }
  protected read(file: string, maximum: number) {
    const bytes = channelRead(this.store.root, file, maximum);
    this.charge(bytes.length);
    return bytes;
  }
  protected checkPin(raw: unknown) {
    const pin = ChannelFilePinSchema.parse(raw);
    const bytes = this.read(path.resolve(this.store.root, pin.path), pin.byteLength);
    if (bytes.length !== pin.byteLength || digest(bytes) !== pin.sha256)
      throw Error("Local channel historical pin changed");
    return bytes;
  }
  protected pin(file: string, maximum: number) {
    const bytes = this.read(file, maximum);
    return ChannelFilePinSchema.parse({
      path: path.relative(this.store.root, file),
      sha256: digest(bytes),
      byteLength: bytes.length,
    });
  }
  protected globalStorageBytes() {
    const parent = this.parentDirectory;
    channelBoundary(this.store.root, parent);
    let sum = 0;
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    if (names.some((name) => !/^[a-f0-9]{64}$/.test(name) && name !== "lease.json" && name !== "lease.json.guard"))
      throw Error("Local channel unknown parent member");
    const directories = names.filter((name) => /^[a-f0-9]{64}$/.test(name));
    if (directories.length > 32) throw Error("Local channel aggregate session bound exceeded");
    for (const name of directories) {
      const directory = path.join(parent, name);
      channelBoundary(this.store.root, directory);
      if (!lstatSync(directory).isDirectory()) throw Error("Local channel directory is nonregular");
      const files = readdirSync(directory);
      if (
        files.length > 258 ||
        files.some(
          (f) =>
            f !== "session.json" &&
            f !== "terminal.json" &&
            !/^\d{3}\.(ingress|outcome|ack|ack-failure)\.json$/.test(f),
        )
      )
        throw Error("Local channel unknown aggregate receipt member");
      for (const file of files) {
        sum += this.read(path.join(directory, file), 65536).length;
        if (sum > 8 * 1024 * 1024) throw Error("Local channel aggregate sidecar bound exceeded");
      }
    }
    return sum;
  }
  protected history(directory: string): History {
    channelBoundary(this.store.root, directory);
    if (!lstatSync(directory).isDirectory()) throw Error("Local channel history directory nonregular");
    const metadataBytes = this.read(path.join(directory, "session.json"), 65536);
    const metadata = metaSchema.parse(channelJson(metadataBytes));
    if (
      metadata.projectId !== this.store.projectId ||
      metadata.editorId !== this.store.editorId ||
      digest(metadata.localSessionId) !== path.basename(directory) ||
      metadata.expiresAt !== metadata.createdAt + metadata.limits.totalMs ||
      (directory === this.ownSession()?.directory &&
        JSON.stringify(metadata) !== JSON.stringify(this.ownSession()!.meta))
    )
      throw Error("Local channel persisted session identity changed");
    const files = readdirSync(directory);
    if (
      files.length > 258 ||
      files.some(
        (f) =>
          f !== "session.json" && f !== "terminal.json" && !/^\d{3}\.(ingress|outcome|ack|ack-failure)\.json$/.test(f),
      )
    )
      throw Error("Local channel unknown history member");
    let storage = 0;
    for (const file of files) storage += this.read(path.join(directory, file), 65536).length;
    if (files.includes("terminal.json")) {
      const terminal = z
        .object({
          version: z.literal(1),
          receivedBytes: z.number().int().nonnegative().safe(),
          commands: z.number().int().positive().safe(),
          reason: z.literal("deadline-or-cumulative-capacity-exhausted"),
        })
        .strict()
        .parse(channelJson(this.read(path.join(directory, "terminal.json"), 1024)));
      if (!terminal.commands) throw Error("Local channel terminal malformed");
    }
    if (storage > metadata.limits.maxSidecarBytes) throw Error("Local channel sidecar byte bound exceeded");
    const names = readdirSync(directory)
      .filter((f) => /^\d{3}\.ingress\.json$/.test(f))
      .sort();
    if (names.length > metadata.limits.maxCommands) throw Error("Local channel command bound exceeded");
    const entries = names.map((name, index): Entry => {
      if (name !== `${String(index).padStart(3, "0")}.ingress.json`)
        throw Error("Local channel incomplete ingress history");
      const bytes = this.read(path.join(directory, name), 65536),
        ingress = ingressSchema.parse(channelJson(bytes));
      if (ingress.index !== index || (ingress.intent && (!ingress.message || !ingress.before)))
        throw Error("Local channel intent identity malformed");
      if (ingress.rawBase64 !== undefined) {
        const raw = Buffer.from(ingress.rawBase64, "base64");
        if (
          raw.toString("base64") !== ingress.rawBase64 ||
          raw.length !== ingress.receivedBytes ||
          raw.length > metadata.limits.maxMessageBytes ||
          digest(raw) !== ingress.messageSha256
        )
          throw Error("Local channel exact input bytes changed");
        if (
          ingress.message &&
          JSON.stringify(LocalEditorMessageSchema.parse(channelJson(raw))) !== JSON.stringify(ingress.message)
        )
          throw Error("Local channel parsed input changed");
      } else if (ingress.message || ingress.messageSha256 || ingress.intent)
        throw Error("Local channel input bytes missing");
      if (
        ingress.message &&
        (ingress.message.localSessionId !== metadata.localSessionId || ingress.message.editorId !== this.store.editorId)
      )
        throw Error("Local channel request identity mismatch");
      const entry: Entry = { ingress, sha256: digest(bytes) };
      try {
        const raw = this.read(path.join(directory, `${String(index).padStart(3, "0")}.outcome.json`), 65536);
        entry.outcome = outcomeSchema.parse(channelJson(raw));
        entry.outcomeSha256 = digest(raw);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      try {
        const raw = this.read(path.join(directory, `${String(index).padStart(3, "0")}.ack.json`), 65536);
        entry.acknowledgement = { value: ackSchema.parse(channelJson(raw)), sha256: digest(raw) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      try {
        const raw = this.read(path.join(directory, `${String(index).padStart(3, "0")}.ack-failure.json`), 65536);
        entry.failure = { value: ackFailureSchema.parse(channelJson(raw)), sha256: digest(raw) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (ingress.before) {
        const saved = RealtimeEditorSchema.parse(channelJson(this.checkPin(ingress.before)));
        if (
          saved.projectId !== this.store.projectId ||
          saved.editorId !== this.store.editorId ||
          ingress.before.path !==
            path.relative(
              this.store.root,
              path.join(this.store.directory, `${String(saved.sequence).padStart(3, "0")}.json`),
            ) ||
          (ingress.intent && ingress.message!.expectedSequence !== saved.sequence)
        )
          throw Error("Local channel before snapshot identity changed");
        this.pins(saved);
      }
      if (entry.outcome) {
        const reply = entry.outcome.reply;
        if (reply.expectedSequence !== ingress.message?.expectedSequence)
          throw Error("Local channel expected sequence changed");
        if (
          entry.outcome.ingressSha256 !== entry.sha256 ||
          reply.localSessionId !== metadata.localSessionId ||
          reply.editorId !== this.store.editorId ||
          reply.messageId !== ingress.message?.messageId ||
          reply.messageSha256 !== ingress.messageSha256 ||
          reply.action !== ingress.message?.action
        )
          throw Error("Local channel outcome binding changed");
        const snapshotAt = (sequence: number, sha256: string) => {
          const expected = path.relative(
            this.store.root,
            path.join(this.store.directory, `${String(sequence).padStart(3, "0")}.json`),
          );
          const pin = entry.outcome!.pins.find((p) => p.path === expected && p.sha256 === sha256);
          if (!pin) throw Error("Local channel response snapshot pin missing");
          if (pin.byteLength > 65536) throw Error("Local channel snapshot byte bound exceeded");
          return RealtimeEditorSchema.parse(channelJson(this.checkPin(pin)));
        };
        const required = new Set<string>();
        const coverage = (saved: RealtimeEditor) => {
          for (const revision of saved.revisions) {
            const requirePin = (p: { path: string; sha256: string }, maximum: number) => {
              const pin = entry.outcome!.pins.find(
                (candidate) => candidate.path === p.path && candidate.sha256 === p.sha256,
              );
              if (!pin || pin.byteLength > maximum) throw Error("Local channel response source/output pin missing");
              required.add(`${pin.path}:${pin.sha256}`);
              return pin;
            };
            const requestFile = path.resolve(this.store.root, revision.request.path);
            if (!requestFile.startsWith(this.store.directory + path.sep))
              throw Error("Local channel historical request outside editor");
            requirePin(revision.request, 6 * 1024 * 1024);
            if (revision.result) {
              const project = path.join(this.store.root, "public/projects", this.store.projectId);
              if (
                !path
                  .resolve(this.store.root, revision.result.path)
                  .startsWith(path.join(project, "pipeline/realtime") + path.sep)
              )
                throw Error("Local channel historical manifest outside project");
              const pin = requirePin(revision.result, 65536);
              const manifest = z
                .object({
                  frames: z
                    .array(z.object({ path: z.string(), sha256: hash }).passthrough())
                    .min(1)
                    .max(2),
                })
                .passthrough()
                .parse(channelJson(this.checkPin(pin)));
              for (const frame of manifest.frames) {
                if (!path.resolve(this.store.root, frame.path).startsWith(project + path.sep))
                  throw Error("Local channel historical frame outside project");
                requirePin(frame, 16 * 1024 * 1024);
              }
            }
          }
        };
        const currentSaved = snapshotAt(reply.current.sequence, reply.current.stateSha256);
        coverage(currentSaved);
        if (
          currentSaved.projectId !== this.store.projectId ||
          currentSaved.editorId !== this.store.editorId ||
          currentSaved.sequence !== reply.current.sequence ||
          currentSaved.committedUsd !== reply.current.committedPlanningUsd ||
          currentSaved.ceilingUsd !== reply.current.ceilingUsd ||
          currentSaved.queued !== reply.current.queued ||
          currentSaved.inFlight !== reply.current.inFlight ||
          currentSaved.selected !== reply.current.selected
        )
          throw Error("Local channel current summary binding changed");
        if ((reply.resultingSequence === undefined) !== (reply.stateSha256 === undefined))
          throw Error("Local channel result sequence/hash incomplete");
        if (reply.resultingSequence !== undefined) {
          const saved = snapshotAt(reply.resultingSequence, reply.stateSha256!);
          coverage(saved);
          if (reply.association) {
            const revision = saved.revisions.find((r) => r.revisionId === reply.association!.revisionId),
              a = reply.association;
            if (
              !revision ||
              revision.request.sha256 !== a.requestSha256 ||
              revision.inputHash !== a.inputHash ||
              revision.sessionId !== a.sessionId ||
              revision.result?.sha256 !== a.manifestSha256
            )
              throw Error("Local channel revision response association changed");
          }
        } else if (reply.association) throw Error("Local channel association lacks resulting snapshot");
        for (const pin of entry.outcome.pins) {
          const file = path.resolve(this.store.root, pin.path);
          const snapshot = path.dirname(file) === this.store.directory && /^\d{3}\.json$/.test(path.basename(file));
          if (!snapshot && !required.has(`${pin.path}:${pin.sha256}`))
            throw Error("Local channel unreferenced source/output pin");
          this.checkPin(pin);
        }
      }
      return entry;
    });
    const receivedBytes = entries.reduce((sum, entry) => sum + entry.ingress.receivedBytes, 0);
    if (!Number.isSafeInteger(receivedBytes) || receivedBytes > metadata.limits.maxReceivedBytes)
      throw Error("Local channel historical cumulative byte bound exceeded");
    for (const entry of entries)
      if (entry.outcome?.acknowledges && !entry.outcome.acknowledgementSha256) {
        const target = entries.find((e) => e.sha256 === entry.outcome!.acknowledges);
        const message = entry.ingress.message;
        if (
          message?.action !== "reconcile" ||
          (message.targetLocalSessionId !== undefined && message.targetLocalSessionId !== metadata.localSessionId) ||
          !target?.ingress.intent ||
          target.ingress.index >= entry.ingress.index ||
          target.outcome ||
          message.intentSha256 !== target.sha256 ||
          message.pendingMessageId !== target.ingress.message?.messageId ||
          entry.outcome.reply.outcome !== "ok" ||
          entry.outcome.reply.current.stateSha256 !== message.currentStateSha256
        )
          throw Error("Local reconciliation binding changed");
      }
    // Outcome files must not be orphaned or silently dropped.
    if (
      readdirSync(directory).filter((f) => /^\d{3}\.outcome\.json$/.test(f)).length !==
      entries.filter((e) => e.outcome).length
    )
      throw Error("Local channel orphan outcome");
    if (
      readdirSync(directory).filter((f) => /^\d{3}\.ack\.json$/.test(f)).length !==
      entries.filter((e) => e.acknowledgement).length
    )
      throw Error("Local channel orphan acknowledgement");
    if (
      readdirSync(directory).filter((f) => /^\d{3}\.ack-failure\.json$/.test(f)).length !==
      entries.filter((e) => e.failure).length
    )
      throw Error("Local channel orphan acknowledgement failure");
    return { directory, meta: metadata, metadataSha256: digest(metadataBytes), entries };
  }
  /** Read-only predecessor discovery; never acquires their lease or resets expiry/accounting. */
  discover(): Discovery {
    const parent = this.parentDirectory;
    this.globalStorageBytes();
    let all: string[];
    try {
      all = readdirSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { histories: [], members: [{ directory: parent, names: [], absent: true }], pins: [] };
      throw error;
    }
    const names = all.filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
    const histories = names.map((name) => this.history(path.join(parent, name)));
    const members = [
      { directory: parent, names },
      ...histories.map((h) => ({ directory: h.directory, names: readdirSync(h.directory).sort() })),
    ];
    const pins = histories.flatMap((h) =>
      readdirSync(h.directory)
        .sort()
        .map((name) => this.pin(path.join(h.directory, name), 65536)),
    );
    for (const active of histories)
      for (const entry of active.entries) {
        const ack = entry.acknowledgement?.value,
          outcome = entry.outcome,
          failure = entry.failure?.value;
        if (
          failure &&
          (!ack ||
            !outcome ||
            failure.projectId !== this.store.projectId ||
            failure.editorId !== this.store.editorId ||
            failure.activeLocalSessionId !== active.meta.localSessionId ||
            failure.index !== entry.ingress.index ||
            failure.ingressSha256 !== entry.sha256 ||
            failure.acknowledgementSha256 !== entry.acknowledgement!.sha256 ||
            failure.outcomeSha256 !== entry.outcomeSha256 ||
            failure.expiresAt !== active.meta.expiresAt ||
            failure.observedAt < failure.expiresAt)
        )
          throw Error("Local channel acknowledgement failure binding changed");
        if (outcome?.acknowledgementSha256 && (!ack || outcome.acknowledgementSha256 !== entry.acknowledgement!.sha256))
          throw Error("Local channel acknowledgement receipt missing/changed");
        if (!ack) continue;
        const message = entry.ingress.message;
        const targetHistory = histories.find((h) => h.meta.localSessionId === ack.targetLocalSessionId);
        const target = targetHistory?.entries.find((e) => e.sha256 === ack.targetIngressSha256);
        if (
          ack.projectId !== this.store.projectId ||
          ack.editorId !== this.store.editorId ||
          ack.activeLocalSessionId !== active.meta.localSessionId ||
          ack.activeIndex !== entry.ingress.index ||
          ack.activeIngressSha256 !== entry.sha256 ||
          message?.action !== "reconcile" ||
          !entry.ingress.intent ||
          (message.targetLocalSessionId ?? active.meta.localSessionId) !== ack.targetLocalSessionId ||
          message.intentSha256 !== ack.targetIngressSha256 ||
          message.pendingMessageId !== ack.targetMessageId ||
          message.currentStateSha256 !== ack.current.sha256 ||
          message.expectedSequence !== ack.expectedSequence ||
          !targetHistory ||
          ack.targetMetadataSha256 !== targetHistory.metadataSha256 ||
          !target?.ingress.intent ||
          (target.outcome && !target.failure) ||
          target.ingress.index !== ack.targetIndex ||
          target.ingress.message?.messageId !== ack.targetMessageId ||
          JSON.stringify(target.ingress.before) !== JSON.stringify(ack.targetBefore) ||
          (active === targetHistory && target.ingress.index >= entry.ingress.index)
        )
          throw Error("Local channel cross-session acknowledgement binding changed");
        if (
          ack.targetOutcomeSha256 !== (target.failure ? target.outcomeSha256 : undefined) ||
          ack.targetFailureSha256 !== target.failure?.sha256
        )
          throw Error("Local channel marked target receipt pins changed");
        const current = RealtimeEditorSchema.parse(channelJson(this.checkPin(ack.current)));
        this.checkPin(ack.targetBefore);
        if (
          current.projectId !== this.store.projectId ||
          current.editorId !== this.store.editorId ||
          current.sequence !== ack.expectedSequence ||
          ack.current.path !==
            path.relative(
              this.store.root,
              path.join(this.store.directory, `${String(current.sequence).padStart(3, "0")}.json`),
            )
        )
          throw Error("Local channel acknowledgement snapshot identity changed");
        if (
          outcome &&
          (outcome.acknowledges !== target.sha256 ||
            outcome.acknowledgementSha256 !== entry.acknowledgement!.sha256 ||
            outcome.reply.outcome !== "ok" ||
            outcome.reply.current.stateSha256 !== ack.current.sha256 ||
            outcome.reply.resultingSequence !== current.sequence)
        )
          throw Error("Local channel acknowledgement outcome binding changed");
      }
    return { histories, members, pins };
  }
  recheck(discovery: Discovery, newOwnFiles: string[] = []) {
    for (const member of discovery.members) {
      channelBoundary(this.store.root, member.directory);
      if (member.absent) {
        try {
          lstatSync(member.directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw Error("Local channel history appeared");
      }
      if (!lstatSync(member.directory).isDirectory()) throw Error("Local channel history directory changed");
      const names = readdirSync(member.directory)
        .filter((name) => (member.directory === this.parentDirectory ? /^[a-f0-9]{64}$/.test(name) : true))
        .sort();
      const expected =
        member.directory === this.ownSession()?.directory ? [...member.names, ...newOwnFiles].sort() : member.names;
      if (JSON.stringify(names) !== JSON.stringify(expected)) throw Error("Local channel history membership changed");
    }
    for (const pin of discovery.pins) this.checkPin(pin);
    // Original/output pins are consumed again, not inferred from unchanged receipts.
    for (const history of discovery.histories) this.history(history.directory);
  }
  unresolved(discovery = this.discover()) {
    const acknowledged = new Set<string>();
    for (const history of discovery.histories)
      for (const entry of history.entries) {
        if (entry.outcome?.acknowledges && !entry.failure)
          acknowledged.add(
            `${entry.acknowledgement?.value.targetLocalSessionId ?? history.meta.localSessionId}:${entry.outcome.acknowledges}`,
          );
      }
    return discovery.histories.flatMap((h) =>
      h.entries
        .filter(
          (e) =>
            e.ingress.intent && (!e.outcome || e.failure) && !acknowledged.has(`${h.meta.localSessionId}:${e.sha256}`),
        )
        .map((e) => ({
          localSessionId: h.meta.localSessionId,
          messageId: e.ingress.message!.messageId,
          intentSha256: e.sha256,
        })),
    );
  }
  barrier(discovery?: Discovery) {
    const unresolved = this.unresolved(discovery);
    return {
      unresolved: unresolved.slice(0, 64),
      unresolvedCount: unresolved.length,
      unresolvedTruncated: unresolved.length > 64,
    };
  }
  verifyPins(pins: z.infer<typeof ChannelFilePinSchema>[]) {
    for (const pin of pins) this.checkPin(pin);
  }
  snapshot(state: RealtimeEditor) {
    return this.pin(path.join(this.store.directory, `${String(state.sequence).padStart(3, "0")}.json`), 65536);
  }
  pins(state: RealtimeEditor) {
    const pins = [this.snapshot(state)];
    let total = pins[0].byteLength;
    for (const entry of state.revisions) {
      const requestPath = path.resolve(this.store.root, entry.request.path);
      if (!requestPath.startsWith(this.store.directory + path.sep)) throw Error("Local channel request outside editor");
      const request = this.pin(requestPath, 6 * 1024 * 1024);
      if (request.sha256 !== entry.request.sha256) throw Error("Local channel request pin changed");
      pins.push(request);
      total += request.byteLength;
      if (entry.result) {
        const file = path.resolve(this.store.root, entry.result.path),
          project = path.join(this.store.root, "public/projects", this.store.projectId);
        if (!file.startsWith(path.join(project, "pipeline/realtime") + path.sep))
          throw Error("Local channel result outside project");
        const manifest = this.pin(file, 65536);
        if (manifest.sha256 !== entry.result.sha256) throw Error("Local channel result changed");
        pins.push(manifest);
        total += manifest.byteLength;
        const raw = channelJson(this.checkPin(manifest)) as { frames: unknown[] };
        for (const frame of raw.frames) {
          const supplied = z.object({ path: z.string(), sha256: hash }).passthrough().parse(frame),
            framePath = path.resolve(this.store.root, supplied.path);
          if (!framePath.startsWith(project + path.sep)) throw Error("Local channel frame outside project");
          const pin = this.pin(framePath, 16 * 1024 * 1024);
          if (pin.sha256 !== supplied.sha256) throw Error("Local channel frame changed");
          pins.push(pin);
          total += pin.byteLength;
        }
      }
      if (total > 256 * 1024 * 1024 || pins.length > 129)
        throw Error("Local channel original verification bound exceeded");
    }
    return pins;
  }
}
/** Nonowning inspection: no journal constructor, lease, mkdir, write or timer. */
export function inspectLocalEditorHistory(store: RealtimeEditorStore) {
  const reader = new LocalEditorHistoryReader(store),
    state = store.read(),
    current = reader.snapshot(state),
    sources = reader.pins(state),
    discovery = reader.discover(),
    barrier = reader.barrier(discovery);
  const leaseFile = path.join(reader.parentDirectory, "lease.json"),
    guardFile = leaseFile + ".guard";
  const leasePin = (file: string) => {
    try {
      const bytes = channelRead(store.root, file, 1024);
      return { sha256: digest(bytes), owner: file === leaseFile ? leaseSchema.parse(channelJson(bytes)) : undefined };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const lease = leasePin(leaseFile),
    guard = leasePin(guardFile);
  return Object.freeze({
    sequence: state.sequence,
    stateSha256: current.sha256,
    ...barrier,
    leasePresent: lease !== undefined || guard !== undefined,
    // Signal zero reads liveness only. No caller-selected PID or ownership/reclaim operation escapes this closure.
    mayAcquire() {
      if (guard) return false;
      if (!lease) return true;
      try {
        process.kill(lease.owner!.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    },
    recheck() {
      reader.discover();
      reader.recheck(discovery);
      if (leasePin(leaseFile)?.sha256 !== lease?.sha256 || leasePin(guardFile)?.sha256 !== guard?.sha256)
        throw Error("Local channel lease changed");
      const now = store.read();
      if (now.sequence !== state.sequence || reader.snapshot(now).sha256 !== current.sha256)
        throw Error("Editor snapshot changed");
      reader.verifyPins(sources);
    },
  });
}
export class LocalEditorJournal extends LocalEditorHistoryReader {
  protected override ownSession() {
    return { directory: this.directory, meta: this.meta };
  }
  readonly directory: string;
  readonly meta: z.infer<typeof metaSchema>;
  private readonly leaseFile: string;
  private leaseSha?: string;
  secondaryFailure?: string;
  assertActive() {
    if (Date.now() >= this.meta.expiresAt) throw Error("Local channel absolute deadline bound expired");
  }
  constructor(
    store: RealtimeEditorStore,
    readonly localSessionId: string,
    requestedLimits?: z.input<typeof LocalEditorLimitsSchema>,
  ) {
    super(store);
    LocalChannelIdSchema.parse(localSessionId);
    store.read();
    const parent = path.join(store.root, ".cache/realtime-channels", store.projectId, digest(store.editorId));
    channelBoundary(store.root, parent);
    mkdirSync(parent, { recursive: true });
    channelBoundary(store.root, parent);
    this.directory = path.join(parent, digest(localSessionId));
    this.leaseFile = path.join(parent, "lease.json");
    channelBoundary(store.root, this.directory);
    const metadata = path.join(this.directory, "session.json");
    let old: z.infer<typeof metaSchema> | undefined;
    try {
      old = metaSchema.parse(channelJson(this.read(metadata, 65536)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const limits = LocalEditorLimitsSchema.parse(requestedLimits ?? old?.limits ?? DEFAULT_LOCAL_EDITOR_LIMITS);
    if (old && JSON.stringify(old.limits) !== JSON.stringify(limits))
      throw Error("Local channel persisted limits cannot change");
    const now = Date.now();
    this.meta =
      old ??
      metaSchema.parse({
        version: 1,
        projectId: store.projectId,
        editorId: store.editorId,
        localSessionId,
        createdAt: now,
        expiresAt: now + limits.totalMs,
        limits,
      });
    if (
      this.meta.projectId !== store.projectId ||
      this.meta.editorId !== store.editorId ||
      this.meta.localSessionId !== localSessionId ||
      this.meta.expiresAt !== this.meta.createdAt + limits.totalMs
    )
      throw Error("Local channel session identity changed");
    Object.freeze(this.meta.limits);
    Object.freeze(this.meta);
    this.acquireLease();
    try {
      const directories = readdirSync(parent).filter((name) => /^[a-f0-9]{64}$/.test(name));
      if (
        directories.length > 32 ||
        (!old && directories.length >= 32) ||
        this.globalStorageBytes() + (old ? 0 : 65536) > 8 * 1024 * 1024
      )
        throw Error("Local editor aggregate channel capacity exceeded");
      if (!old) channelWrite(store.root, metadata, this.meta);
      this.entries();
    } catch (e) {
      this.release();
      throw e;
    }
  }
  private acquireLease() {
    const guard = `${this.leaseFile}.guard`;
    channelBoundary(this.store.root, guard);
    const fd = openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      let previous: z.infer<typeof leaseSchema> | undefined;
      try {
        previous = leaseSchema.parse(channelJson(this.read(this.leaseFile, 1024)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (previous) {
        try {
          process.kill(previous.pid, 0);
          throw Error("Local editor channel already owned");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
        // Dead process is evidence only of stale local ownership, never unsubmitted work.
        unlinkSync(this.leaseFile);
      }
      const lease = leaseSchema.parse({ pid: process.pid, nonce: randomUUID(), localSessionId: this.localSessionId });
      this.leaseSha = digest(Buffer.from(JSON.stringify(lease)));
      try {
        channelWrite(this.store.root, this.leaseFile, lease);
      } catch (e) {
        this.release();
        throw e;
      }
    } finally {
      closeSync(fd);
      unlinkSync(guard);
    }
  }
  release() {
    if (!this.leaseSha) return;
    try {
      if (digest(channelRead(this.store.root, this.leaseFile, 1024)) !== this.leaseSha)
        throw Error("Local channel owned lease identity changed");
      unlinkSync(this.leaseFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    } finally {
      this.leaseSha = undefined;
    }
  }
  private file(index: number, suffix: string) {
    return path.join(this.directory, `${String(index).padStart(3, "0")}.${suffix}.json`);
  }
  private storageBytes() {
    channelBoundary(this.store.root, this.directory);
    const files = readdirSync(this.directory);
    if (
      files.length > 258 ||
      files.some(
        (f) =>
          f !== "session.json" && f !== "terminal.json" && !/^\d{3}\.(ingress|outcome|ack|ack-failure)\.json$/.test(f),
      )
    )
      throw Error("Local channel unknown/incomplete receipt member");
    return files.reduce((sum, f) => {
      const bytes = this.read(path.join(this.directory, f), 65536);
      return sum + bytes.length;
    }, 0);
  }
  entries(): Entry[] {
    return this.history(this.directory).entries;
  }
  acknowledge(
    entry: Entry,
    targetSession: string,
    targetSha: string,
    current: z.infer<typeof ChannelFilePinSchema>,
    expectedSequence: number,
    discovery: Discovery,
  ) {
    this.assertActive();
    this.recheck(discovery);
    this.assertActive();
    const targetHistory = discovery.histories.find((h) => h.meta.localSessionId === targetSession),
      target = targetHistory?.entries.find((e) => e.sha256 === targetSha);
    if (!targetHistory || !target?.ingress.before) throw Error("Local channel acknowledgement target missing");
    const receipt = ackSchema.parse({
      version: 1,
      projectId: this.store.projectId,
      editorId: this.store.editorId,
      activeLocalSessionId: this.localSessionId,
      targetLocalSessionId: targetSession,
      activeIndex: entry.ingress.index,
      activeIngressSha256: entry.sha256,
      targetMetadataSha256: targetHistory.metadataSha256,
      targetIndex: target.ingress.index,
      targetIngressSha256: target.sha256,
      targetMessageId: target.ingress.message!.messageId,
      ...(target.failure
        ? { targetOutcomeSha256: target.outcomeSha256, targetFailureSha256: target.failure.sha256 }
        : {}),
      targetBefore: target.ingress.before,
      current,
      expectedSequence,
      acknowledge: "unknown-local-outcome-no-replay",
    });
    const sha = channelWrite(this.store.root, this.file(entry.ingress.index, "ack"), receipt);
    this.assertActive();
    return sha;
  }
  receive(
    bytes: Uint8Array,
    message: LocalEditorMessage | undefined,
    before: ReturnType<LocalEditorJournal["snapshot"]> | undefined,
    intent: boolean,
  ) {
    const entries = this.entries(),
      received = entries.reduce((n, e) => n + e.ingress.receivedBytes, 0);
    try {
      this.read(path.join(this.directory, "terminal.json"), 1024);
      throw Error("Local channel permanently exhausted");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const reserve = message?.action === "reconcile" ? 262144 : 131072;
    if (
      Date.now() >= this.meta.expiresAt ||
      entries.length >= this.meta.limits.maxCommands ||
      received + bytes.byteLength > this.meta.limits.maxReceivedBytes ||
      this.storageBytes() + reserve > this.meta.limits.maxSidecarBytes ||
      this.globalStorageBytes() + reserve > 8 * 1024 * 1024
    ) {
      channelWrite(this.store.root, path.join(this.directory, "terminal.json"), {
        version: 1,
        receivedBytes: received + bytes.byteLength,
        commands: entries.length + 1,
        reason: "deadline-or-cumulative-capacity-exhausted",
      });
      throw Error("Local channel cumulative/deadline bound exceeded permanently");
    }
    const bounded = bytes.byteLength <= this.meta.limits.maxMessageBytes;
    const ingress = ingressSchema.parse({
      version: 1,
      index: entries.length,
      receivedBytes: bytes.byteLength,
      ...(bounded
        ? { rawBase64: Buffer.from(bytes).toString("base64"), messageSha256: digest(Buffer.from(bytes)) }
        : {}),
      ...(message ? { message } : {}),
      intent,
      ...(before ? { before } : {}),
    });
    const sha256 = channelWrite(this.store.root, this.file(ingress.index, "ingress"), ingress);
    return { ingress, sha256 };
  }
  finish(
    entry: Entry,
    reply: LocalEditorReply,
    pins: z.infer<typeof ChannelFilePinSchema>[] = [],
    acknowledges?: string,
    acknowledgementSha256?: string,
  ) {
    this.assertActive();
    const outcome = outcomeSchema.parse({
      version: 1,
      ingressSha256: entry.sha256,
      reply,
      pins,
      ...(acknowledges ? { acknowledges } : {}),
      ...(acknowledgementSha256 ? { acknowledgementSha256 } : {}),
    });
    if (Buffer.byteLength(JSON.stringify(outcome)) > this.meta.limits.maxReplyBytes)
      throw Error("Local channel outcome bound exceeded");
    const outcomeSha256 = channelWrite(this.store.root, this.file(entry.ingress.index, "outcome"), outcome);
    const observedAt = Date.now();
    if (acknowledgementSha256 && observedAt >= this.meta.expiresAt) {
      const marker = ackFailureSchema.parse({
        version: 1,
        projectId: this.store.projectId,
        editorId: this.store.editorId,
        activeLocalSessionId: this.localSessionId,
        index: entry.ingress.index,
        ingressSha256: entry.sha256,
        acknowledgementSha256,
        outcomeSha256,
        expiresAt: this.meta.expiresAt,
        observedAt,
        reason: "observed-post-publication-expiry",
      });
      try {
        channelWrite(this.store.root, this.file(entry.ingress.index, "ack-failure"), marker);
      } catch (error) {
        this.secondaryFailure =
          "Observed acknowledgement expiry; failure marker publication failed (durable pair may remain unmarked)";
        throw Error(this.secondaryFailure, { cause: error });
      }
    }
    this.assertActive();
  }
}
