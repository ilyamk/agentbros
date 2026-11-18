import path from "node:path";
import {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  fstatSync,
  constants,
  lstatSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  linkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { RhythmReadContext } from "./rhythm-files";
import type { RhythmArtifactStage } from "./rhythm-artifact-stage";
import { RhythmFilePinSchema, RhythmProjectSchema } from "../../types/rhythm-evidence";
const MiB = 1024 * 1024;
function syncDirectory(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isDirectory()) throw Error("Rhythm fsync parent not a directory");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Cooperative immutable publisher. Exact wx ownership, no cache replacement/deletion. */
export class RhythmPublisher {
  private readonly owned: { file: string; dev: number; ino: number; sha256: string }[] = [];
  private readonly directories: { file: string; dev: number; ino: number }[] = [];
  private bytes = 0;
  private retained = false;
  publicationOccurred = false;
  installationOccurred = false;
  private transientBytes = 0;
  private transientDirectories = 0;
  private readonly stageReservations = new WeakMap<
    RhythmArtifactStage,
    Map<string, { bytes: number; sha256: string; retire: () => void }>
  >();
  constructor(
    readonly context: RhythmReadContext,
    readonly projectId: string,
    readonly maximumBytes = 64 * MiB,
  ) {
    RhythmProjectSchema.parse(projectId);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * MiB)
      throw Error("Rhythm artifact bound");
  }
  /** Internal lease-bound reservation: retirement releases peak capacity, never lifetime allocation. */
  reserveTransient(bytes: number, directories: 0 | 1 = 1) {
    if (
      ![0, 1].includes(directories) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.bytes + bytes > this.maximumBytes
    )
      throw Error("Rhythm new artifact byte bound");
    this.checkCapacity(bytes, directories);
    this.bytes += bytes;
    this.transientBytes += bytes;
    this.transientDirectories += directories;
    let released = false;
    return () => {
      if (released) throw Error("Rhythm transient reservation already retired");
      released = true;
      this.transientBytes -= bytes;
      this.transientDirectories -= directories;
    };
  }
  directory(relative: string) {
    RhythmFilePinSchema.shape.path.parse(relative);
    let prefix = "";
    for (const part of relative.split("/")) {
      prefix = prefix ? prefix + "/" + part : part;
      const file = path.join(this.context.root, prefix);
      try {
        const stat = lstatSync(file);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Rhythm publisher parent alias");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        this.context.prepareCreation(prefix);
        mkdirSync(file);
        const made = lstatSync(file);
        this.directories.push({ file, dev: made.dev, ino: made.ino });
        this.context.enrollCreated(prefix);
        syncDirectory(path.dirname(file));
      }
    }
  }
  /** A candidate target directory is created exclusively; existing foreign/old paths are never adopted. */
  exclusiveDirectory(relative: string) {
    const file = this.context.prepareCreation(relative);
    this.checkCapacity(0, 1);
    mkdirSync(file, { mode: 0o700 });
    const made = lstatSync(file);
    this.directories.push({ file, dev: made.dev, ino: made.ino });
    this.context.enrollCreated(relative);
    syncDirectory(path.dirname(file));
  }
  /** Allocation is reserved even if writing fails partway; only proven stage retirement releases peak. */
  stageWrite(stage: RhythmArtifactStage, name: string, bytes: Buffer) {
    let rows = this.stageReservations.get(stage);
    if (!rows) {
      rows = new Map();
      this.stageReservations.set(stage, rows);
    }
    if (rows.has(name)) throw Error("Rhythm stage allocation already reserved");
    const retire = this.reserveTransient(bytes.length, 0),
      pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    rows.set(name, { ...pin, retire });
    stage.write(name, bytes);
    return pin;
  }
  retireStage(stage: RhythmArtifactStage) {
    if (!stage.retirementConfirmed) throw Error("Rhythm stage retirement unconfirmed; reservation retained");
    const rows = this.stageReservations.get(stage);
    if (!rows) return;
    for (const own of rows.values()) own.retire();
    this.stageReservations.delete(stage);
  }
  /** Hardlink installation allocates no new data; overlap stays charged by transient reservations. */
  install(
    relative: string,
    stage: RhythmArtifactStage,
    name: string,
    beforeLink: () => void,
    kind?: { publicEvidence: true },
  ) {
    const prefix = `public/projects/${this.projectId}/pipeline/rhythm/`;
    if (
      kind &&
      (Object.keys(kind).length !== 1 ||
        kind.publicEvidence !== true ||
        name !== "evidence-staged.json" ||
        !relative.startsWith(prefix) ||
        !/^[a-f0-9]{64}\.evidence\.json$/.test(relative.slice(prefix.length)))
    )
      throw Error("Rhythm closed public evidence role/path");
    const reserved = this.stageReservations.get(stage)?.get(name);
    if (!reserved) throw Error("Rhythm artifact install requires owned allocation");
    const source = stage.source(name);
    if (!source.initialized) throw Error("Rhythm artifact metadata state uninitialized");
    if (reserved.bytes !== source.bytes || reserved.sha256 !== source.sha256)
      throw Error("Rhythm stage allocation differs");
    const file = this.context.prepareCreation(relative),
      parent = lstatSync(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== source.dev)
      throw Error("Rhythm artifact install requires same device");
    this.checkCapacity(source.bytes);
    beforeLink();
    linkSync(source.file, file);
    if (kind?.publicEvidence) {
      this.publicationOccurred = true;
      this.retained = true;
    }
    this.installationOccurred = true;
    this.retained = true;
    this.owned.push({ file, dev: source.dev, ino: source.ino, sha256: source.sha256 });
    stage.linked(name, file);
    this.context.enrollCreated(relative);
    syncDirectory(path.dirname(file));
    return { path: relative, bytes: source.bytes, sha256: source.sha256 };
  }
  checkCapacity(addBytes = 0, addDirectory = 0) {
    const directory = path.join(this.context.root, `.cache/rhythm-evidence/${this.projectId}`);
    let total = this.transientBytes,
      count = this.transientDirectories;
    const scan = (dir: string, depth: number) => {
      if (depth > 2) throw Error("Rhythm private nesting bound");
      const members = readdirSync(dir);
      if (members.length > 258) throw Error("Rhythm private membership bound");
      for (const name of members) {
        const file = path.join(dir, name),
          stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw Error("Rhythm private alias");
        if (stat.isDirectory()) {
          if (depth !== 0) throw Error("Rhythm unexpected nested private directory");
          count++;
          scan(file, depth + 1);
        } else if (stat.isFile()) {
          if (!Number.isSafeInteger(stat.size) || stat.size > 64 * MiB) throw Error("Rhythm private file bound");
          total += stat.size;
        } else throw Error("Rhythm private nonregular file");
      }
    };
    scan(directory, 0);
    if (count + addDirectory > 32 || total + addBytes > 256 * MiB)
      throw Error("Rhythm project private capacity exhausted");
    return { total, count };
  }
  write(relative: string, bytes: Buffer) {
    if (this.bytes + bytes.length > this.maximumBytes) throw Error("Rhythm new artifact byte bound");
    this.checkCapacity(bytes.length);
    const file = this.context.prepareCreation(relative);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const identity = lstatSync(file);
    this.owned.push({
      file,
      dev: identity.dev,
      ino: identity.ino,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    try {
      let at = 0;
      while (at < bytes.length) {
        const n = writeSync(fd, bytes, at, bytes.length - at);
        if (!n) throw Error("Rhythm publication short write");
        at += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.bytes += bytes.length;
    this.context.enrollCreated(relative);
    syncDirectory(path.dirname(file));
    return { path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  publish(relative: string, bytes: Buffer, staged: string, beforeLink?: () => void) {
    if (bytes.length > 2 * MiB) throw Error("Rhythm public evidence report bound");
    const from = this.write(staged, bytes),
      file = this.context.prepareCreation(relative);
    this.checkCapacity(bytes.length);
    beforeLink?.();
    linkSync(path.join(this.context.root, staged), file);
    this.publicationOccurred = true;
    this.retained = true;
    const identity = lstatSync(file);
    this.owned.push({ file, dev: identity.dev, ino: identity.ino, sha256: from.sha256 });
    this.context.enrollCreated(relative);
    syncDirectory(path.dirname(file));
    return { ...from, path: relative };
  }
  retire(relative: string) {
    const file = path.join(this.context.root, relative),
      own = this.owned.find((x) => x.file === file);
    if (!own) throw Error("Rhythm retirement not owned");
    this.verifyOwned(own);
    unlinkSync(file);
    this.context.retireOwnedMember(relative);
    this.owned.splice(this.owned.indexOf(own), 1);
  }
  retireDirectory(relative: string) {
    const file = path.join(this.context.root, relative);
    const own = this.directories.find((x) => x.file === file),
      stat = lstatSync(file);
    if (!own || stat.dev !== own.dev || stat.ino !== own.ino || stat.isSymbolicLink() || readdirSync(file).length)
      throw Error("Rhythm staging directory not owned/empty");
    rmdirSync(file);
    this.context.retireOwnedMember(relative);
    this.directories.splice(this.directories.indexOf(own), 1);
  }
  private verifyOwned(own: { file: string; dev: number; ino: number; sha256: string }) {
    const stat = lstatSync(own.file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.dev !== own.dev ||
      stat.ino !== own.ino ||
      stat.size > this.maximumBytes
    )
      throw Error("Rhythm owned publication replaced; refusing cleanup");
    const relative = path.relative(this.context.root, own.file),
      reader = new RhythmReadContext(this.context.root, this.context.budget),
      pin = reader.read(relative, this.maximumBytes).pin;
    if (pin.sha256 !== own.sha256) throw Error("Rhythm owned publication bytes changed; refusing cleanup");
  }
  retain() {
    this.retained = true;
  }
  cleanup() {
    if (this.retained) return;
    for (const own of [...this.owned].reverse()) {
      try {
        this.verifyOwned(own);
        unlinkSync(own.file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    for (const dir of [...this.directories].reverse()) {
      try {
        const stat = lstatSync(dir.file);
        if (stat.dev !== dir.dev || stat.ino !== dir.ino || !stat.isDirectory() || stat.isSymbolicLink())
          throw Error("Rhythm owned directory replaced; refusing cleanup");
        if (readdirSync(dir.file).length === 0) rmdirSync(dir.file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
}
