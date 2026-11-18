import path from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, readlinkSync, fstatSync, type Stats, type BigIntStats } from "node:fs";
import { z } from "zod";
import { RhythmReadBudget, RhythmReadContext, rhythmDigest } from "./rhythm-files";
import { runRhythmOwnedProcess, type RhythmProcessBounds } from "./rhythm-process";
export const artifactRoles = {
  "original.wav": 64 * 1024 * 1024,
  "original.flac": 64 * 1024 * 1024,
  "clock.json": 4 * 1024 * 1024,
  "pcm.f32": 19200000,
  "initial-config.json": 8 * 1024 * 1024,
  "initial-registry.json": 4 * 1024 * 1024,
  "commit.json": 65536,
  "evidence-staged.json": 2 * 1024 * 1024,
} as const;
export type RhythmArtifactRole = keyof typeof artifactRoles;
export type RhythmMetadataIdentity = { version: "darwin-owned-generated-fd-v1"; sha256: string };
export type RhythmMetadataInvocation = {
  fd: number;
  role: RhythmArtifactRole;
  bytes: number;
  sha256: string;
  budget: RhythmReadBudget;
  bounds: RhythmProcessBounds;
};
export type TrustedRhythmMetadataService = {
  identity: RhythmMetadataIdentity;
  assertUnchanged: () => void;
  initialize: (input: RhythmMetadataInvocation) => Promise<void>;
};
const root = "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/";
const python = root + "bin/python3.9",
  ctypes = root + "lib/python3.9/ctypes/__init__.py",
  extension = root + "lib/python3.9/lib-dynload/_ctypes.cpython-39-darwin.so";
const aliases = [
  [
    "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
    "../../Library/Frameworks/Python3.framework/Versions/3.9/bin/python3",
  ],
  [root + "bin/python3", "python3.9"],
  ["/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk", "MacOSX27.0.sdk"],
] as const;
const sdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk/usr/include/sys/stat.h";
const helper = fileURLToPath(new URL("./rhythm-artifact-metadata.py", import.meta.url));
const birth = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
type TrustedMetadataLayout = {
  python: string;
  ctypes: string;
  extension: string;
  shim: string;
  helper: string;
  sdk: string;
  aliases: readonly (readonly [string, string])[];
};
const fixedLayout: TrustedMetadataLayout = {
  python,
  ctypes,
  extension,
  shim: "/usr/bin/python3",
  helper,
  sdk,
  aliases,
};
function captureInstallation(budget: RhythmReadBudget, layout: TrustedMetadataLayout) {
  const { python, ctypes, extension, shim, helper, sdk, aliases } = layout;
  if (aliases.length !== 3) throw Error("Rhythm exact metadata alias closure bound");
  const contexts: RhythmReadContext[] = [],
    pins: Record<string, unknown> = {},
    inputParents: { file: string; identity: Stats }[] = [];
  const parents = (file: string) => {
    let current = "/";
    inputParents.push({ file: current, identity: lstatSync(current) });
    for (const part of path.dirname(file).split("/").filter(Boolean)) {
      current = path.join(current, part);
      const identity = lstatSync(current);
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw Error("Rhythm metadata input ancestor alias");
      inputParents.push({ file: current, identity });
    }
  };
  for (const [name, file, maximum] of [
    ["python", python, 32 * 1024 * 1024],
    ["ctypes", ctypes, 1024 * 1024],
    ["_ctypes", extension, 32 * 1024 * 1024],
    ["shim", shim, 1024 * 1024],
    ["helper", helper, 1024 * 1024],
    ["sdk", sdk, 1024 * 1024],
  ] as const) {
    parents(file);
    const context = new RhythmReadContext(path.dirname(file), budget),
      consumed = context.read(path.basename(file), maximum);
    contexts.push(context);
    pins[name] = { ...consumed.pin, path: file };
    if (
      name === "sdk" &&
      (!consumed.bytes.includes(Buffer.from("#define UF_TRACKED              0x00000040")) ||
        !consumed.bytes.includes(Buffer.from("int     fchflags(int, __uint32_t);")))
    )
      throw Error("Rhythm fixed SDK metadata ABI changed");
  }
  const aliasPins = aliases.map(([file, target]) => {
    const parents: { file: string; identity: Stats }[] = [];
    let current = "/";
    for (const part of path.dirname(file).split("/").filter(Boolean)) {
      current = path.join(current, part);
      const identity = lstatSync(current);
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw Error("Rhythm metadata alias ancestor");
      parents.push({ file: current, identity });
    }
    const identity = lstatSync(file);
    if (!identity.isSymbolicLink() || readlinkSync(file) !== target)
      throw Error("Rhythm metadata explicit alias changed");
    return { file, target, identity, parents };
  });
  const assertUnchanged = () => {
    for (const parent of inputParents) {
      const now = lstatSync(parent.file);
      if (!now.isDirectory() || now.isSymbolicLink() || !birth(now, parent.identity))
        throw Error("Rhythm metadata input ancestor changed");
    }
    for (const context of contexts) context.assertUnchanged();
    for (const own of aliasPins) {
      for (const parent of own.parents) {
        const now = lstatSync(parent.file);
        if (!now.isDirectory() || now.isSymbolicLink() || !birth(now, parent.identity))
          throw Error("Rhythm metadata alias ancestor changed");
      }
      const now = lstatSync(own.file);
      if (
        !now.isSymbolicLink() ||
        !birth(now, own.identity) ||
        now.ctimeMs !== own.identity.ctimeMs ||
        now.mtimeMs !== own.identity.mtimeMs ||
        readlinkSync(own.file) !== own.target
      )
        throw Error("Rhythm metadata explicit alias changed");
    }
  };
  const identity: RhythmMetadataIdentity = Object.freeze({
    version: "darwin-owned-generated-fd-v1",
    sha256: rhythmDigest({
      pins,
      aliases: aliases.map(([file, target]) => ({ file, target })),
      systemImage: "/usr/lib/libSystem.B.dylib",
      ABI: "int fchflags(int,uint32_t)",
      flag: 64,
    }),
  });
  assertUnchanged();
  return { identity, assertUnchanged };
}
/** Readonly dependency seam; no executable or initializer is returned. */
export function captureRhythmMetadataInstallationForTrustedTests(
  budget: RhythmReadBudget,
  layout: TrustedMetadataLayout,
) {
  return captureInstallation(budget, layout);
}
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  statReceipt = z
    .object({
      st_dev: safeInteger,
      st_ino: safeInteger,
      st_size: safeInteger,
      st_mode: safeInteger,
      st_uid: safeInteger,
      st_gid: safeInteger,
      st_nlink: safeInteger,
      st_mtime_ns: z.string().regex(/^(0|[1-9]\d{0,24})$/),
      st_ctime_ns: z.string().regex(/^(0|[1-9]\d{0,24})$/),
      st_flags: z.number().int().nonnegative().max(0xffffffff),
    })
    .strict();
