import { z } from "zod";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  fsyncSync,
  constants,
  lstatSync,
} from "node:fs";
import { assertPathWithin, validateProjectId } from "../cli";
import { digest } from "../jobs/model-artifacts";
import { PriceQuoteSchema } from "../jobs/types";
import { OperationStore } from "../jobs/store";
import { planRealtimeSession, RealtimeSessionRequestSchema, type RealtimeSessionRequest } from "./session";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pin = z.object({ path: z.string(), sha256: hash }).strict();
const lineage = z.object({ revisionId: id, requestSha256: hash }).strict();
const revision = z
  .object({
    revisionId: id,
    request: pin,
    inputHash: hash,
    sessionId: id,
    highUsd: z.number().positive(),
    status: z.enum(["draft", "queued", "superseded", "in-flight", "uncertain", "cancelled", "complete"]),
    result: pin.optional(),
    derivedFrom: lineage.optional(),
  })
  .strict();
export const RealtimeEditorSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    editorId: id,
    sequence: z.number().int().nonnegative().max(255),
    ceilingUsd: z.number().positive().finite(),
    revisions: z.array(revision).max(32),
    queued: id.optional(),
    inFlight: id.optional(),
    selected: id.optional(),
    committedUsd: z.number().nonnegative().finite(),
    providerAck: z.literal(false),
    liveVerified: z.literal(false),
  })
  .strict();
