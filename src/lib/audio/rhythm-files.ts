import path from "node:path";
import { constants, openSync, closeSync, lstatSync, fstatSync, readSync, readdirSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { RhythmFilePinSchema, type RhythmMarks } from "../../types/rhythm-evidence";
export function rhythmDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object")
      return `{${Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
        .join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
type RefusalReason =
  | "sha256"
  | "bytes"
  | "dev"
  | "ino"
  | "size"
  | "mtimeMs"
  | "ctimeMs"
  | "missing"
  | "nonregular"
  | "identity-refusal"
  | "byte-bound"
  | "growth-refusal"
  | "read-refusal"
  | "accounting-refusal";
type RefusalObservation = {
  identity?: Stats;
  bytes?: number;
  sha256?: string;
  kind: "regular" | "symlink" | "other" | "missing" | "unknown";
  reason?: RefusalReason;
};
const scalarStats = (s?: Stats) =>
  s
    ? Object.fromEntries(
        ["dev", "ino", "size", "mtimeMs", "ctimeMs"].map((key) => {
          const n = s[key as keyof Stats];
          return [key, typeof n === "number" && Number.isFinite(n) ? n : null];
        }),
      )
    : null;
/** Refusal evidence only: scalar copies, no file content or additional filesystem read. */
function refusedPin(
  error: unknown,
  pin: { path: string; sha256: string; bytes: number },
  identity: Stats,
  observation: RefusalObservation,
) {
  if (!(error instanceof Error) || Object.hasOwn(error, "rhythmRefusal")) return error;
  const reasons: RefusalReason[] = [];
  if (observation.sha256 !== undefined && observation.sha256 !== pin.sha256) reasons.push("sha256");
  if (observation.bytes !== undefined && observation.bytes !== pin.bytes) reasons.push("bytes");
  if (observation.identity)
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
      if (identity[key] !== observation.identity[key]) reasons.push(key);
  if (observation.reason) reasons.push(observation.reason);
  if (!reasons.length) reasons.push("read-refusal");
  const diagnostic = Object.freeze({
    version: 1,
    path: pin.path,
    reasons: Object.freeze(reasons),
    expected: Object.freeze({ sha256: pin.sha256, bytes: pin.bytes, identity: Object.freeze(scalarStats(identity)!) }),
    observed: Object.freeze({
      sha256: observation.sha256 ?? null,
      bytes: observation.bytes ?? null,
      identity: observation.identity ? Object.freeze(scalarStats(observation.identity)!) : null,
      kind: observation.kind,
    }),
  });
  const encoded = JSON.stringify(diagnostic);
  if (Buffer.byteLength(encoded, "utf8") > 8192 || reasons.length > 12) return error;
  try {
    Object.defineProperty(error, "rhythmRefusal", {
      value: diagnostic,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    error.message += `; rhythmRefusal=${encoded}`;
  } catch {
    /* Diagnostic attachment must never replace a nonextensible primary error. */
  }
  return error;
}
export class RhythmReadBudget {
  consumed = 0;
  charge(bytes: number) {
    this.consumed += bytes;
    if (this.consumed > 256 * 1024 * 1024) throw Error("Rhythm admitted verification threshold exceeded");
  }
}
export class RhythmReadContext {
  readonly root: string;
  private readonly rootIdentity: Stats;
  private readonly members = new Map<string, string[]>();
  private readonly pins = new Map<
    string,
    { pin: { path: string; sha256: string; bytes: number }; maximum: number; identity: Stats }
  >();
  private readonly absent = new Set<string>();
  private readonly parents = new Map<string, Stats>();
  constructor(
    root: string,
    readonly budget = new RhythmReadBudget(),
  ) {
    this.root = path.resolve(root);
    this.rootIdentity = lstatSync(this.root);
    if (!this.rootIdentity.isDirectory() || this.rootIdentity.isSymbolicLink())
      throw Error("Rhythm trusted root must be a non-alias directory");
    this.captureMembers(this.root);
  }
  private captureMembers(dir: string) {
    const names = readdirSync(dir).sort();
    if (names.length > 8192) throw Error("Rhythm directory membership bound");
    const old = this.members.get(dir);
    if (old && JSON.stringify(old) !== JSON.stringify(names)) throw Error("Rhythm directory membership changed");
    this.members.set(dir, names);
  }
  private boundary(relative: string) {
    const checked = RhythmFilePinSchema.shape.path.parse(relative),
      file = path.resolve(this.root, checked),
      rel = path.relative(this.root, file);
    if (!rel || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
      throw Error("Rhythm file outside trusted root");
    let dir = this.root;
    for (const part of rel.split(path.sep).slice(0, -1)) {
      dir = path.join(dir, part);
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Rhythm parent alias/non-directory");
      const prior = this.parents.get(dir);
      if (prior && (prior.ino !== stat.ino || prior.dev !== stat.dev)) throw Error("Rhythm parent identity changed");
      this.parents.set(dir, stat);
      this.captureMembers(dir);
    }
    return file;
  }
  private consume(relative: string, maximum: number, observation?: RefusalObservation) {
    if (observation) observation.reason = "read-refusal";
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 * 1024 * 1024)
      throw Error("Invalid rhythm read bound");
    const file = this.boundary(relative),
      before = lstatSync(file);
    if (observation) {
      observation.identity = before;
      observation.kind = before.isSymbolicLink() ? "symlink" : before.isFile() ? "regular" : "other";
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      if (observation) observation.reason = "nonregular";
      throw Error("Rhythm input must be regular/non-alias");
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const initial = fstatSync(fd);
      if (observation) {
        observation.identity = initial;
        observation.reason = initial.size > maximum ? "byte-bound" : "identity-refusal";
      }
      if (!initial.isFile() || !same(before, initial) || !Number.isSafeInteger(initial.size) || initial.size > maximum)
        throw Error("Rhythm regular input identity/byte bound");
      const bytes = Buffer.alloc(initial.size);
      let at = 0;
      if (observation) observation.reason = "read-refusal";
      while (at < bytes.length) {
        const count = readSync(fd, bytes, at, bytes.length - at, null);
        if (!count) throw Error("Rhythm input truncated");
        at += count;
      }
      if (observation) {
        observation.bytes = bytes.length;
        observation.reason = "growth-refusal";
      }
      const observedStat = (s: Stats) => {
        if (observation) observation.identity = s;
        return s;
      };
      if (
        readSync(fd, Buffer.alloc(1), 0, 1, null) ||
        !same(initial, observedStat(fstatSync(fd))) ||
        !same(initial, observedStat(lstatSync(file)))
      ) {
        if (observation) observation.sha256 = hash(bytes);
        throw Error("Rhythm input grew/changed");
      }
      if (observation) observation.reason = "accounting-refusal";
      this.budget.charge(bytes.length);
      const pin = { path: relative, sha256: hash(bytes), bytes: bytes.length };
      if (observation) {
        observation.sha256 = pin.sha256;
        observation.reason = undefined;
      }
      return { bytes, pin, identity: initial };
    } finally {
      closeSync(fd);
    }
  }
  read(relative: string, maximum: number) {
    const captured = this.pins.get(relative),
      observation: RefusalObservation = { kind: "unknown" };
    let result: ReturnType<RhythmReadContext["consume"]>;
    try {
      result = this.consume(relative, maximum, captured ? observation : undefined);
    } catch (error) {
      throw captured ? refusedPin(error, captured.pin, captured.identity, observation) : error;
    }
    const prior = this.pins.get(relative);
    if (
      prior &&
      (prior.pin.sha256 !== result.pin.sha256 ||
        prior.pin.bytes !== result.pin.bytes ||
        !same(prior.identity, result.identity))
    )
      throw refusedPin(Error("Rhythm consumed pin changed"), prior.pin, prior.identity, observation);
    this.pins.set(relative, { pin: result.pin, maximum, identity: result.identity });
    return result;
  }
  json(relative: string, maximum: number) {
    const result = this.read(relative, maximum);
    return { ...result, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)) as unknown };
  }
  check(raw: unknown, maximum: number) {
    const pin = RhythmFilePinSchema.parse(raw);
    if (pin.bytes > maximum) throw Error("Rhythm pin exceeds role byte bound");
    const result = this.read(pin.path, maximum);
    if (result.pin.sha256 !== pin.sha256 || result.pin.bytes !== pin.bytes) throw Error("Rhythm artifact pin changed");
    return result;
  }
  optional(relative: string, maximum: number) {
    const file = this.boundary(relative);
    try {
      lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.absent.add(relative);
      return null;
    }
    return this.read(relative, maximum);
  }
  /** Publisher-only exact member enrollment, never an arbitrary membership refresh. */
  prepareCreation(relative: string) {
    const file = this.boundary(relative);
    try {
      lstatSync(file);
      throw Error("Rhythm publication member already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return file;
  }
  enrollCreated(relative: string) {
    RhythmFilePinSchema.shape.path.parse(relative);
    const file = path.join(this.root, relative),
      parent = path.dirname(file),
      prior = this.members.get(parent);
    if (!prior) throw Error("Rhythm publication parent not captured");
    const expected = [...prior, path.basename(file)].sort();
    if (JSON.stringify(readdirSync(parent).sort()) !== JSON.stringify(expected))
      throw Error("Rhythm unexpected publication membership");
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw Error("Rhythm created member not regular");
    this.members.set(parent, expected);
    if (stat.isDirectory()) {
      this.parents.set(file, stat);
      this.captureMembers(file);
    }
  }
  retireOwnedMember(relative: string) {
    RhythmFilePinSchema.shape.path.parse(relative);
    const file = path.join(this.root, relative),
      parent = path.dirname(file),
      prior = this.members.get(parent);
    if (!prior || !prior.includes(path.basename(file))) throw Error("Rhythm retirement member not enrolled");
    const expected = prior.filter((n) => n !== path.basename(file));
    if (JSON.stringify(readdirSync(parent).sort()) !== JSON.stringify(expected))
      throw Error("Rhythm unexpected retirement membership");
    this.members.set(parent, expected);
    this.pins.delete(relative);
    this.absent.delete(relative);
    this.parents.delete(file);
    this.members.delete(file);
  }
  snapshotPins(): RhythmMarks["currentPins"] {
    return [
      ...[...this.pins.values()].map((p) => ({ kind: "present" as const, ...p.pin })),
      ...[...this.absent].map((path) => ({ kind: "absent" as const, path })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  assertUnchanged() {
    const root = lstatSync(this.root);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.dev !== this.rootIdentity.dev ||
      root.ino !== this.rootIdentity.ino
    )
      throw Error("Rhythm trusted root changed");
    for (const [dir, names] of this.members) {
      const current = readdirSync(dir).sort();
      if (JSON.stringify(current) !== JSON.stringify(names)) {
        const missing = [...this.pins.values()].find(
          ({ pin }) =>
            path.dirname(path.join(this.root, pin.path)) === dir && !current.includes(path.basename(pin.path)),
        );
        const error = Error("Rhythm directory membership changed");
        throw missing
          ? refusedPin(error, missing.pin, missing.identity, { kind: "missing", reason: "missing" })
          : error;
      }
    }
    for (const relative of this.absent) {
      const file = this.boundary(relative);
      try {
        lstatSync(file);
        throw Error("Rhythm absent input appeared");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const { pin, maximum, identity } of this.pins.values()) {
      const observation: RefusalObservation = { kind: "unknown" };
      let result: ReturnType<RhythmReadContext["consume"]>;
      try {
        result = this.consume(pin.path, maximum, observation);
      } catch (error) {
        throw refusedPin(error, pin, identity, observation);
      }
      const actual = result.pin;
      if (actual.sha256 !== pin.sha256 || actual.bytes !== pin.bytes || !same(identity, result.identity))
        throw refusedPin(Error("Rhythm current file pin changed"), pin, identity, observation);
    }
    for (const [file, initial] of this.parents) {
      const actual = lstatSync(file);
      if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== initial.dev || actual.ino !== initial.ino)
        throw Error("Rhythm parent changed");
    }
  }
  diagnostics() {
    return {
      consumedBytes: this.budget.consumed,
      thresholdBytes: 256 * 1024 * 1024,
      maximumSingleReadOvershootBytes: 128 * 1024 * 1024,
      physicalIoCap: false as const,
    };
  }
}