const receiptSchema = z
  .object({
    ok: z.literal(true),
    before: statReceipt,
    after: statReceipt,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    semanticClaim: z.literal("owned-generated-metadata-only"),
    runtime: z
      .object({
        executable: z.string().max(1024),
        ctypes: z.string().max(1024),
        _ctypes: z.string().max(1024),
        systemImage: z.literal("/usr/lib/libSystem.B.dylib"),
        symbol: z.literal("fchflags"),
        ABI: z.literal("int(int,uint32_t)"),
        flag: z.literal(64),
      })
      .strict(),
  })
  .strict();
/** Pure exact consumed-FD receipt check reused by the actual installed caller. */
export function validateRhythmMetadataReceipt(
  input: unknown,
  before: BigIntStats,
  after: BigIntStats,
  expected: { sha256: string; python: string; ctypes: string; extension: string },
) {
  const value = receiptSchema.parse(input);
  if (
    value.sha256 !== expected.sha256 ||
    value.runtime.executable !== expected.python ||
    value.runtime.ctypes !== expected.ctypes ||
    value.runtime._ctypes !== expected.extension
  )
    throw Error("Rhythm metadata exact helper/runtime receipt changed");
  for (const [field, key] of [
    ["st_dev", "dev"],
    ["st_ino", "ino"],
    ["st_size", "size"],
    ["st_mode", "mode"],
    ["st_uid", "uid"],
    ["st_gid", "gid"],
    ["st_nlink", "nlink"],
    ["st_mtime_ns", "mtimeNs"],
    ["st_ctime_ns", "ctimeNs"],
  ] as const)
    if (String(value.before[field]) !== String(before[key]) || String(value.after[field]) !== String(after[key]))
      throw Error("Rhythm metadata consumed FD receipt identity changed");
  if (value.after.st_flags !== (value.before.st_flags | 64) >>> 0) throw Error("Rhythm metadata flag receipt changed");
}
/** Exact installation only; no discovery/fallback/tool execution. */
export function createRhythmMetadataService(budget: RhythmReadBudget): TrustedRhythmMetadataService {
  if (process.platform !== "darwin") throw Error("Rhythm fixed Darwin artifact metadata installation unavailable");
  const { identity, assertUnchanged } = captureInstallation(budget, fixedLayout);
  const initialize = async (input: RhythmMetadataInvocation) => {
    const { fd, role, bytes, sha256, bounds } = input;
    if (!Object.hasOwn(artifactRoles, role) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > artifactRoles[role])
      throw Error("Rhythm generated artifact role/extent bound");
    assertUnchanged();
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o777n) !== 0o600n ||
      before.uid !== BigInt(process.getuid!()) ||
      before.nlink !== 1n ||
      before.size !== BigInt(bytes) ||
      before.dev > BigInt(Number.MAX_SAFE_INTEGER) ||
      before.ino > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw Error("Rhythm metadata generated FD ownership");
    input.budget.charge(bytes * 2);
    const request = { dev: Number(before.dev), ino: Number(before.ino), bytes, sha256, role };
    const result = await runRhythmOwnedProcess(
      python,
      ["-I", "-S", helper],
      {
        ...bounds,
        timeoutMs: Math.min(bounds.timeoutMs, 3000),
        stdoutBytes: Math.min(bounds.stdoutBytes, 16384),
        stderrBytes: Math.min(bounds.stderrBytes, 65536),
      },
      { inheritedFd: fd, input: Buffer.from(JSON.stringify(request)), env: { PATH: "/usr/bin:/bin" } },
    );
    assertUnchanged();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    validateRhythmMetadataReceipt(value, before, fstatSync(fd, { bigint: true }), {
      sha256,
      python,
      ctypes,
      extension,
    });
  };
  assertUnchanged();
  return { identity, assertUnchanged, initialize };
}
