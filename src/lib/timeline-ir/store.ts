import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TimelineIR, EditCommand } from "../../types/timeline";
import { EditCommandSchema } from "../../types/timeline";
import { validateTimeline, compileTimelineIR } from "./compiler";
import { applyEdit } from "./commands";

export class RevisionConflict extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(`Timeline revision conflict: expected ${expected}, actual ${actual}`);
  }
}
export type EditHistory = {
  command: EditCommand;
  before: TimelineIR;
  after: TimelineIR;
};
export type EditDocument = {
  version: 1;
  revision: number;
  timeline: TimelineIR;
  undo: EditHistory[];
  redo: EditHistory[];
};

/** Existing edit-document validation applied to already consumed bounded JSON by read-only clients. */
export function parseTimelineEditDocument(input: unknown): EditDocument {
  const doc = input as EditDocument;
  if (
    doc.version !== 1 ||
    !Number.isSafeInteger(doc.revision) ||
    doc.revision < 0 ||
    !Array.isArray(doc.undo) ||
    !Array.isArray(doc.redo)
  )
    throw new Error("Invalid edit journal version or revision");
  validateTimeline(doc.timeline);
  for (const item of [...doc.undo, ...doc.redo]) {
    EditCommandSchema.parse(item.command);
    validateTimeline(item.before);
    validateTimeline(item.after);
  }
  return structuredClone(doc);
}

/** One atomic journal file contains document, immutable snapshots and history. */
export class TimelineEditStore {
  constructor(
    public readonly file: string,
    private readonly validateCandidate?: (timeline: TimelineIR, command: EditCommand) => void,
  ) {}
  read(): EditDocument {
    return parseTimelineEditDocument(JSON.parse(readFileSync(this.file, "utf8")));
  }

  initialize(timeline: unknown): EditDocument {
    return this.lock(() => {
      if (existsSync(this.file)) throw new Error("Timeline already initialized");
      const doc: EditDocument = {
        version: 1,
        revision: 0,
        timeline: validateTimeline(timeline),
        undo: [],
        redo: [],
      };
      this.save(doc);
      return structuredClone(doc);
    });
  }
  dryRun(command: unknown, expectedRevision: number) {
    const doc = this.read();
    this.check(doc, expectedRevision);
    const parsed = EditCommandSchema.parse(command);
    const timeline = applyEdit(doc.timeline, parsed);
    this.validateCandidate?.(timeline, parsed);
    return {
      revision: doc.revision,
      timeline,
      snapshot: compileTimelineIR(timeline),
    };
  }
  apply(command: unknown, expectedRevision: number) {
    return this.lock(() => {
      const doc = this.read();
      this.check(doc, expectedRevision);
      const parsed = EditCommandSchema.parse(command);
      const after = applyEdit(doc.timeline, parsed);
      this.validateCandidate?.(after, parsed);
      doc.undo.push({ command: parsed, before: doc.timeline, after });
      doc.timeline = after;
      doc.redo = [];
      doc.revision++;
      this.save(doc);
      return structuredClone(doc);
    });
  }
  undo(expectedRevision: number) {
    return this.navigate("undo", expectedRevision);
  }
  redo(expectedRevision: number) {
    return this.navigate("redo", expectedRevision);
  }
  private navigate(direction: "undo" | "redo", expected: number) {
    return this.lock(() => {
      const doc = this.read();
      this.check(doc, expected);
      const entry = doc[direction].pop();
      if (!entry) throw new Error(`Nothing to ${direction}`);
      const candidate = structuredClone(direction === "undo" ? entry.before : entry.after);
      this.validateCandidate?.(candidate, entry.command);
      doc.timeline = candidate;
      doc[direction === "undo" ? "redo" : "undo"].push(entry);
      doc.revision++;
      this.save(doc);
      return structuredClone(doc);
    });
  }
  private check(doc: EditDocument, expected: number) {
    if (!Number.isSafeInteger(expected) || expected < 0)
      throw new Error("Expected revision must be a nonnegative integer");
    if (doc.revision !== expected) throw new RevisionConflict(expected, doc.revision);
  }
  private lock<T>(run: () => T): T {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const lockFile = this.file + ".lock";
    let fd: number;
    try {
      fd = openSync(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Timeline is locked by another editor");
      throw error;
    }
    try {
      return run();
    } finally {
      closeSync(fd);
      unlinkSync(lockFile);
    }
  }
  private save(doc: EditDocument) {
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      const fd = openSync(temporary, "wx");
      try {
        writeFileSync(fd, JSON.stringify(doc, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
      // Sync directory metadata on filesystems that support directory handles.
      if (process.platform !== "win32") {
        const directory = openSync(path.dirname(this.file), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
