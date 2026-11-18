import path from "node:path";
import {
  constants,
  mkdirSync,
  lstatSync,
  readdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  fstatSync,
  unlinkSync,
  rmdirSync,
  type Stats,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { RhythmReadBudget, RhythmReadContext } from "./rhythm-files";
import { rhythmFaultText } from "./rhythm-faults";
import { artifactRoles, type RhythmArtifactRole, type TrustedRhythmMetadataService } from "./rhythm-artifact-metadata";
import type { RhythmProcessBounds } from "./rhythm-process";
const MiB = 1024 * 1024;
const names = new Set(Object.keys(artifactRoles));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameBirth = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const sameContentIdentity = (a: Stats, b: Stats) =>
  sameBirth(a, b) &&
  a.size === b.size &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.mtimeMs === b.mtimeMs;
type Owned = { identity: Stats; sha256: string; bytes: number; target?: string; initialized?: true };
export class RhythmArtifactStageCreationError extends Error {
  constructor(
    first: unknown,
    readonly retirementConfirmed: boolean,
  ) {
    super(rhythmFaultText(first), { cause: first });
  }
}
/** New producer-owned files only; no held original/current pin is refreshed. */
export class RhythmArtifactStage {
  readonly directory: string;
  private identity: Stats | undefined;
  private readonly parents: { file: string; identity: Stats }[] = [];
  private readonly files = new Map<string, Owned>();
  private retired = false;
  private descriptorClosureUnconfirmed = false;
  constructor(
    base: string,
    readonly budget: RhythmReadBudget,
  ) {
    if (!path.isAbsolute(base))
      throw new RhythmArtifactStageCreationError(Error("Rhythm artifact stage absolute base required"), true);
    const normalized = path.resolve(base);
    let current = path.parse(normalized).root;
    try {
      for (const part of ["", ...normalized.slice(current.length).split(path.sep).filter(Boolean)]) {
        if (part) current = path.join(current, part);
        const identity = lstatSync(current);
        if (!identity.isDirectory() || identity.isSymbolicLink()) throw Error("Rhythm artifact stage ancestor alias");
        this.parents.push({ file: current, identity });
      }
    } catch (error) {
      throw new RhythmArtifactStageCreationError(error, true);
    }
    this.directory = path.join(normalized, "ai-video-rhythm-artifacts-" + randomUUID());
    try {
      mkdirSync(this.directory, { mode: 0o700 });
      this.identity = lstatSync(this.directory);
      this.assertDirectory();
    } catch (error) {
      let retired = false;
      if (this.identity)
        try {
          this.cleanup();
          retired = true;
        } catch {
          /* Unknown ownership stays reserved. */
        }
      throw new RhythmArtifactStageCreationError(error, retired);
    }
  }
  private assertDirectory() {
    if (this.retired) throw Error("Rhythm artifact stage retired");
    for (const { file, identity } of this.parents) {
      const current = lstatSync(file);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameBirth(identity, current))
        throw Error("Rhythm artifact stage ancestor replaced");
    }
    const current = lstatSync(this.directory);
    if (
      !this.identity ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameBirth(current, this.identity) ||
      (current.mode & 0o777) !== 0o700
    )
      throw Error("Rhythm artifact stage replaced/mode");
    if (JSON.stringify(readdirSync(this.directory).sort()) !== JSON.stringify([...this.files.keys()].sort()))
      throw Error("Rhythm artifact stage unexpected membership");
  }
  private current(name: string) {
    const own = this.files.get(name);
    if (!own) throw Error("Rhythm artifact stage member not owned");
    const current = lstatSync(path.join(this.directory, name));
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameContentIdentity(own.identity, current) ||
      current.ctimeMs !== own.identity.ctimeMs ||
      current.nlink !== own.identity.nlink ||
      (current.mode & 0o777) !== 0o600
    )
      throw Error("Rhythm artifact stage file changed");
    return { own, current };
  }
  assertUnchanged() {
    this.assertDirectory();
    for (const name of this.files.keys()) this.current(name);
  }
  write(name: string, bytes: Buffer) {
    this.assertUnchanged();
    if (!names.has(name) || this.files.has(name) || bytes.length > artifactRoles[name as RhythmArtifactRole])
      throw Error("Rhythm artifact stage fixed member/byte bound");
    const file = path.join(this.directory, name);
    let fd: number | undefined,
      first: unknown,
      failed = false;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const identity = fstatSync(fd);
      this.files.set(name, { identity, sha256: sha(Buffer.alloc(0)), bytes: 0 });
      let at = 0;
      while (at < bytes.length) {
        const written = writeSync(fd, bytes, at, bytes.length - at);
        if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - at)
          throw Error("Rhythm artifact stage short write");
        at += written;
        this.files.set(name, { identity: fstatSync(fd), sha256: sha(bytes.subarray(0, at)), bytes: at });
      }
      fsyncSync(fd);
      this.files.set(name, { identity: fstatSync(fd), sha256: sha(bytes), bytes: bytes.length });
    } catch (error) {
      failed = true;
      first = error;
    } finally {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch (error) {
          this.descriptorClosureUnconfirmed = true;
          if (!failed) {
            failed = true;
            first = error;
          }
        }
    }
    if (failed) throw first;
    this.assertUnchanged();
    return { bytes: bytes.length, sha256: sha(bytes) };
  }
  async initialize(name: RhythmArtifactRole, service: TrustedRhythmMetadataService, bounds: RhythmProcessBounds) {
    this.assertUnchanged();
    const { own } = this.current(name);
    if (own.initialized || own.target) throw Error("Rhythm generated metadata initialization state");
    const source = this.source(name);
    let fd: number | undefined,
      failed = false,
      first: unknown;
    try {
      fd = openSync(source.file, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const before = fstatSync(fd);
      if (!sameContentIdentity(own.identity, before) || before.ctimeMs !== own.identity.ctimeMs || before.nlink !== 1)
        throw Error("Rhythm metadata inherited FD changed");
      await service.initialize({ fd, role: name, bytes: own.bytes, sha256: own.sha256, budget: this.budget, bounds });
      const after = fstatSync(fd),
        lexical = lstatSync(source.file);
      if (
        !after.isFile() ||
        !lexical.isFile() ||
        lexical.isSymbolicLink() ||
        !sameContentIdentity(before, after) ||
        after.nlink !== before.nlink ||
        !sameContentIdentity(after, lexical) ||
        after.ctimeMs !== lexical.ctimeMs
      )
        throw Error("Rhythm controlled generated metadata identity changed");
      const consumed = new RhythmReadContext(this.directory, this.budget).read(name, artifactRoles[name]);
      if (consumed.pin.bytes !== own.bytes || consumed.pin.sha256 !== own.sha256)
        throw Error("Rhythm controlled generated metadata bytes changed");
      this.files.set(name, { ...own, identity: after, initialized: true });
      this.assertUnchanged();
    } catch (error) {
      failed = true;
      first = error;
    } finally {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch (error) {
          this.descriptorClosureUnconfirmed = true;
          if (!failed) {
            failed = true;
            first = error;
          }
        }
    }
    if (failed) throw first;
  }
  source(name: string) {
    this.assertUnchanged();
    const { own } = this.current(name),
      file = path.join(this.directory, name),
      reader = new RhythmReadContext(this.directory, this.budget),
      consumed = reader.read(name, 64 * MiB);
    if (consumed.pin.bytes !== own.bytes || consumed.pin.sha256 !== own.sha256)
      throw Error("Rhythm staged bytes changed");
    reader.assertUnchanged();
    this.assertUnchanged();
    return {
      file,
      bytes: own.bytes,
      sha256: own.sha256,
      dev: own.identity.dev,
      ino: own.identity.ino,
      initialized: own.initialized === true,
    };
  }
  /** Only called after this producer's successful exclusive link, before any persistent read pin. */
  linked(name: string, target: string) {
    const own = this.files.get(name);
    if (!own || own.target || !own.initialized) throw Error("Rhythm artifact link ownership/metadata state");
    const source = lstatSync(path.join(this.directory, name)),
      installed = lstatSync(target);
    if (
      !source.isFile() ||
      source.isSymbolicLink() ||
      !sameContentIdentity(own.identity, source) ||
      source.nlink !== own.identity.nlink + 1 ||
      !sameContentIdentity(source, installed) ||
      source.ctimeMs !== installed.ctimeMs ||
      source.nlink !== installed.nlink ||
      installed.isSymbolicLink()
    )
      throw Error("Rhythm artifact exclusive link identity differs");
    this.files.set(name, { ...own, identity: source, target });
    this.assertUnchanged();
  }
  /** Retire only exact producer-owned private names; linked PRIMARY bytes are retained. */
  cleanup(beforeRetire: () => void = () => {}) {
    if (this.retired) return;
    if (this.descriptorClosureUnconfirmed)
      throw Error("Rhythm generated descriptor closure unconfirmed; manual reconciliation required");
    this.assertUnchanged();
    for (const name of [...this.files.keys()].reverse()) {
      beforeRetire();
      const source = this.source(name),
        own = this.files.get(name)!;
      if (own.target) {
        const installed = lstatSync(own.target);
        if (
          !installed.isFile() ||
          installed.isSymbolicLink() ||
          !sameContentIdentity(own.identity, installed) ||
          installed.ctimeMs !== own.identity.ctimeMs ||
          installed.nlink !== own.identity.nlink
        )
          throw Error("Rhythm installed target changed before private retirement");
      }
      this.assertUnchanged();
      unlinkSync(source.file);
      this.files.delete(name);
      if (own.target) {
        const installed = lstatSync(own.target);
        if (
          !installed.isFile() ||
          installed.isSymbolicLink() ||
          !sameContentIdentity(own.identity, installed) ||
          installed.nlink !== own.identity.nlink - 1
        )
          throw Error("Rhythm installed target changed during private retirement");
      }
      this.assertDirectory();
    }
    beforeRetire();
    this.assertDirectory();
    rmdirSync(this.directory);
    this.retired = true;
  }
  get retirementConfirmed() {
    return this.retired;
  }
}
export type TrustedRhythmArtifactStageFactory = (budget: RhythmReadBudget) => RhythmArtifactStage;
export const createRhythmArtifactStage: TrustedRhythmArtifactStageFactory = (budget) => {
  if (process.platform !== "darwin")
    throw new RhythmArtifactStageCreationError(Error("Rhythm artifact OS stage unavailable"), true);
  return new RhythmArtifactStage("/private/tmp", budget);
};
