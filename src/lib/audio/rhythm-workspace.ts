import path from "node:path";
import { rhythmFaultText } from "./rhythm-faults";
import {
  constants,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  type Stats,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { RhythmReadBudget, RhythmReadContext } from "./rhythm-files";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameBirth = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** Internal creation outcome, never request-supplied authority to release a reservation. */
export class RhythmWorkspaceCreationError extends Error {
  constructor(
    first: unknown,
    readonly retirementConfirmed: boolean,
    secondary: string[] = [],
  ) {
    super(`${rhythmFaultText(first)}${secondary.length ? "; " + secondary.join("; ") : ""}`, { cause: first });
  }
}

/** Internal owned workspace; no environment/request-selected storage or recursive cleanup. */
export class RhythmWorkspace {
  readonly directory: string;
  readonly source: string;
  private readonly parents: { file: string; identity: Stats }[] = [];
  private identity: Stats;
  private fileIdentity: Stats | undefined;
  private written: Buffer = Buffer.alloc(0);
  private context: RhythmReadContext | undefined;
  private retired = false;
  constructor(
    base: string,
    bytes: Buffer,
    extension: "wav" | "flac",
    private readonly budget: RhythmReadBudget,
  ) {
    if (!path.isAbsolute(base) || !["wav", "flac"].includes(extension) || bytes.length > 64 * 1024 * 1024)
      throw new RhythmWorkspaceCreationError(Error("Rhythm workspace input bound"), true);
    const normalized = path.resolve(base);
    let current = path.parse(normalized).root;
    try {
      for (const part of ["", ...normalized.slice(current.length).split(path.sep).filter(Boolean)]) {
        if (part) current = path.join(current, part);
        const identity = lstatSync(current);
        if (!identity.isDirectory() || identity.isSymbolicLink())
          throw Error("Rhythm workspace ancestor alias/non-directory");
        this.parents.push({ file: current, identity });
      }
    } catch (error) {
      throw new RhythmWorkspaceCreationError(error, true);
    }
    this.directory = path.join(normalized, "ai-video-rhythm-" + randomUUID());
    this.source = path.join(this.directory, "original." + extension);
    try {
      mkdirSync(this.directory, { mode: 0o700 });
      this.identity = lstatSync(this.directory);
    } catch (error) {
      throw new RhythmWorkspaceCreationError(error, false);
    }
    let failure: unknown,
      fd: number | undefined,
      closeFailed = false;
    const secondary: string[] = [];
    try {
      this.assertDirectory([]);
      fd = openSync(
        this.source,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      this.fileIdentity = fstatSync(fd);
      if (!this.fileIdentity.isFile() || (this.fileIdentity.mode & 0o777) !== 0o600)
        throw Error("Rhythm workspace original mode/type");
      let at = 0;
      while (at < bytes.length) {
        const n = writeSync(fd, bytes, at, bytes.length - at);
        if (!Number.isSafeInteger(n) || n < 1 || n > bytes.length - at) throw Error("Rhythm workspace short write");
        at += n;
        this.written = bytes.subarray(0, at);
      }
      fsyncSync(fd);
    } catch (error) {
      failure = error;
    } finally {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch (error) {
          closeFailed = true;
          if (failure) secondary.push(`workspace close: ${rhythmFaultText(error)}`);
          else failure = error;
        }
    }
    if (!failure)
      try {
        this.context = new RhythmReadContext(this.directory, budget);
        const consumed = this.context.read(path.basename(this.source), 64 * 1024 * 1024);
        if (consumed.pin.bytes !== bytes.length || consumed.pin.sha256 !== hash(bytes))
          throw Error("Rhythm workspace source SHA/bytes");
        this.assertUnchanged();
      } catch (error) {
        failure = error;
      }
    if (failure) {
      let cleaned = false;
      try {
        this.cleanup();
        cleaned = true;
      } catch (cleanup) {
        secondary.push(`workspace initial cleanup: ${rhythmFaultText(cleanup)}`);
      }
      throw new RhythmWorkspaceCreationError(failure, cleaned && !closeFailed, secondary);
    }
  }
  private assertDirectory(members: string[]) {
    for (const { file, identity } of this.parents) {
      const actual = lstatSync(file);
      if (!actual.isDirectory() || actual.isSymbolicLink() || !sameBirth(identity, actual))
        throw Error("Rhythm workspace ancestor replaced");
    }
    const actual = lstatSync(this.directory);
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      !sameBirth(this.identity, actual) ||
      (actual.mode & 0o777) !== 0o700
    )
      throw Error("Rhythm workspace directory replaced/mode");
    const current = readdirSync(this.directory).sort();
    if (JSON.stringify(current) !== JSON.stringify([...members].sort()))
      throw Error("Rhythm workspace membership changed");
  }
  assertUnchanged() {
    if (this.retired) throw Error("Rhythm workspace retired");
    this.assertDirectory([path.basename(this.source)]);
    const actual = lstatSync(this.source);
    if (
      !this.fileIdentity ||
      !actual.isFile() ||
      actual.isSymbolicLink() ||
      !sameBirth(this.fileIdentity, actual) ||
      (actual.mode & 0o777) !== 0o600
    )
      throw Error("Rhythm workspace original replaced/mode");
    this.context?.assertUnchanged();
  }
  cleanup() {
    if (this.retired) return;
    this.assertDirectory(this.fileIdentity ? [path.basename(this.source)] : []);
    if (this.fileIdentity) {
      const actual = lstatSync(this.source);
      if (
        !actual.isFile() ||
        actual.isSymbolicLink() ||
        !sameBirth(this.fileIdentity, actual) ||
        (actual.mode & 0o777) !== 0o600
      )
        throw Error("Rhythm workspace cleanup identity refused");
      const reader = new RhythmReadContext(this.directory, this.budget),
        consumed = reader.read(path.basename(this.source), 64 * 1024 * 1024);
      if (consumed.pin.bytes !== this.written.length || consumed.pin.sha256 !== hash(this.written))
        throw Error("Rhythm workspace cleanup SHA refused");
      reader.assertUnchanged();
      this.assertDirectory([path.basename(this.source)]);
      unlinkSync(this.source);
      this.fileIdentity = undefined;
    }
    this.assertDirectory([]);
    rmdirSync(this.directory);
    this.retired = true;
  }
}

export type TrustedRhythmWorkspaceFactory = (
  bytes: Buffer,
  extension: "wav" | "flac",
  budget: RhythmReadBudget,
) => RhythmWorkspace;
export const createRhythmWorkspace: TrustedRhythmWorkspaceFactory = (bytes, extension, budget) => {
  if (process.platform !== "darwin")
    throw new RhythmWorkspaceCreationError(Error("Rhythm private OS workspace unavailable"), true);
  return new RhythmWorkspace("/private/tmp", bytes, extension, budget);
};
