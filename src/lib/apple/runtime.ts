import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  readSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  AppleDomainSchema,
  NativeIssueSchema,
  NativeProbeSchema,
  type AppleDomain,
  type NativeIssue,
  type NativeProbe,
} from "../../types/local-capabilities";
import { CliErrorObject } from "../cli";
import { modelCacheOverride } from "../cache-dir";

export const APPLE_DOMAINS = AppleDomainSchema.options;
export const localRoot = () =>
  path.resolve(modelCacheOverride() ?? path.join(homedir(), ".cache/agentbros"), "local-engines/apple");
const sources = path.resolve(import.meta.dirname, "../../../scripts/workers/apple");
const filenames: Record<AppleDomain, string> = {
  speech: "Speech",
  text: "Text",
  translation: "Translation",
  tts: "TTS",
  audio: "Audio",
  vision: "Vision",
  foundation: "Foundation",
};
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const objectHash = (value: unknown) => digest(JSON.stringify(value));
function openBounded(file: string, maximum: number) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Bounded regular file required");
    return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function unchanged(file: string, fd: number, stat: ReturnType<typeof fstatSync>) {
  const identity = (s: ReturnType<typeof fstatSync>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  if (identity(fstatSync(fd)) !== identity(stat) || identity(lstatSync(file)) !== identity(stat))
    throw new Error("Input changed while reading");
}
export function boundedFile(file: string, maximum = 16 * 1024 * 1024): Buffer {
  const { fd, stat } = openBounded(file, maximum);
  try {
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) throw new Error("Input shrank while reading");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("Input grew while reading");
    unchanged(file, fd, stat);
    return buffer;
  } finally {
    closeSync(fd);
  }
}
export function fileHash(file: string, maximum = 512 * 1024 * 1024) {
  const { fd, stat } = openBounded(file, maximum);
  try {
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      length += count;
      if (length > maximum || length > stat.size) throw new Error("Input grew while hashing");
      hash.update(buffer.subarray(0, count));
    }
    if (length !== stat.size) throw new Error("Input shrank while hashing");
    unchanged(file, fd, stat);
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function atomicJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function sourceIdentity(domain: AppleDomain) {
  return digest(
    Buffer.concat([
      boundedFile(path.join(sources, "Support.swift"), 1024 * 1024),
      boundedFile(path.join(sources, `${filenames[domain]}.swift`), 1024 * 1024),
    ]),
  );
}
let cachedHostIdentity: string | undefined;
export const MINIMUM_MACOS: Record<AppleDomain, number> = {
  speech: 26,
  text: 14,
  translation: 26,
  tts: 14,
  audio: 14,
  vision: 14,
  foundation: 26,
};
export function macosMajor() {
  const value = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 5000 }).stdout?.trim();
  return Number.parseInt(value ?? "", 10);
}
export function hostIdentity(platform: NodeJS.Platform = process.platform) {
  if (platform !== "darwin") return `${platform}:${process.arch}`;
  if (cachedHostIdentity) return cachedHostIdentity;
  const run = (file: string, args: string[]) =>
    spawnSync(file, args, { encoding: "utf8", timeout: 5000 }).stdout?.trim() ?? "unavailable";
  cachedHostIdentity = `${platform}:${process.arch}:${process.getuid?.() ?? ""}:${run("/usr/bin/sw_vers", ["-buildVersion"])}:${run("/usr/bin/xcrun", ["--show-sdk-version"])}:${run("/usr/bin/swiftc", ["--version"])}`;
  return cachedHostIdentity;
}
const ManifestSchema = z
  .object({
    version: z.literal(1),
    domain: AppleDomainSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    executableHash: z.string().regex(/^[a-f0-9]{64}$/),
    host: z.string(),
    compiler: z.string(),
  })
  .strict();
