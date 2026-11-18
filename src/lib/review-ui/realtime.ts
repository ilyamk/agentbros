import path from "node:path";
import { existsSync, readdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { z } from "zod";
import { digest } from "../jobs/model-artifacts";
import {
  RealtimeEditorStore,
  RealtimeEditorSchema,
  readRealtimeEditorRequest,
  RealtimeDeriveSchema,
} from "../realtime/editor";
import { inspectLocalEditorHistory } from "../realtime/channel-journal";
import { RealtimeSessionRequestSchema } from "../realtime/session";
import { RealtimeStillDraftSchema, prepareRealtimeStill, listRealtimeStills } from "../realtime/still-input";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/);
const expected = z.number().int().nonnegative().max(255);
export const ReviewRealtimeMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), editorId: id, ceilingUsd: z.number().positive().finite() }).strict(),
  z.object({ action: z.literal("add"), editorId: id, expected, request: RealtimeSessionRequestSchema }).strict(),
  z.object({ action: z.literal("add-asset"), editorId: id, expected, draft: RealtimeStillDraftSchema }).strict(),
  z
    .object({ action: z.literal("add-file"), editorId: id, expected, requestFile: z.string().min(1).max(1024) })
    .strict(),
  z.object({ action: z.literal("derive"), editorId: id, expected, patch: RealtimeDeriveSchema }).strict(),
  z.object({ action: z.literal("queue"), editorId: id, expected, revisionId: id }).strict(),
  z.object({ action: z.literal("handoff"), editorId: id, expected }).strict(),
  z.object({ action: z.literal("cancel"), editorId: id, expected }).strict(),
  z.object({ action: z.literal("recover"), editorId: id, expected }).strict(),
  z
    .object({
      action: z.literal("complete"),
      editorId: id,
      expected,
      revisionId: id,
      manifest: z.string().min(1).max(1024),
    })
    .strict(),
  z.object({ action: z.literal("select"), editorId: id, expected, revisionId: id }).strict(),
]);
export class RealtimeReviewConflict extends Error {}
/** No tokens, transport connection, arbitrary executables or generation are imported here. */
export class RealtimeReviewService {
  constructor(
    readonly root: string,
    readonly projectId: string,
  ) {}
  private safe(file: string) {
    const rel = path.relative(this.root, file);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      throw new Error("Realtime path outside workspace");
    let current = this.root;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw new Error("Realtime artifact paths cannot use symlinks");
    }
    return file;
  }
  private read(file: string, expectedHash?: string) {
    this.safe(file);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw new Error("Realtime review artifact exceeds 64 KiB");
      const bytes = Buffer.alloc(stat.size);
      let at = 0;
      while (at < bytes.length) {
        const n = readSync(fd, bytes, at, bytes.length - at, null);
        if (!n) throw new Error("Realtime artifact changed");
        at += n;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("Realtime artifact grew");
      if (expectedHash && digest(bytes) !== expectedHash) throw new Error("Realtime manifest hash mismatch");
      return JSON.parse(bytes.toString());
    } finally {
      closeSync(fd);
    }
  }
  private store(editorId: string) {
    id.parse(editorId);
    return new RealtimeEditorStore(this.root, this.projectId, editorId);
  }
  list() {
    const directory = this.safe(path.join(this.root, ".cache/realtime-editors", this.projectId));
    const editors: {
        editorId: string;
        sequence: number;
        committedUsd: number;
        ceilingUsd: number;
        selected?: string;
      }[] = [],
      errors: { identity: string; message: string }[] = [];
    if (!existsSync(directory)) return { editors, errors, offline: true };
    const dirs = readdirSync(directory);
    if (dirs.length > 64) throw new Error("Realtime editor discovery exceeds 64 directories");
    for (const name of dirs) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      try {
        const first = RealtimeEditorSchema.parse(this.read(path.join(directory, name, "000.json")));
        if (digest(first.editorId) !== name || first.projectId !== this.projectId)
          throw new Error("Realtime discovery identity mismatch");
        const state = this.store(first.editorId).read();
        editors.push({
          editorId: state.editorId,
          sequence: state.sequence,
          committedUsd: state.committedUsd,
          ceilingUsd: state.ceilingUsd,
          selected: state.selected,
        });
      } catch (error) {
        errors.push({ identity: name, message: error instanceof Error ? error.message : "Invalid editor" });
      }
    }
    return { editors, errors, offline: true };
  }
  view(editorId: string) {
    const state = this.store(editorId).read();
    const selected = state.revisions.find((r) => r.revisionId === state.selected);
    const frames: { file: string; sha256: string }[] = [];
    if (selected?.result) {
      const manifest = this.read(path.resolve(this.root, selected.result.path), selected.result.sha256);
      for (const [index, frame] of manifest.frames.entries()) {
        this.safe(path.resolve(this.root, frame.path));
        frames.push({ file: `@realtime/${digest(editorId)}/${selected.result.sha256}/${index}`, sha256: frame.sha256 });
      }
    }
    return { ...state, frames, offline: true, selectionIsApproval: false };
  }
  stillSources() {
    return listRealtimeStills(this.root, this.projectId);
  }
  request(editorId: string, revisionId: string) {
    id.parse(revisionId);
    return this.store(editorId).request(revisionId);
  }
  deriveSource(editorId: string, revisionId: string) {
    id.parse(revisionId);
    const store = this.store(editorId),
      state = store.read(),
      entry = state.revisions.find((r) => r.revisionId === revisionId);
    if (!entry) throw Error("Unknown source revision");
    const original = store.request(revisionId),
      input = Object.fromEntries(
        Object.entries(original.operation.input).filter(([key]) =>
          [
            "prompt",
            "seed",
            "num_inference_steps",
            "schedule_mu",
            "output_feedback_strength",
            "image_size",
            "enable_interpolation",
          ].includes(key),
        ),
      );
    return {
      sourceRevision: revisionId,
      requestSha256: entry.request.sha256,
      input,
      limits: original.limits,
      offline: true,
      providerAck: false,
      providerBilling: false,
    };
  }
  mutate(raw: unknown) {
    const input = ReviewRealtimeMutationSchema.parse(raw),
      store = this.store(input.editorId);
    let sourceInput: ReturnType<typeof prepareRealtimeStill>["sourceInput"] | undefined;
    if (input.action === "create") {
      if (existsSync(store.directory))
        throw new RealtimeReviewConflict("Editor already exists; refresh without replay");
      const parent = this.safe(path.dirname(store.directory));
      if (existsSync(parent) && readdirSync(parent).length >= 64)
        throw new Error("Realtime editor discovery capacity reached");
      try {
        store.create(input.ceilingUsd);
      } catch (error) {
        if (error instanceof Error && /conflict/.test(error.message)) throw new RealtimeReviewConflict(error.message);
        throw error;
      }
    } else {
      if (store.read().sequence !== input.expected)
        throw new RealtimeReviewConflict("Editor sequence changed; refresh without replay");
      const inspection = inspectLocalEditorHistory(store);
      if (inspection.leasePresent || inspection.unresolvedCount > 0)
        throw new RealtimeReviewConflict(
          "Local channel history/lease requires explicit channel inspection and reconciliation; no HTTP replay",
        );
      inspection.recheck();
      try {
        switch (input.action) {
          case "add-asset": {
            const prepared = prepareRealtimeStill(this.root, this.projectId, input.draft);
            try {
              inspection.recheck();
              prepared.recheck();
              store.add(input.expected, prepared.request);
              sourceInput = prepared.sourceInput;
            } finally {
              prepared.close();
            }
            break;
          }
          case "add":
            store.add(input.expected, input.request);
            break;
          case "add-file": {
            if (path.isAbsolute(input.requestFile) || input.requestFile.includes("\\"))
              throw new Error("Request file must be project-relative");
            const file = this.safe(path.resolve(this.root, "public/projects", this.projectId, input.requestFile));
            if (!file.startsWith(path.join(this.root, "public/projects", this.projectId) + path.sep))
              throw new Error("Request file outside project");
            store.add(input.expected, readRealtimeEditorRequest(file));
            break;
          }
          case "derive":
            store.derive(input.expected, input.patch);
            break;
          case "queue":
            store.queue(input.expected, input.revisionId);
            break;
          case "handoff":
            store.handoff(input.expected);
            break;
          case "cancel":
            store.cancel(input.expected);
            break;
          case "recover":
            store.recover(input.expected);
            break;
          case "select":
            store.select(input.expected, input.revisionId);
            break;
          case "complete": {
            if (path.isAbsolute(input.manifest) || input.manifest.includes("\\"))
              throw new Error("Manifest must be a project-relative path");
            const file = this.safe(path.resolve(this.root, "public/projects", this.projectId, input.manifest));
            const base = path.join(this.root, "public/projects", this.projectId, "pipeline/realtime") + path.sep;
            if (!file.startsWith(base)) throw new Error("Manifest outside selected project's realtime artifacts");
            store.complete(input.expected, input.revisionId, file);
            break;
          }
        }
      } catch (error) {
        if (error instanceof Error && /conflict/.test(error.message)) throw new RealtimeReviewConflict(error.message);
        throw error;
      }
    }
    const view = this.view(input.editorId);
    return sourceInput
      ? {
          ...view,
          sourceInput: {
            ...sourceInput,
            requestSha256: view.revisions.find(
              (r) => r.revisionId === (input.action === "add-asset" ? input.draft.revisionId : ""),
            )!.request.sha256,
          },
        }
      : view;
  }
  private frame(ref: string) {
    const match = /^@realtime\/([a-f0-9]{64})\/([a-f0-9]{64})\/([01])$/.exec(ref);
    if (!match) throw new Error("Invalid realtime preview reference");
    const editor = this.list().editors.find((e) => digest(e.editorId) === match[1]);
    if (!editor) throw new Error("Realtime editor unavailable");
    const state = this.store(editor.editorId).read(),
      revision = state.revisions.find((r) => r.revisionId === state.selected);
    if (!revision?.result) throw new Error("No selected completed realtime result");
    if (revision.result.sha256 !== match[2])
      throw new Error("Preview selection changed; refresh the exact selected result");
    const manifest = this.read(path.resolve(this.root, revision.result.path), revision.result.sha256),
      frame = manifest.frames[Number(match[3])];
    if (!frame) throw new Error("Realtime frame missing");
    const file = this.safe(path.resolve(this.root, frame.path));
    if (!file.startsWith(path.join(this.root, "public/projects", this.projectId) + path.sep))
      throw new Error("Realtime frame outside project");
    return { file, sha256: frame.sha256 }; // controller read verifies durable publication and every pin
  }
  file(ref: string) {
    return this.frame(ref).file;
  }
  verifyDescriptor(ref: string, fd: number) {
    const frame = this.frame(ref),
      before = fstatSync(fd);
    if (!before.isFile() || before.size > 16 * 1024 * 1024)
      throw new Error("Realtime original exceeds regular file bound");
    const bytes = Buffer.alloc(before.size);
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (!n) throw new Error("Realtime original changed");
      at += n;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || digest(bytes) !== frame.sha256)
      throw new Error("Realtime original descriptor hash mismatch");
  }
}