export type RealtimeEditor = z.infer<typeof RealtimeEditorSchema>;
/** Exact checked-in Flux2KleinRealtimeInput fields only; image and transport remain pinned. */
export const RealtimeDeriveInputSchema = z
  .object({
    prompt: z.string().min(1).max(4096).optional(),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    num_inference_steps: z.number().int().min(1).max(8).optional(),
    schedule_mu: z.number().min(0.3).max(2.5).optional(),
    output_feedback_strength: z.number().min(0).max(1).optional(),
    image_size: z.enum(["square", "square_hd"]).optional(),
    enable_interpolation: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one explicit input edit required");
const freshQuote = PriceQuoteSchema.strict().refine(
  (q) => q.confidence === "user-bound" && !q.providerEnforced && !q.forecastEvidence,
  "Derived draft requires a fresh explicit user-bound quote, not provider billing",
);
export const RealtimeDeriveSchema = z
  .object({ sourceRevision: id, revisionId: id, sessionId: id, input: RealtimeDeriveInputSchema, quote: freshQuote })
  .strict();
export type RealtimeDerive = z.input<typeof RealtimeDeriveSchema>;
const editedFields = new Set([
  "prompt",
  "seed",
  "num_inference_steps",
  "schedule_mu",
  "output_feedback_strength",
  "image_size",
  "enable_interpolation",
]);
function parseDerive(raw: unknown) {
  if (Buffer.byteLength(JSON.stringify(raw)) > 16384) throw Error("Derived patch exceeds 16 KiB");
  return RealtimeDeriveSchema.parse(raw);
}

/** Bounded FD reads, including a final growth check; never follow supplied symlinks. */
function read(file: string, maximum: number): Buffer {
  const initial = lstatSync(file);
  if (initial.isSymbolicLink()) throw Error("Editor artifact cannot be a symlink");
  if (!initial.isFile() || initial.size > maximum) throw Error("Editor artifact exceeds regular file bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Editor artifact exceeds regular file bound");
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const count = readSync(fd, bytes, at, bytes.length - at, null);
      if (!count) throw new Error("Editor artifact changed while reading");
      at += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("Editor artifact grew while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function readRealtimeEditorRequest(file: string) {
  return RealtimeSessionRequestSchema.parse(JSON.parse(read(file, 6 * 1024 * 1024).toString()));
}
export function readRealtimeDerive(file: string) {
  return parseDerive(JSON.parse(read(file, 16384).toString()));
}
function immutable(file: string, bytes: Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error("Editor revision conflict; read latest state before retry");
    }
    const directory = openSync(path.dirname(file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
/** No execution callbacks, credentials, sockets or billing reconciliation are part of this offline controller. */
export class RealtimeEditorStore {
  readonly root: string;
  readonly directory: string;
  constructor(
    root: string,
    readonly projectId: string,
    readonly editorId: string,
  ) {
    validateProjectId(projectId);
    id.parse(editorId);
    this.root = path.resolve(root);
    const project = path.join(this.root, "public/projects", projectId);
    assertPathWithin(this.root, project);
    let component = this.root;
    for (const part of path.relative(this.root, project).split(path.sep)) {
      component = path.join(component, part);
      if (existsSync(component) && lstatSync(component).isSymbolicLink())
        throw new Error("Editor project boundary cannot use symlinks");
    }
    if (!existsSync(path.join(project, "project.json"))) throw new Error("Editor project missing");
    this.directory = path.join(this.root, ".cache/realtime-editors", projectId, digest(editorId));
    assertPathWithin(this.root, this.directory);
    this.privateBoundary();
  }
  private privateBoundary() {
    assertPathWithin(this.root, this.directory);
    let ancestor = this.root;
    for (const part of path.relative(this.root, this.directory).split(path.sep)) {
      ancestor = path.join(ancestor, part);
      if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
        throw new Error("Private editor directory cannot use symlinks");
    }
  }
  private file(sequence: number) {
    return path.join(this.directory, `${String(sequence).padStart(3, "0")}.json`);
  }
  private checked(pinValue: z.infer<typeof pin>, maximum: number) {
    const file = path.resolve(this.root, pinValue.path);
    assertPathWithin(this.root, file);
    const bytes = read(file, maximum);
    if (digest(bytes) !== pinValue.sha256) throw new Error("Editor artifact hash mismatch");
    return bytes;
  }
  create(ceilingUsd: number): RealtimeEditor {
    this.privateBoundary();
    mkdirSync(this.directory, { recursive: true });
    const state = RealtimeEditorSchema.parse({
      version: 1,
      projectId: this.projectId,
      editorId: this.editorId,
      sequence: 0,
      ceilingUsd,
      revisions: [],
      committedUsd: 0,
      providerAck: false,
      liveVerified: false,
    });
    immutable(this.file(0), Buffer.from(JSON.stringify(state)));
    return state;
  }
  read(): RealtimeEditor {
    this.privateBoundary();
    const files = readdirSync(this.directory)
      .filter((name) => /^\d{3}\.json$/.test(name))
      .sort();
    if (!files.length || files.length > 256) throw new Error("Editor history missing or out of bounds");
    const state = RealtimeEditorSchema.parse(
      JSON.parse(read(path.join(this.directory, files.at(-1)!), 65536).toString()),
    );
    if (
      state.projectId !== this.projectId ||
      state.editorId !== this.editorId ||
      files.at(-1) !== `${String(state.sequence).padStart(3, "0")}.json`
    )
      throw new Error("Editor state identity mismatch");
    if (
      files.length !== state.sequence + 1 ||
      files.some((file, index) => file !== `${String(index).padStart(3, "0")}.json`)
    )
      throw new Error("Editor history is incomplete");
    if (
      new Set(state.revisions.map((entry) => entry.revisionId)).size !== state.revisions.length ||
      new Set(state.revisions.map((entry) => entry.sessionId)).size !== state.revisions.length
    )
      throw new Error("Editor identities reused");
    for (const entry of state.revisions) {
      assertPathWithin(this.directory, path.resolve(this.root, entry.request.path));
      const request = RealtimeSessionRequestSchema.parse(
        JSON.parse(this.checked(entry.request, 6 * 1024 * 1024).toString()),
      );
      const plan = planRealtimeSession(request);
      if (
        request.projectId !== state.projectId ||
        request.revisionId !== entry.revisionId ||
        request.sessionId !== entry.sessionId ||
        plan.inputHash !== entry.inputHash ||
        request.quote.highUsd !== entry.highUsd
      )
        throw new Error("Editor request identity mismatch");
      if (entry.derivedFrom) {
        const sourceIndex = state.revisions.findIndex((r) => r.revisionId === entry.derivedFrom!.revisionId),
          entryIndex = state.revisions.indexOf(entry),
          source = state.revisions[sourceIndex];
        if (sourceIndex < 0 || sourceIndex >= entryIndex || source.request.sha256 !== entry.derivedFrom.requestSha256)
          throw Error("Derived source lineage mismatch");
        const original = this.requestFromPin(source.request);
        if (
          JSON.stringify({ ...original.operation, input: undefined }) !==
            JSON.stringify({ ...request.operation, input: undefined }) ||
          JSON.stringify(original.limits) !== JSON.stringify(request.limits)
        )
          throw Error("Derived request changed pinned operation or limits");
        for (const key of new Set([...Object.keys(original.operation.input), ...Object.keys(request.operation.input)]))
          if (
            !editedFields.has(key) &&
            JSON.stringify(original.operation.input[key]) !== JSON.stringify(request.operation.input[key])
          )
            throw Error("Derived request changed pinned original input");
        freshQuote.parse(request.quote);
      }
      if (entry.result) this.verifyResult(state, entry, entry.result);
    }
    const committed = state.revisions
      .filter((entry) => ["in-flight", "uncertain", "complete"].includes(entry.status))
      .reduce((sum, entry) => sum + entry.highUsd, 0);
    if (Math.abs(committed - state.committedUsd) > 1e-9 || committed > state.ceilingUsd + 1e-12)
      throw new Error("Editor aggregate liability invariant failed");
    const queued = state.revisions.filter((entry) => entry.status === "queued");
    const active = state.revisions.filter((entry) => entry.status === "in-flight");
    if (
      queued.length > 1 ||
      active.length > 1 ||
      queued[0]?.revisionId !== state.queued ||
      active[0]?.revisionId !== state.inFlight ||
      (state.selected &&
        !state.revisions.some((entry) => entry.revisionId === state.selected && entry.status === "complete"))
    )
      throw new Error("Editor queue/selection invariant failed");
    return state;
  }
  private save(expected: number, change: (state: RealtimeEditor) => void) {
    const state = this.read();
    if (state.sequence !== expected) throw new Error("Editor revision conflict; read latest state before retry");
    change(state);
    state.sequence++;
    const checked = RealtimeEditorSchema.parse(state);
    immutable(this.file(checked.sequence), Buffer.from(JSON.stringify(checked)));
    return checked;
  }
  add(expected: number, input: RealtimeSessionRequest) {
    return this.addPinned(expected, input);
  }
  derive(expected: number, raw: RealtimeDerive) {
    const patch = parseDerive(raw),
      state = this.read();
    if (state.sequence !== expected) throw Error("Editor revision conflict");
    const source = state.revisions.find((r) => r.revisionId === patch.sourceRevision);
    if (!source) throw Error("Unknown source revision");
    const original = this.requestFromPin(source.request);
    const request = {
      ...original,
      revisionId: patch.revisionId,
      sessionId: patch.sessionId,
      quote: patch.quote,
      operation: { ...original.operation, input: { ...original.operation.input, ...patch.input } },
    };
    return this.addPinned(expected, request, { revisionId: source.revisionId, requestSha256: source.request.sha256 });
  }
  private addPinned(expected: number, input: RealtimeSessionRequest, derivedFrom?: z.infer<typeof lineage>) {
    const planned = planRealtimeSession(input),
      request = planned.request;
    if (request.projectId !== this.projectId) throw new Error("Editor project must match request");
    id.parse(request.sessionId);
    id.parse(request.revisionId);
    const state = this.read();
    if (state.sequence !== expected) throw new Error("Editor revision conflict");
    if (state.sequence >= 255) throw Error("Editor history capacity exceeded");
    if (
      state.revisions.length >= 32 ||
      state.revisions.some((entry) => entry.revisionId === request.revisionId || entry.sessionId === request.sessionId)
    )
      throw new Error("Editor revision/session reused or capacity exceeded");
    const bytes = Buffer.from(JSON.stringify(request));
    const file = path.join(this.directory, `${digest(bytes)}.request.json`);
    if (!existsSync(file)) immutable(file, bytes);
    return this.save(expected, (current) =>
      current.revisions.push({
        revisionId: request.revisionId,
        sessionId: request.sessionId,
        request: { path: path.relative(this.root, file), sha256: digest(bytes) },
        inputHash: planned.inputHash,
        highUsd: request.quote.highUsd,
        status: "draft",
        ...(derivedFrom ? { derivedFrom } : {}),
      }),
    );
  }
  queue(expected: number, revisionId: string) {
    return this.save(expected, (state) => {
      const entry = state.revisions.find((item) => item.revisionId === revisionId);
      if (!entry || entry.status !== "draft") throw new Error("Only unsent drafts can be queued");
      if (state.queued) state.revisions.find((item) => item.revisionId === state.queued)!.status = "superseded";
      entry.status = "queued";
      state.queued = revisionId;
    });
  }
  /** Explicit handoff marks possible liability before another caller may execute; it does not send. */
  handoff(expected: number) {
    return this.save(expected, (state) => {
      if (state.inFlight || state.revisions.some((entry) => entry.status === "uncertain"))
        throw new Error("Unresolved capture requires explicit reconciliation; no reconnect/replay");
      const entry = state.revisions.find((item) => item.revisionId === state.queued);
      if (!entry) throw new Error("No queued input");
      if (state.committedUsd + entry.highUsd > state.ceilingUsd + 1e-12)
        throw new Error("Editor aggregate planning ceiling exceeded");
      state.committedUsd += entry.highUsd;
      entry.status = "in-flight";
      state.inFlight = entry.revisionId;
      delete state.queued;
    });
  }
  cancel(expected: number) {
    return this.save(expected, (state) => {
      if (state.queued) {
        state.revisions.find((entry) => entry.revisionId === state.queued)!.status = "cancelled";
        delete state.queued;
      }
      if (state.inFlight) {
        state.revisions.find((entry) => entry.revisionId === state.inFlight)!.status = "uncertain";
        delete state.inFlight;
      }
    });
  }
  recover(expected: number) {
    return this.save(expected, (state) => {
      if (state.inFlight) {
        state.revisions.find((entry) => entry.revisionId === state.inFlight)!.status = "uncertain";
        delete state.inFlight;
      }
    });
  }
  private requestFromPin(value: z.infer<typeof pin>) {
    return RealtimeSessionRequestSchema.parse(JSON.parse(this.checked(value, 6 * 1024 * 1024).toString()));
  }
  request(revisionId: string) {
    const entry = this.read().revisions.find((item) => item.revisionId === revisionId);
    if (!entry) throw new Error("Unknown revision");
    return RealtimeSessionRequestSchema.parse(JSON.parse(this.checked(entry.request, 6 * 1024 * 1024).toString()));
  }
  private verifyResult(state: RealtimeEditor, entry: RealtimeEditor["revisions"][number], result: z.infer<typeof pin>) {
    assertPathWithin(
      path.join(this.root, "public/projects", this.projectId, "pipeline/realtime"),
      path.resolve(this.root, result.path),
    );
    const value = JSON.parse(this.checked(result, 65536).toString());
    if (
      value.projectId !== state.projectId ||
      value.sessionId !== entry.sessionId ||
      value.revisionId !== entry.revisionId ||
      value.inputHash !== entry.inputHash ||
      value.operationId !== `realtime:${entry.sessionId}` ||
      value.provenance?.providerAck !== false ||
      value.endpoint !== "fal-ai/flux-2/klein/realtime" ||
      !Array.isArray(value.frames) ||
      value.frames.length < 1 ||
      value.frames.length > 2
    )
      throw new Error("Result cannot be associated with editor revision");
    // The financial store requires an existing policy; absence is never evidence of a published capture.
    let job;
    try {
      job = new OperationStore(this.projectId, {
        directory: path.join(this.root, "public/projects", this.projectId, "pipeline"),
      }).snapshot().jobs[value.operationId];
    } catch {
      throw new Error("Result lacks published durable capture evidence");
    }
    if (
      !job ||
      job.state !== "published" ||
      job.inputHash !== entry.inputHash ||
      job.result?.captureManifestHash !== result.sha256
    )
      throw new Error("Result lacks published durable capture evidence");
    const planned = planRealtimeSession(this.requestFromPin(entry.request));
    if (value.frames.length !== planned.expectedFrames) throw new Error("Result frame count differs from input");
    for (const frame of value.frames) {
      assertPathWithin(path.join(this.root, "public/projects", this.projectId), path.resolve(this.root, frame.path));
      pin.parse({ path: frame.path, sha256: frame.sha256 });
      this.checked(frame, 16 * 1024 * 1024);
    }
  }
  complete(expected: number, revisionId: string, manifest: string) {
    return this.save(expected, (state) => {
      const entry = state.revisions.find((item) => item.revisionId === revisionId);
      if (!entry || !["in-flight", "uncertain"].includes(entry.status))
        throw new Error("Late/unsubmitted result rejected");
      const file = path.resolve(this.root, manifest);
      assertPathWithin(path.join(this.root, "public/projects", this.projectId, "pipeline/realtime"), file);
      const result = { path: path.relative(this.root, file), sha256: digest(read(file, 65536)) };
      this.verifyResult(state, entry, result);
      entry.result = result;
      entry.status = "complete";
      if (state.inFlight === revisionId) delete state.inFlight;
    });
  }
  select(expected: number, revisionId: string) {
    return this.save(expected, (state) => {
      if (!state.revisions.some((entry) => entry.revisionId === revisionId && entry.status === "complete"))
        throw new Error("Only verified completed previews can be selected");
      state.selected = revisionId;
    });
  }
}
