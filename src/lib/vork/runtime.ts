import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { arch, hostname, platform, release } from "node:os";
import { cacheRoot } from "../cache-dir";
import { CliErrorObject, assertPathWithin, emitProgress } from "../cli";

export const VORK_VERSION = "0.5.1";
export const VORK_COMMIT = "011e3f12e6c17696b3d854c173dca37a8159c6c4";
export const VORK_SOURCE = `https://github.com/voyager-so/vork/tree/${VORK_COMMIT}`;
export const VORK_ARCHIVES: Record<string, { sha256: string; bytes: number }> = {
  "darwin-arm64": { sha256: "ce9b28b13e002fc93b8017bf0d2e7e05ca1fc00f3232f0c3066814031582a625", bytes: 127576997 },
  "linux-x64": { sha256: "495cd415273a5a96ef78c148eacce666a8634e8acc30df66f9bba1dd0ef7ff20", bytes: 156393322 },
};
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const hashFile = (file: string) => digest(readFileSync(file));
export const toolDirectory = () => path.join(cacheRoot(), "vork", VORK_VERSION, `${process.platform}-${process.arch}`);
export const vorkEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG ?? "en_GB.UTF-8",
  VORK_NO_UPDATE_NOTIFIER: "1",
  VORK_CACHE_DIR: path.join(cacheRoot(), "vork", "shader-cache", VORK_VERSION),
});
export const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
export function writeNew(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  return file;
}
export function filesIn(directory: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name),
      stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      assertPathWithin(realpathSync(directory), realpathSync(file));
      continue;
    }
    if (stat.isDirectory()) result.push(...filesIn(file));
    else if (stat.isFile()) result.push(file);
  }
  return result;
}
export const executionIdentity = (backend: string) => ({
  host: digest(hostname()),
  platform: platform(),
  arch: arch(),
  osRelease: release(),
  backend,
});
export function probeVork(executable?: string) {
  const binary = executable ?? process.env.VORK_BIN ?? path.join(toolDirectory(), "vork");
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 15000,
    shell: false,
    env: vorkEnvironment(),
  });
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(result.stdout ?? "")?.[1];
  const available = result.status === 0 && version === VORK_VERSION;
  return {
    backend: "vork",
    available,
    installed: result.status === 0,
    path: binary,
    version,
    liveVerified: false,
    capabilities: available
      ? ["scene-check", "gpu-render", "slang-programs", "native-geometry-export", "control-passes"]
      : [],
    reason: available ? undefined : `Pinned Vork ${VORK_VERSION} required; use pnpm vork:setup --action install`,
  };
}
export function requireVork(executable?: string) {
  const probe = probeVork(executable);
  if (!probe.available) throw new CliErrorObject({ code: "VALIDATION", message: probe.reason!, details: probe });
  return path.resolve(probe.path);
}
export function runtimePins(executable: string) {
  const directory = path.dirname(realpathSync(executable));
  const manifest = path.join(directory, "installation.json");
  if (existsSync(manifest)) {
    const data = json(manifest) as { files: Array<{ file: string; sha256: string }> };
    for (const pin of data.files) {
      const file = path.resolve(directory, pin.file);
      assertPathWithin(directory, file);
      if (hashFile(file) !== pin.sha256)
        throw new CliErrorObject({ code: "VALIDATION", message: `Vork runtime drift: ${pin.file}` });
    }
    return [
      { file: manifest, sha256: hashFile(manifest) },
      ...data.files.map((pin) => ({ ...pin, file: path.resolve(directory, pin.file) })),
    ];
  }
  // Explicit external installations remain pinned to their executable and companion files.
  const companions = ["libraries", "slang", "lib", "sdk"].flatMap((name) =>
    existsSync(path.join(directory, name)) ? filesIn(path.join(directory, name)) : [],
  );
  return [executable, ...companions].map((file) => ({ file, sha256: hashFile(file) }));
}

