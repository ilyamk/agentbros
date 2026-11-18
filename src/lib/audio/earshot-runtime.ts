import { PYTHON_ROOT, PYTHON_VERSION, pythonRequirementsHash, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { cacheRoot } from "../cache-dir";
import { hashFile } from "../assets/registry";
import { CliErrorObject } from "../cli";
import { jsonHash } from "../elevenlabs/files";

export const EARSHOT_SHA = "4ac3d2ac2b151e1c23376f9ce7f3047a17050013";
export const EARSHOT_CLAP_SHA = "16c8cc3159a3c8a31e8ff5ef1f66b0d9ab3667db";
export const EARSHOT_MODEL = "laion/larger_clap_general";
const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/earshot.py");
const modelFiles = [
  "config.json",
  "preprocessor_config.json",
  "merges.txt",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json",
  "model.safetensors",
];
const ManifestSchema = z
  .object({
    version: z.literal(1),
    packageSha: z.literal(EARSHOT_SHA),
    executable: z.string(),
    executableHash: z.string(),
    worker: z.string(),
    workerHash: z.string(),
    requirementsHash: z.string(),
    versions: z.record(z.string(), z.string()),
    bankVersion: z.string(),
    model: z.object({ revision: z.literal(EARSHOT_CLAP_SHA), hashes: z.record(z.string(), z.string()) }).optional(),
  })
  .strict();
export type EarshotManifest = z.infer<typeof ManifestSchema>;
const rootFor = (root?: string) => path.join(root ?? path.join(cacheRoot(), "local-engines"), "earshot");
const snapshotFor = (root: string) =>
  path.join(root, "cache/hf/models--laion--larger_clap_general/snapshots", EARSHOT_CLAP_SHA);
export function earshotEnvironment(root: string, network = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  return {
    ...env,
    EARSHOT_HOME: path.join(root, "cache"),
    EARSHOT_THREADS: "4",
    EARSHOT_PRECISION: "fp32",
    EARSHOT_CLAP: EARSHOT_MODEL,
    EARSHOT_CLAP_REVISION: EARSHOT_CLAP_SHA,
    ...(network ? {} : { EARSHOT_OFFLINE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }),
    TOKENIZERS_PARALLELISM: "false",
  };
}
export function earshotStatus(root?: string, semantic = false) {
  const directory = rootFor(root),
    configFile = path.join(directory, "manifest.json");
  const fix = `pnpm media:prepare --engines ${semantic ? "earshot-find" : "earshot-bank"} --allow-download`;
  try {
    if (!existsSync(configFile) || !lstatSync(configFile).isFile() || lstatSync(configFile).isSymbolicLink())
      throw Error("Earshot is not prepared");
    const manifest = ManifestSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
    if (
      manifest.worker !== path.join(directory, "worker.py") ||
      manifest.workerHash !== hashFile(WORKER) ||
      manifest.workerHash !== hashFile(manifest.worker) ||
      manifest.requirementsHash !== pythonRequirementsHash() ||
      manifest.executableHash !== hashFile(manifest.executable)
    )
      throw Error("Prepared Earshot runtime differs from its pins");
    if (semantic) {
      if (
        !manifest.model ||
        modelFiles.some(
          (file) =>
            !manifest.model!.hashes[file] ||
            hashFile(path.join(snapshotFor(directory), file)) !== manifest.model!.hashes[file],
        )
      )
        throw Error("Pinned CLAP safetensors are not prepared or changed");
    }
    return {
      available: true as const,
      engine: "earshot" as const,
      directory,
      configFile,
      manifest,
      identityHash: jsonHash({
        packageSha: manifest.packageSha,
        workerHash: manifest.workerHash,
        requirementsHash: manifest.requirementsHash,
        versions: manifest.versions,
        model: semantic ? manifest.model : null,
      }),
      fix,
    };
  } catch (error) {
    return {
      available: false as const,
      engine: "earshot" as const,
      reason: error instanceof Error ? error.message : String(error),
      fix,
      directory,
      configFile,
    };
  }
}

function command(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string } = {},
) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env:
      options.env ??
      Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG", "SYSTEMROOT"].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]]] : [],
        ),
      ),
    cwd: options.cwd,
    timeout: options.timeout ?? 600_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: result.error && "code" in result.error && result.error.code === "ENOENT" ? "VALIDATION" : "INTERNAL",
      message: `Earshot process failed: ${(result.error?.message ?? result.stderr).slice(-1200)}`,
    });
  return result.stdout;
}

