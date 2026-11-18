import { readWorkflowEvidence } from "../workflows/local-evidence";
import { workflowEvidenceExists } from "../workflows/local-evidence";
import { constants, openSync, closeSync, lstatSync, fstatSync, readSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
/** Finite immutable-observation capture; not a filesystem transaction or hostile-code sandbox. */
export class UnsupportedChapterInspection extends Error {}
export class ChapterInspectionInputs {
  private absentPaths = new Map<string, string>();
  private bytes = 0;
  private directories = 0;
  private sourceCount = 0;
  private directoryPins = new Map<string, { stat: Stats; membership: string }>();
  private captures = new Map<string, { scope: string; hash: string }>();
  absent(file: string, scope: string) {
    const base = path.resolve(scope),
      absolute = path.resolve(file),
      relative = path.relative(base, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).length > 32
    )
      throw Error("Inspection absence pin escapes scope");
    let current = base;
    for (const part of [".", ...relative.split(path.sep).slice(0, -1)]) {
      if (part !== ".") current = path.join(current, part);
      if (workflowEvidenceExists(current)) {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Inspection absent input parent alias refused");
      }
    }
    if (workflowEvidenceExists(absolute))
      throw new UnsupportedChapterInspection("Readonly cache inspection unsupported for " + path.basename(file));
    this.absentPaths.set(absolute, base);
  }
  read(file: string, scope: string, maxBytes: number) {
    if (this.captures.size >= 2048 && !this.captures.has(path.resolve(file)))
      throw Error("Inspection file count exceeds bound");
    const remaining = 256 * 1024 * 1024 - this.bytes;
    if (remaining < 1) throw Error("Inspection aggregate bytes exceed bound");
    const read = readWorkflowEvidence(file, scope, Math.min(maxBytes, remaining));
    this.bytes += read.byteLength;
    if (this.bytes > 256 * 1024 * 1024) throw Error("Inspection aggregate bytes exceed bound");
    const previous = this.captures.get(path.resolve(file));
    if (previous && previous.hash !== read.sha256) throw Error("Inspection input changed between consumed reads");
    this.captures.set(path.resolve(file), { scope: path.resolve(scope), hash: read.sha256 });
    return read;
  }
  json(file: string, scope: string, maxBytes: number) {
    return JSON.parse(this.read(file, scope, maxBytes).text);
  }
  hash(file: string, scope: string, maxBytes = 64 * 1024 * 1024) {
    const absolute = path.resolve(file),
      base = path.resolve(scope),
      relative = path.relative(base, absolute);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw Error("Inspection input escapes selected scope");
    if (this.captures.size >= 2048 && !this.captures.has(absolute)) throw Error("Inspection file count exceeds bound");
    const parents: { file: string; stat: Stats }[] = [];
    let parent = base;
    for (const part of [".", ...relative.split(path.sep).slice(0, -1)]) {
      if (part !== ".") parent = path.join(parent, part);
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Inspection parent alias refused");
      parents.push({ file: parent, stat });
    }
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes)
      throw Error("Inspection input must be bounded regular file");
    if (this.bytes + before.size > 256 * 1024 * 1024) throw Error("Inspection aggregate bytes exceed bound");
    const same = (a: Stats, b: Stats) =>
      a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (!same(before, fstatSync(fd))) throw Error("Inspection input changed");
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      let total = 0;
      while (total < before.size) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - total), null);
        if (!n) throw Error("Inspection input truncated");
        hash.update(buffer.subarray(0, n));
        total += n;
      }
      if (readSync(fd, buffer, 0, 1, null) !== 0 || !same(before, fstatSync(fd)) || !same(before, lstatSync(absolute)))
        throw Error("Inspection input changed");
      for (const p of parents) {
        const now = lstatSync(p.file);
        if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== p.stat.dev || now.ino !== p.stat.ino)
          throw Error("Inspection parent changed");
      }
      const result = hash.digest("hex");
      const previous = this.captures.get(absolute);
      if (previous && previous.hash !== result) throw Error("Inspection input changed between consumed reads");
      this.bytes += total;
      this.captures.set(absolute, { scope: base, hash: result });
      return result;
    } finally {
      closeSync(fd);
    }
  }
  sourceFiles(directory: string, scope: string, depth = 0): string[] {
    if (depth > 24 || ++this.directories > 2048) throw Error("Renderer source depth/directory count exceeds bound");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Renderer source alias refused");
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > 2048) throw Error("Renderer source directory exceeds bound");
    const membership = JSON.stringify(
      entries
        .map((e) => [e.name, e.isDirectory(), e.isFile(), e.isSymbolicLink()])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const after = lstatSync(directory);
    if (
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw Error("Renderer directory changed during enumeration");
    this.directoryPins.set(directory, { stat: after, membership });
    return entries
      .flatMap((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw Error("Renderer source alias refused");
        if (entry.isDirectory()) return this.sourceFiles(file, scope, depth + 1);
        if (/\.(tsx?|css)$/.test(file)) {
          if (++this.sourceCount > 2048) throw Error("Renderer source file count exceeds bound");
          return [file];
        }
        return [];
      })
      .sort();
  }
  assertUnchanged() {
    for (const [directory, pin] of this.directoryPins) {
      const stat = lstatSync(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== pin.stat.dev ||
        stat.ino !== pin.stat.ino ||
        stat.mtimeMs !== pin.stat.mtimeMs ||
        stat.ctimeMs !== pin.stat.ctimeMs
      )
        throw Error("Renderer directory changed after capture");
      const entries = readdirSync(directory, { withFileTypes: true });
      if (entries.length > 2048) throw Error("Renderer directory exceeds bound");
      const membership = JSON.stringify(
        entries
          .map((e) => [e.name, e.isDirectory(), e.isFile(), e.isSymbolicLink()])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
      const after = lstatSync(directory);
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        membership !== pin.membership
      )
        throw Error("Renderer closure membership changed after capture");
    }
    for (const [file, scope] of this.absentPaths) this.absent(file, scope);
    const captures = [...this.captures];
    for (const [file, pin] of captures)
      if (this.hash(file, pin.scope) !== pin.hash) throw Error("Chapter inputs changed during inspection");
  }
}