export async function installVork() {
  const platform = `${process.platform}-${process.arch}`,
    pin = VORK_ARCHIVES[platform];
  if (!pin)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `No qualified installer for ${platform}; provide an exact ${VORK_VERSION} complete runtime with --executable`,
    });
  const destination = toolDirectory();
  if (existsSync(destination)) {
    const executable = requireVork(path.join(destination, "vork"));
    runtimePins(executable);
    return probeVork(executable);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const stage = `${destination}.install-${randomUUID()}`,
    archive = `${stage}.tar.gz`;
  mkdirSync(stage);
  try {
    emitProgress(`Downloading verified Vork ${VORK_VERSION} (${Math.round(pin.bytes / 1024 ** 2)} MiB)`);
    const response = await fetch(
      `https://github.com/voyager-so/vork/releases/download/v${VORK_VERSION}/vork-${VORK_VERSION}-${platform}.tar.gz`,
      { signal: AbortSignal.timeout(300000) },
    );
    if (!response.ok) throw new Error(`Archive HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) throw new Error("Archive size or SHA-256 mismatch");
    writeFileSync(archive, bytes, { flag: "wx" });
    const extract = spawnSync(
      pythonUv(),
      [
        "--offline",
        ...pythonArgs("stdlib", [
          "-c",
          'import sys,tarfile; t=tarfile.open(sys.argv[1]); t.extractall(sys.argv[2],filter="data")',
          archive,
          stage,
        ]),
      ],
      { env: pythonEnvironment("stdlib"), encoding: "utf8", timeout: 120000, shell: false },
    );
    if (extract.status !== 0) throw new Error(`Safe extraction failed: ${extract.stderr}`);
    const executable = requireVork(path.join(stage, "vork"));
    const files = filesIn(stage).map((file) => ({ file: path.relative(stage, file), sha256: hashFile(file) }));
    writeNew(path.join(stage, "installation.json"), {
      schemaVersion: 1,
      version: VORK_VERSION,
      source: VORK_SOURCE,
      archiveSha256: pin.sha256,
      files,
    });
    renameSync(stage, destination);
    return probeVork(path.join(destination, path.relative(stage, executable)));
  } finally {
    rmSync(archive, { force: true });
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function runProcess(
  executable: string,
  argv: string[],
  options: { cwd?: string; log?: string; timeoutSec?: number; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<{ stdout: string; elapsedMs: number }>((resolve, reject) => {
    const start = Date.now(),
      timeout = options.timeoutSec ?? 3600;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 7200) {
      reject(new Error("Timeout must be from 0 to 7200 seconds"));
      return;
    }
    let stdout = "",
      tail = "",
      timedOut = false,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    let escalated = false,
      closed: { code: number | null } | undefined,
      settled = false;
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      env: options.env ?? vorkEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    type Identity = { pid: number; parent: number; identity: string };
    const owned = new Map<number, string>();
    const snapshot = (): Identity[] => {
      if (process.platform === "win32") return [];
      // Identity is pid plus start time. Not comm: Linux renames a starting Node process's main thread ("MainThread"), so a
      // snapshot taken at spawn would no longer match the same process a moment later and it would escape cleanup.
      const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart="], {
        encoding: "utf8",
        timeout: 5000,
        shell: false,
      });
      if (result.status !== 0) throw new Error("Cannot enumerate owned render processes");
      return result.stdout.split("\n").flatMap((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return m ? [{ pid: Number(m[1]), parent: Number(m[2]), identity: m[3]! }] : [];
      });
    };
    const capture = () => {
      const rows = snapshot();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const leader = rows.find((row) => row.pid === child.pid);
        if (leader) owned.set(leader.pid, leader.identity);
      }
      for (let pass = 0; pass < rows.length; pass++) {
        let changed = false;
        for (const row of rows)
          if (
            !owned.has(row.pid) &&
            rows.some((parent) => parent.pid === row.parent && owned.get(parent.pid) === parent.identity)
          ) {
            owned.set(row.pid, row.identity);
            changed = true;
          }
        if (!changed) break;
      }
      return rows;
    };
    const signalOwned = (signal: NodeJS.Signals) => {
      if (process.platform === "win32") {
        if (child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5000 });
        return;
      }
      const rows = capture();
      for (const row of [...rows].reverse())
        if (owned.get(row.pid) === row.identity)
          try {
            process.kill(row.pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
    };
    const ownershipTimer = setInterval(() => {
      try {
        capture();
      } catch {
        /* Cancellation still targets captured identities. */
      }
    }, 1000);
    child.once("spawn", () => {
      try {
        capture();
      } catch {
        /* Errors are reported if cancellation needs enumeration. */
      }
    });
    const stop = () => {
      try {
        signalOwned("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      // Descendants can retain pipes after the leader exits; escalation follows their captured identities.
      killTimer = setTimeout(() => {
        try {
          signalOwned("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        escalated = true;
        if (closed) finish(closed.code);
      }, 1000);
    };
    const cancel = () => {
      if (timedOut) return;
      timedOut = true;
      stop();
    };
    const timer = setTimeout(cancel, timeout * 1000);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const lines: string[] = [];
    child.stdout.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-4 * 1024 * 1024);
      lines.push(data.toString());
    });
    child.stderr.on("data", (data) => {
      const text = data.toString();
      tail = (tail + text).slice(-8192);
      lines.push(text);
      process.stderr.write(text);
    });
    const clean = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(ownershipTimer);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      if (options.log) writeFileSync(options.log, lines.join(""));
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clean();
      if (timedOut || code !== 0)
        reject(
          new CliErrorObject({
            code: timedOut ? "TIMEOUT" : code === 2 ? "INVALID_INPUT" : code === 3 ? "VALIDATION" : "INTERNAL",
            message: `${path.basename(executable)} ${timedOut ? "cancelled or timed out" : `exited ${code}`}: ${tail.slice(-2000)}`,
            details: { exitCode: code, log: options.log },
          }),
        );
      else resolve({ stdout, elapsedMs: Date.now() - start });
    };
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clean();
        reject(error);
      }
    });
    child.once("close", (code) => {
      closed = { code };
      if (!timedOut || escalated) finish(code);
    });
  });
}