export function runEarshotWorker(request: Record<string, unknown>, root?: string) {
  const status = earshotStatus(root, request.action === "find");
  if (!status.available)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${status.reason}. ${status.fix}`,
      details: { available: false, fix: status.fix },
    });
  return runPrepared(status.manifest, request, status.directory);
}
function runPrepared(
  manifest: Pick<EarshotManifest, "executable" | "worker">,
  request: Record<string, unknown>,
  directory: string,
  network = false,
) {
  const temporary = mkdtempSync(path.join(tmpdir(), "earshot-request-"));
  try {
    const file = path.join(temporary, "request.json");
    writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
    const result = spawnSync(manifest.executable, ["-I", manifest.worker, file], {
      encoding: "utf8",
      env: earshotEnvironment(directory, network),
      timeout: 600_000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    const lines = result.stdout.trim().split("\n");
    if (result.error || lines.length !== 1 || !lines[0])
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `Earshot worker contract failed: ${(result.error?.message ?? result.stderr).slice(-800)}`,
      });
    const payload = z
      .object({ ok: z.boolean(), result: z.record(z.string(), z.any()).optional(), error: z.string().optional() })
      .strict()
      .parse(JSON.parse(lines[0]));
    if (!payload.ok || result.status !== 0 || !payload.result)
      throw new CliErrorObject({ code: "VALIDATION", message: payload.error ?? "Earshot worker failed" });
    return payload.result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Downloads/installations belong to explicit preparation, never runtime inference or MCP. */
export function prepareEarshot(options: {
  root?: string;
  semantic?: boolean;
  dryRun?: boolean;
  allowDownload?: boolean;
}) {
  const directory = rootFor(options.root),
    status = earshotStatus(options.root, options.semantic);
  const plan = {
    packageSha: EARSHOT_SHA,
    python: PYTHON_VERSION,
    requirementsHash: pythonRequirementsHash(),
    semantic: options.semantic ?? false,
    model: options.semantic ? { id: EARSHOT_MODEL, revision: EARSHOT_CLAP_SHA, weights: "safetensors" } : null,
    downloads: options.semantic
      ? ["Pinned runtime packages", "Pinned CLAP snapshot (~0.7 GB); no AST"]
      : ["Pinned runtime packages; no model weights"],
  };
  if (options.dryRun) return { ...status, dryRun: true, plan };
  if (!options.allowDownload)
    return status.available
      ? status
      : {
          ...status,
          state: "needs_user_action",
          userAction: "Authorise explicit preparation with --allow-download",
          plan,
        };
  if (status.available) return status;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runtime = path.join(directory, "runtime"),
    python = path.join(runtime, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  command(
    pythonUv(),
    [
      "sync",
      "--project",
      PYTHON_ROOT,
      "--locked",
      "--no-default-groups",
      "--group",
      "earshot",
      "--python",
      PYTHON_VERSION,
    ],
    { env: { ...earshotEnvironment(directory, true), UV_PROJECT_ENVIRONMENT: runtime }, timeout: 1_800_000 },
  );
  const worker = path.join(directory, "worker.py");
  copyFileSync(WORKER, worker);
  const executable = realpathSync(python);
  const prepared = runPrepared(
    { executable: python, worker },
    { action: "prepare", semantic: options.semantic ?? false },
    directory,
    true,
  );
  const rows = z
    .array(z.object({ name: z.string(), version: z.string() }).passthrough())
    .parse(JSON.parse(command(pythonUv(), ["pip", "list", "--python", python, "--format", "json"])));
  // Run the venv launcher, whose pyvenv.cfg resolves its pinned site-packages; pin its real interpreter separately.
  const manifest: EarshotManifest = {
    version: 1,
    packageSha: EARSHOT_SHA,
    executable: python,
    executableHash: hashFile(executable),
    worker,
    workerHash: hashFile(WORKER),
    requirementsHash: pythonRequirementsHash(),
    versions: Object.fromEntries(rows.map((row) => [row.name, row.version])),
    bankVersion: z.string().parse(prepared.bankVersion),
    ...(options.semantic
      ? {
          model: {
            revision: EARSHOT_CLAP_SHA,
            hashes: Object.fromEntries(
              modelFiles.map((file) => [file, hashFile(path.join(snapshotFor(directory), file))]),
            ),
          },
        }
      : {}),
  };
  if (!options.semantic && existsSync(status.configFile)) {
    try {
      const prior = ManifestSchema.parse(JSON.parse(readFileSync(status.configFile, "utf8")));
      if (prior.model) manifest.model = prior.model;
    } catch {
      /* A damaged semantic manifest is not reused. */
    }
  }
  writeManifest(status.configFile, manifest);
  const result = earshotStatus(options.root, options.semantic);
  if (!result.available) throw Error(result.reason);
  return result;
}
function writeManifest(file: string, manifest: EarshotManifest) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