export class NativeUnavailable extends Error {
  constructor(readonly issue: NativeIssue) {
    super(issue.message);
  }
}
export function workerFiles(domain: AppleDomain, root = localRoot()) {
  const sourceHash = sourceIdentity(domain);
  const directory = path.join(root, "workers", domain, sourceHash);
  return {
    directory,
    executable: path.join(directory, "worker"),
    manifest: path.join(directory, "manifest.json"),
    sourceHash,
  };
}
export function installedWorker(domain: AppleDomain, root = localRoot()) {
  const files = workerFiles(domain, root);
  if (!existsSync(files.manifest) || !existsSync(files.executable))
    throw new NativeUnavailable({ state: "needs_prepare", code: "WORKER_MISSING", message: `Prepare apple-${domain}` });
  const manifest = ManifestSchema.parse(JSON.parse(boundedFile(files.manifest).toString()));
  if (
    manifest.domain !== domain ||
    manifest.sourceHash !== files.sourceHash ||
    manifest.host !== hostIdentity() ||
    fileHash(files.executable) !== manifest.executableHash
  )
    throw new NativeUnavailable({
      state: "needs_prepare",
      code: "WORKER_DRIFT",
      message: "Prepared worker or host changed; prepare it again",
    });
  return { ...files, manifest, identity: objectHash(manifest) };
}
export type WorkerOperation = "probe" | "prepare" | "run";
export async function invokeNative(
  domain: AppleDomain,
  operation: WorkerOperation,
  payload: Record<string, unknown> = {},
  options: { root?: string; timeoutMs?: number; signal?: AbortSignal; allowDownload?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin")
    throw new NativeUnavailable({
      state: "unsupported",
      code: "PLATFORM_UNSUPPORTED",
      message: "This backend requires macOS",
    });
  const installed = installedWorker(domain, options.root),
    id = randomUUID();
  if (operation === "prepare" && !options.allowDownload)
    throw new NativeUnavailable({
      state: "needs_user_action",
      code: "DOWNLOAD_NOT_AUTHORISED",
      message: "Model download is not authorised by the local policy",
    });
  const request = JSON.stringify({ version: 1, id, operation, payload }) + "\n";
  if (Buffer.byteLength(request) > 16 * 1024 * 1024) throw new Error("Native request exceeds 16 MiB");
  const network = operation === "prepare" && options.allowDownload;
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        network ? "(version 1)(allow default)" : "(version 1)(allow default)(deny network*)",
        installed.executable,
      ],
      {
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8" },
      },
    );
    let output = Buffer.alloc(0),
      errors = Buffer.alloc(0),
      settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = () => finish(new Error("Native operation cancelled"));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      kill();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new NativeUnavailable({
            state: "temporarily_unavailable",
            code: "TIMEOUT",
            message: "Native operation timed out; refresh before retrying",
          }),
        ),
      options.timeoutMs ?? (operation === "probe" ? 10000 : 600000),
    );
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("error", (error) => finish(error));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (part: Buffer) => {
      if (output.length + part.length > 16 * 1024 * 1024) return finish(new Error("Native response exceeds 16 MiB"));
      output = Buffer.concat([output, part]);
    });
    child.stderr.on("data", (part: Buffer) => {
      if (errors.length + part.length > 65536) return finish(new Error("Native stderr exceeds 64 KiB"));
      errors = Buffer.concat([errors, part]);
    });
    child.on("close", (code) => {
      if (settled) return;
      try {
        finish(undefined, decodeNativeReply(output.toString(), code, id, errors.toString()));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(request);
  });
  if (installedWorker(domain, options.root).identity !== installed.identity)
    throw new Error("Native worker changed during operation");
  return result;
}
export async function probeNative(
  domain: AppleDomain,
  payload: Record<string, unknown> = {},
  root?: string,
): Promise<{ probe: NativeProbe; identity: string }> {
  const probe = NativeProbeSchema.parse(await invokeNative(domain, "probe", payload, { root }));
  return { probe, identity: objectHash({ worker: installedWorker(domain, root).identity, probe }) };
}
export async function prepareApple(
  domain: AppleDomain,
  options: { root?: string; dryRun?: boolean; language?: string; downloads?: "task" | "ask" | "never" } = {},
) {
  const files = workerFiles(domain, options.root);
  if (process.platform !== "darwin") return { domain, state: "unsupported", reason: "macOS required" };
  if (macosMajor() < MINIMUM_MACOS[domain])
    return { domain, state: "unsupported", reason: `This domain needs macOS ${MINIMUM_MACOS[domain]} or later` };
  const swift = spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { encoding: "utf8", timeout: 10000 });
  if (swift.status !== 0)
    return {
      domain,
      state: "needs_user_action",
      reason: "Swift toolchain unavailable",
      userAction: "Install Xcode command-line tools, then prepare this domain.",
    };
  const installedSdk =
    spawnSync("/usr/bin/xcrun", ["--show-sdk-version"], { encoding: "utf8", timeout: 10000 }).stdout?.trim() ?? "";
  if (Number.parseInt(installedSdk, 10) < MINIMUM_MACOS[domain] || !installedSdk)
    return {
      domain,
      state: "needs_user_action",
      reason: `The selected SDK cannot build apple-${domain}`,
      userAction: `Select Xcode command-line tools with the macOS ${MINIMUM_MACOS[domain]} SDK or later, then prepare this domain.`,
    };
  if (options.dryRun)
    return {
      domain,
      state: "needs_prepare",
      directory: files.directory,
      downloads: domain === "speech" ? "OS-managed locale model if missing; size may be unknown" : "none",
      steps: [
        "Compile pinned repository worker",
        "Probe supported task/language",
        ...(domain === "speech" ? ["Install requested model only if policy permits"] : []),
      ],
    };
  mkdirSync(files.directory, { recursive: true, mode: 0o700 });
  if (realpathSync(files.directory) !== files.directory)
    throw new Error("Native installation directory must not use aliases");
  const lock = path.join(files.directory, ".prepare.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } catch {
    throw new CliErrorObject({
      code: "TIMEOUT",
      message: "Preparation locked by another operation; retry after it finishes",
    });
  }
  try {
    try {
      installedWorker(domain, options.root);
    } catch {
      const executable = `${files.executable}.${randomUUID()}.tmp`;
      try {
        const sdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 10000 });
        const sdkVersion = spawnSync("/usr/bin/xcrun", ["--show-sdk-version"], {
          encoding: "utf8",
          timeout: 10000,
        }).stdout.trim();
        const [sdkMajor, sdkMinor] = sdkVersion.split(".").map(Number);
        const flags = sdkMajor! > 26 || (sdkMajor === 26 && sdkMinor! >= 4) ? ["-D", "APPLE_FOUNDATION_LIMITS"] : [];
        const build = spawnSync(
          swift.stdout.trim(),
          [
            "-sdk",
            sdk.stdout.trim(),
            ...flags,
            "-parse-as-library",
            "-O",
            path.join(sources, "Support.swift"),
            path.join(sources, `${filenames[domain]}.swift`),
            "-o",
            executable,
          ],
          { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
        );
        if (build.status !== 0)
          throw new Error(`Swift ${domain} preparation failed: ${(build.error?.message ?? build.stderr).slice(-3000)}`);
        const compiler = spawnSync(swift.stdout.trim(), ["--version"], {
          encoding: "utf8",
          timeout: 10000,
        }).stdout.trim();
        renameSync(executable, files.executable);
        atomicJson(files.manifest, {
          version: 1,
          domain,
          sourceHash: files.sourceHash,
          executableHash: fileHash(files.executable),
          host: hostIdentity(),
          compiler,
        });
      } finally {
        if (existsSync(executable)) unlinkSync(executable);
      }
    }
    try {
      const ready = await probeNative(
        domain,
        { ...(options.language ? { language: options.language } : {}) },
        options.root,
      );
      return { domain, state: "ready", identity: ready.identity, probe: ready.probe };
    } catch (error) {
      if (
        !(error instanceof NativeUnavailable) ||
        error.issue.state !== "needs_download" ||
        options.downloads !== "task"
      )
        throw error;
      await invokeNative(
        domain,
        "prepare",
        { language: options.language },
        { root: options.root, allowDownload: true },
      );
      const ready = await probeNative(domain, { language: options.language }, options.root);
      return { domain, state: "ready", identity: ready.identity, probe: ready.probe };
    }
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

export function decodeNativeReply(
  output: string,
  code: number | null,
  id: string,
  errors = "",
): Record<string, unknown> {
  if (Buffer.byteLength(output) > 16 * 1024 * 1024) throw new Error("Native response exceeds 16 MiB");
  const lines = output.trim().split("\n");
  if (lines.length !== 1) throw new Error("Native worker must emit one JSON line");
  const reply = z
    .discriminatedUnion("ok", [
      z
        .object({
          version: z.literal(1),
          id: z.literal(id),
          ok: z.literal(true),
          result: z.record(z.string(), z.unknown()),
        })
        .strict(),
      z.object({ version: z.literal(1), id: z.literal(id), ok: z.literal(false), issue: NativeIssueSchema }).strict(),
    ])
    .parse(JSON.parse(lines[0]!));
  if (!reply.ok) {
    if (code === 0) throw new Error("Native exit code disagrees with failure");
    throw new NativeUnavailable(reply.issue);
  }
  if (code !== 0) throw new Error(`Native worker exited ${code}: ${errors.slice(-500)}`);
  return reply.result;
}
