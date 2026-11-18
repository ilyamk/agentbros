import { PYTHON_VERSION, pythonToolArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { prepareApple, NativeUnavailable } from "../apple/runtime";
import { prepareLegacyVision } from "../apple/legacy-prepare";
import { domainFromEngine, readLocalPolicy } from "../local-capabilities";
import { cacheRoot } from "../cache-dir";
import { hashFile } from "../assets/registry";
import { CliErrorObject } from "../cli";
import { LocalOcrConfigSchema, probeLocalOcr } from "../ingest/local-ocr";
import { LocalWorkerConfigSchema, probeLocalWorker } from "../ingest/local-worker";
import { NATIVE_WORD_METHOD } from "../../types/native-word-timing";
import { LocalMatteConfigSchema, probeVisionMatte } from "../matte/vision";
import { prepareEarshot } from "../audio/earshot-runtime";

const WHISPER_VERSION = "1.9.5";
const WHISPER_SOURCE_SHA256 = "ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720";
const WHISPER_SOURCE_URL = `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v${WHISPER_VERSION}`;
const WHISPER_SOURCE_BYTES = 9626464;
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const CMAKE_VERSION = "3.31.6";
export const ASR_MODELS = {
  base: { sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", bytes: 147951465 },
  small: { sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", bytes: 487601967 },
  medium: { sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208", bytes: 1533763059 },
} as const;
export type AsrModelName = keyof typeof ASR_MODELS;
export type LocalEngine =
  | "asr"
  | "ocr"
  | "matte"
  | "visual"
  | "category"
  | "earshot-bank"
  | "earshot-find"
  | `apple-${import("../../types/local-capabilities").AppleDomain}`;
export const DEFAULT_OCR_LANGUAGES = ["ru-RU", "en-US"];
const WORKERS_DIRECTORY = path.resolve(import.meta.dirname, "../../../scripts/workers");

export function defaultEngineDirectory() {
  const root = path.join(cacheRoot(), "local-engines");
  const legacy = path.join(homedir(), ".cache", "ai-video-creator", "local-engines");
  if (root === path.join(homedir(), ".cache", "agentbros", "local-engines") && !existsSync(legacy)) {
    // Prepared configs embed absolute paths; moving the cache leaves their checksum pins valid.
    for (const file of [engineFiles(root).asrConfig, engineFiles(root).ocrConfig, engineFiles(root).matteConfig]) {
      if (!existsSync(file)) continue;
      try {
        const config = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, "utf8")));
        let changed = false;
        for (const field of ["executable", "workerFile", "engineExecutable", "modelPath", "workerSource"]) {
          const value = config[field];
          if (typeof value !== "string" || !value.startsWith(`${legacy}${path.sep}`)) continue;
          const relative = path.relative(legacy, value);
          if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
          config[field] = path.join(root, relative);
          changed = true;
        }
        if (changed) writeJson(file, config);
      } catch (error) {
        console.warn(
          `[warning] Could not refresh prepared engine paths in ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return root;
}

export type EngineUnavailable = { available: false; reason: string; fix: string };

/** The exact command an agent should run to repair a missing engine. */
export function prepareCommand(engine: LocalEngine, outputDir?: string) {
  const custom = outputDir && path.resolve(outputDir) !== defaultEngineDirectory();
  return `pnpm exec tsx scripts/media-prepare.ts --engines ${engine}${custom ? ` --output-dir ${JSON.stringify(path.resolve(outputDir))}` : ""}`;
}

const ManifestSchema = z
  .object({
    version: z.literal(1),
    asr: z
      .object({
        whisperCppVersion: z.string(),
        sourceUrl: z.string(),
        sourceSha256: z.string(),
        cmakeVersion: z.string(),
        pythonVersion: z.string(),
        buildPolicy: z.string(),
        model: z.string(),
        modelUrl: z.string(),
        modelRevision: z.string(),
        modelBytes: z.number(),
        // whisper.cpp configs carry no hashes, so the runtime probe identity must match these.
        pins: z
          .object({ executableHash: z.string(), workerHash: z.string(), engineHash: z.string(), modelHash: z.string() })
          .strict(),
      })
      .strict()
      .optional(),
    ocr: z
      .object({ swiftVersion: z.string(), workerSourceHash: z.string(), executableHash: z.string() })
      .strict()
      .optional(),
    matte: z
      .object({ swiftVersion: z.string(), workerSourceHash: z.string(), executableHash: z.string() })
      .strict()
      .optional(),
  })
  .strict();
type Manifest = z.infer<typeof ManifestSchema>;

export const engineFiles = (root: string) => ({
  manifest: path.join(root, "manifest.json"),
  asrConfig: path.join(root, "asr/config.json"),
  ocrConfig: path.join(root, "ocr/config.json"),
  matteConfig: path.join(root, "matte/config.json"),
  asrCache: path.join(root, "cache/asr"),
  ocrCache: path.join(root, "cache/ocr"),
});

const unavailable = (engine: LocalEngine, reason: string, root?: string): EngineUnavailable => ({
  available: false,
  reason,
  fix: prepareCommand(engine, root),
});

function readManifest(root: string): Manifest {
  const file = engineFiles(root).manifest;
  return existsSync(file) ? ManifestSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : { version: 1 };
}

/** Reads the trusted config at its fixed location and checks it against the prepared pins. Never builds or downloads. */
export function asrStatus(root = defaultEngineDirectory()) {
  const file = engineFiles(root).asrConfig;
  if (!existsSync(file)) return unavailable("asr", `Local speech engine is not prepared: ${file} is missing`, root);
  try {
    const config = LocalWorkerConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const probe = probeLocalWorker(config);
    if (!probe.available) return unavailable("asr", probe.reason, root);
    const prepared = readManifest(root).asr;
    const pins = prepared?.pins;
    if (!pins) return unavailable("asr", "Local speech engine has no prepared manifest", root);
    if (prepared?.pythonVersion !== PYTHON_VERSION)
      return unavailable("asr", `Local speech engine needs Python ${PYTHON_VERSION}; prepare it again`, root);
    const identity: Record<string, unknown> = probe.identity;
    if (Object.entries(pins).some(([name, value]) => identity[name] !== value))
      return unavailable("asr", "Local speech engine files differ from the prepared manifest", root);
    return {
      available: true as const,
      engine: "whisper.cpp" as const,
      config,
      configFile: file,
      identityHash: probe.identityHash,
    };
  } catch (error) {
    return unavailable(
      "asr",
      `Local speech engine configuration refused: ${error instanceof Error ? error.message : String(error)}`,
      root,
    );
  }
}

export async function ocrStatus(root = defaultEngineDirectory()) {
  const file = engineFiles(root).ocrConfig;
  if (!existsSync(file))
    return unavailable("ocr", `Local screen-text engine is not prepared: ${file} is missing`, root);
  try {
    const config = LocalOcrConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const probe = await probeLocalOcr(config);
    if (!probe.available) return unavailable("ocr", probe.reason, root);
    return {
      available: true as const,
      engine: "apple-vision" as const,
      config,
      configFile: file,
      identityHash: probe.identityHash,
      runtime: probe.identity.runtime,
    };
  } catch (error) {
    return unavailable(
      "ocr",
      `Local screen-text engine configuration refused: ${error instanceof Error ? error.message : String(error)}`,
      root,
    );
  }
}

/** The Apple Vision matte worker for `pnpm matte` (src/lib/matte/vision.ts). */
export async function matteStatus(root = defaultEngineDirectory()) {
  const file = engineFiles(root).matteConfig;
  const probe = await probeVisionMatte(file);
  if (!probe.available) return unavailable("matte", `Vision matte engine: ${probe.reason}`, root);
  return {
    available: true as const,
    engine: "apple-vision-matte" as const,
    config: probe.config,
    configFile: file,
    identityHash: probe.config.executableHash,
    runtime: probe.runtime,
  };
}

function findTool(name: string) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (directory && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function run(command: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 600000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.error || result.status !== 0)
    throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr.slice(-1000)}`);
  return result.stdout.trim();
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
}

function download(url: string, file: string, sha256: string, progress: (message: string) => void) {
  if (existsSync(file) && hashFile(file) === sha256) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  progress(`Downloading ${url}`);
  run(
    "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "3",
      "--continue-at",
      "-",
      "--output",
      partial,
      url,
    ],
    { timeoutMs: 3600000 },
  );
  if (hashFile(partial) !== sha256) {
    rmSync(partial);
    throw new Error(`Checksum mismatch for ${url}`);
  }
  renameSync(partial, file);
}

type PrepareRequest = {
  engines: LocalEngine[];
  outputDir?: string;
  model?: AsrModelName;
  language?: string;
  threads?: number;
  ocrLanguages?: string[];
  dryRun?: boolean;
  allowDownload?: boolean;
  onProgress?: (message: string) => void;
};

function asrPlan(root: string, model: AsrModelName) {
  const modelFile = path.join(root, "asr/models", `ggml-${model}.bin`);
  const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-${model}.bin`;
  const pin = ASR_MODELS[model];
  return {
    modelUrl,
    modelFile,
    downloads: [
      {
        url: modelUrl,
        sha256: pin.sha256,
        bytes: pin.bytes,
        to: modelFile,
        present: existsSync(modelFile) && statSync(modelFile).size === pin.bytes,
      },
      {
        url: WHISPER_SOURCE_URL,
        sha256: WHISPER_SOURCE_SHA256,
        bytes: WHISPER_SOURCE_BYTES,
        to: path.join(root, "build/whisper.cpp.tar.gz"),
        present: existsSync(path.join(root, "asr/bin/whisper-cli")),
      },
    ],
    toolsMissing: ["uv", "curl", "tar", "make", "c++", "ffmpeg", "ffprobe"].filter((tool) => !findTool(tool)),
    steps: [
      `uv python install ${PYTHON_VERSION} into ${path.join(root, "python")}`,
      `uv run --locked --group cmake cmake: static CPU build of whisper-cli ${WHISPER_VERSION}`,
      "Copy scripts/workers/local-analysis.py",
      `Write ${engineFiles(root).asrConfig}`,
    ],
  };
}

function toolchainFix(missing: string[]) {
  return [
    missing.includes("uv") ? "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh" : "",
    missing.some((tool) => ["make", "c++", "tar", "curl"].includes(tool))
      ? "Install Command Line Tools: xcode-select --install"
      : "",
    missing.some((tool) => ["ffmpeg", "ffprobe"].includes(tool)) ? "Install FFmpeg: brew install ffmpeg" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function swiftToolchain(): { swiftc: string; version: string } | EngineUnavailable {
  const fix = "Install Command Line Tools: xcode-select --install";
  if (process.platform !== "darwin")
    return {
      available: false,
      reason: "Apple Vision OCR requires macOS",
      fix: "Run on macOS; there is no cloud fallback",
    };
  const swiftc = findTool("swiftc");
  if (!swiftc) return { available: false, reason: "swiftc is not on PATH", fix };
  const probe = spawnSync(swiftc, ["--version"], { encoding: "utf8", timeout: 60000 });
  if (probe.status !== 0)
    return {
      available: false,
      reason: `swiftc cannot run: ${(probe.stderr || probe.error?.message || "").slice(-500)}`,
      fix,
    };
  return { swiftc, version: (probe.stdout || probe.stderr).split("\n")[0]! };
}

function buildWhisper(root: string, progress: (message: string) => void) {
  const target = path.join(root, "asr/bin/whisper-cli");
  const build = path.join(root, "build");
  const archive = path.join(build, "whisper.cpp.tar.gz");
  download(WHISPER_SOURCE_URL, archive, WHISPER_SOURCE_SHA256, progress);
  const source = mkdtempSync(path.join(build, "source-"));
  run("tar", ["-xzf", archive, "-C", source, "--strip-components=1"]);
  const output = path.join(build, "output");
  const cmake = pythonToolArgs("cmake", "cmake", []);
  progress(`Building whisper-cli ${WHISPER_VERSION}`);
  // Static so engineHash pins everything that runs; -ng in the worker makes Metal useless here.
  run(
    pythonUv(),
    [
      ...cmake,
      "-S",
      source,
      "-B",
      output,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=OFF",
      "-DGGML_METAL=OFF",
      "-DGGML_OPENMP=OFF",
      "-DWHISPER_CURL=OFF",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_BUILD_SERVER=OFF",
      "-DWHISPER_SDL2=OFF",
    ],
    { env: pythonEnvironment("cmake") },
  );
  run(
    pythonUv(),
    [...cmake, "--build", output, "--target", "whisper-cli", "--parallel", String(Math.max(2, cpus().length - 2))],
    { timeoutMs: 1800000, env: pythonEnvironment("cmake") },
  );
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(output, "bin/whisper-cli"), `${target}.tmp`);
  chmodSync(`${target}.tmp`, 0o700);
  renameSync(`${target}.tmp`, target);
  rmSync(build, { recursive: true, force: true });
}

function preparePython(root: string, progress: (message: string) => void) {
  const env = { UV_PYTHON_INSTALL_DIR: path.join(root, "python") };
  progress(`Installing managed Python ${PYTHON_VERSION}`);
  run(pythonUv(), ["python", "install", PYTHON_VERSION], { env });
  // The worker contract rejects a symlinked interpreter, and only the versioned binary is a regular file.
  const found = realpathSync(run(pythonUv(), ["python", "find", "--managed-python", PYTHON_VERSION], { env }));
  if (!found.startsWith(root + path.sep) || !lstatSync(found).isFile())
    throw new Error(`Managed Python resolved outside ${root}: ${found}`);
  return found;
}

function prepareAsr(root: string, request: PrepareRequest, progress: (message: string) => void) {
  const model = request.model ?? "small";
  const plan = asrPlan(root, model);
  if (plan.toolsMissing.length)
    return {
      available: false as const,
      reason: `Missing tools: ${plan.toolsMissing.join(", ")}`,
      fix: toolchainFix(plan.toolsMissing),
    };
  const engineExecutable = path.join(root, "asr/bin/whisper-cli");
  const previous = readManifest(root).asr;
  if (
    !existsSync(engineExecutable) ||
    previous?.whisperCppVersion !== WHISPER_VERSION ||
    hashFile(engineExecutable) !== previous.pins.engineHash
  )
    buildWhisper(root, progress);
  const executable = preparePython(root, progress);
  download(plan.modelUrl, plan.modelFile, ASR_MODELS[model].sha256, progress);
  const workerFile = path.join(root, "asr/workers/local-analysis.py");
  mkdirSync(path.dirname(workerFile), { recursive: true });
  copyFileSync(path.join(WORKERS_DIRECTORY, "local-analysis.py"), workerFile);
  const config = LocalWorkerConfigSchema.parse({
    executable,
    workerFile,
    engine: "whisper.cpp",
    engineExecutable,
    modelPath: plan.modelFile,
    model: `whisper-multilingual-${model}`,
    revision: MODEL_REVISION,
    language: request.language ?? "auto",
    timeoutMs: 600000,
    threads: request.threads ?? Math.min(8, Math.max(2, cpus().length - 2)),
    wordTimingMethod: NATIVE_WORD_METHOD,
  });
  const probe = probeLocalWorker(config);
  if (!probe.available) return { available: false as const, reason: probe.reason, fix: prepareCommand("asr", root) };
  const identity: Record<string, unknown> = probe.identity;
  writeJson(engineFiles(root).asrConfig, config);
  writeJson(engineFiles(root).manifest, {
    ...readManifest(root),
    asr: {
      whisperCppVersion: WHISPER_VERSION,
      sourceUrl: WHISPER_SOURCE_URL,
      sourceSha256: WHISPER_SOURCE_SHA256,
      cmakeVersion: CMAKE_VERSION,
      pythonVersion: PYTHON_VERSION,
      buildPolicy: "static;CPU/Accelerate;GGML_METAL=OFF;GGML_OPENMP=OFF;WHISPER_CURL=OFF",
      model,
      modelUrl: plan.modelUrl,
      modelRevision: MODEL_REVISION,
      modelBytes: ASR_MODELS[model].bytes,
      pins: {
        executableHash: identity.executableHash,
        workerHash: identity.workerHash,
        engineHash: identity.engineHash,
        modelHash: identity.modelHash,
      },
    },
  });
  return {
    available: true as const,
    engine: "whisper.cpp" as const,
    configFile: engineFiles(root).asrConfig,
    model: config.model,
    threads: config.threads,
    identityHash: probe.identityHash,
  };
}

async function prepareOcr(root: string, request: PrepareRequest, progress: (message: string) => void) {
  const toolchain = swiftToolchain();
  if ("available" in toolchain) return toolchain;
  const source = path.join(root, "ocr/workers/frame-ocr.swift");
  const executable = path.join(root, "ocr/bin/frame-ocr");
  mkdirSync(path.dirname(source), { recursive: true });
  mkdirSync(path.dirname(executable), { recursive: true });
  const repositorySource = path.join(WORKERS_DIRECTORY, "frame-ocr.swift");
  const sourceHash = hashFile(repositorySource);
  copyFileSync(repositorySource, source);
  const previous = readManifest(root).ocr;
  if (
    !existsSync(executable) ||
    previous?.workerSourceHash !== sourceHash ||
    hashFile(executable) !== previous.executableHash
  ) {
    progress("Compiling the Apple Vision OCR worker");
    run(toolchain.swiftc, ["-O", source, "-o", `${executable}.tmp`]);
    renameSync(`${executable}.tmp`, executable);
  }
  const config = LocalOcrConfigSchema.parse({
    engine: "apple-vision",
    executable,
    executableHash: hashFile(executable),
    workerSource: source,
    workerSourceHash: sourceHash,
    revision: 3,
    languages: request.ocrLanguages ?? DEFAULT_OCR_LANGUAGES,
    maxFrames: 32,
    timeoutMs: 120000,
  });
  const probe = await probeLocalOcr(config);
  if (!probe.available) return { available: false as const, reason: probe.reason, fix: prepareCommand("ocr", root) };
  writeJson(engineFiles(root).ocrConfig, config);
  writeJson(engineFiles(root).manifest, {
    ...readManifest(root),
    ocr: { swiftVersion: toolchain.version, workerSourceHash: sourceHash, executableHash: config.executableHash },
  });
  return {
    available: true as const,
    engine: "apple-vision" as const,
    configFile: engineFiles(root).ocrConfig,
    languages: config.languages,
    osVersion: probe.identity.runtime.osVersion,
    identityHash: probe.identityHash,
  };
}

async function prepareMatte(root: string, progress: (message: string) => void) {
  const toolchain = swiftToolchain();
  if ("available" in toolchain) return toolchain;
  const source = path.join(root, "matte/workers/frame-matte.swift");
  const executable = path.join(root, "matte/bin/frame-matte");
  mkdirSync(path.dirname(source), { recursive: true });
  mkdirSync(path.dirname(executable), { recursive: true });
  const repositorySource = path.join(WORKERS_DIRECTORY, "frame-matte.swift");
  const sourceHash = hashFile(repositorySource);
  copyFileSync(repositorySource, source);
  const previous = readManifest(root).matte;
  if (
    !existsSync(executable) ||
    previous?.workerSourceHash !== sourceHash ||
    hashFile(executable) !== previous.executableHash
  ) {
    progress("Compiling the Apple Vision matte worker");
    run(toolchain.swiftc, ["-O", source, "-o", `${executable}.tmp`]);
    renameSync(`${executable}.tmp`, executable);
  }
  const config = LocalMatteConfigSchema.parse({
    engine: "apple-vision-matte",
    executable,
    executableHash: hashFile(executable),
    workerSource: source,
    workerSourceHash: sourceHash,
    timeoutMs: 600000,
  });
  writeJson(engineFiles(root).matteConfig, config);
  const status = await matteStatus(root);
  if (!status.available) return status;
  writeJson(engineFiles(root).manifest, {
    ...readManifest(root),
    matte: { swiftVersion: toolchain.version, workerSourceHash: sourceHash, executableHash: config.executableHash },
  });
  return {
    available: true as const,
    engine: "apple-vision-matte" as const,
    configFile: engineFiles(root).matteConfig,
    osVersion: status.runtime.osVersion,
    subject: status.runtime.subject,
    person: status.runtime.person,
    identityHash: status.identityHash,
  };
}

function statusSummary(
  status:
    ReturnType<typeof asrStatus> | Awaited<ReturnType<typeof ocrStatus>> | Awaited<ReturnType<typeof matteStatus>>,
) {
  return status.available
    ? { available: true, engine: status.engine, configFile: status.configFile, identityHash: status.identityHash }
    : status;
}

async function attempt<T>(engine: LocalEngine, root: string, action: () => T | Promise<T>) {
  try {
    return await action();
  } catch (error) {
    return {
      ...unavailable(engine, error instanceof Error ? error.message : String(error), root),
      ...(error instanceof NativeUnavailable ? error.issue : {}),
    };
  }
}

/** Explicit operator action, CLI only. Dry-run reports state and the plan with no write, build or network use. */
export async function prepareLocalEngines(request: PrepareRequest) {
  const directory = path.resolve(request.outputDir ?? defaultEngineDirectory());
  const repository = path.resolve(import.meta.dirname, "../../..");
  const engines: Partial<Record<LocalEngine, unknown>> = {};
  if (request.dryRun) {
    for (const engine of request.engines)
      if (engine === "earshot-bank" || engine === "earshot-find")
        engines[engine] = prepareEarshot({ root: directory, semantic: engine === "earshot-find", dryRun: true });
    if (request.engines.includes("asr")) {
      const { downloads, toolsMissing, steps } = asrPlan(directory, request.model ?? "small");
      engines.asr = {
        ...statusSummary(asrStatus(directory)),
        plan: {
          downloads,
          toolsMissing,
          steps,
          ...(toolsMissing.length ? { toolchainFix: toolchainFix(toolsMissing) } : {}),
        },
      };
    }
    if (request.engines.includes("ocr")) {
      const toolchain = swiftToolchain();
      engines.ocr =
        "available" in toolchain
          ? toolchain
          : {
              ...statusSummary(await ocrStatus(directory)),
              plan: {
                downloads: [],
                toolsMissing: [],
                steps: [
                  `swiftc -O scripts/workers/frame-ocr.swift -o ${path.join(directory, "ocr/bin/frame-ocr")}`,
                  `Write ${engineFiles(directory).ocrConfig}`,
                ],
              },
            };
    }
    if (request.engines.includes("matte")) {
      const toolchain = swiftToolchain();
      engines.matte =
        "available" in toolchain
          ? toolchain
          : {
              ...statusSummary(await matteStatus(directory)),
              plan: {
                downloads: [],
                toolsMissing: [],
                steps: [
                  `swiftc -O scripts/workers/frame-matte.swift -o ${path.join(directory, "matte/bin/frame-matte")}`,
                  `Write ${engineFiles(directory).matteConfig}`,
                ],
              },
            };
    }
    for (const engine of request.engines) {
      const domain = domainFromEngine(engine);
      if (domain)
        engines[engine] = await prepareApple(domain, {
          root: path.join(directory, "apple"),
          dryRun: true,
          language: request.language,
        });
      if (engine === "visual" || engine === "category")
        engines[engine] = await prepareLegacyVision(engine, directory, true);
    }
    return { dryRun: true, outputDir: directory, engines };
  }
  const insideRepository = (candidate: string) =>
    candidate === repository ||
    candidate.startsWith(repository + path.sep) ||
    repository.startsWith(candidate + path.sep);
  if (insideRepository(directory))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Local engines must live outside the repository" });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Resolve aliases first: the OCR runtime check refuses any symlinked ancestor.
  const root = realpathSync(directory);
  if (insideRepository(root))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Local engines must live outside the repository" });
  const progress = request.onProgress ?? (() => {});
  for (const engine of request.engines)
    if (engine === "earshot-bank" || engine === "earshot-find")
      engines[engine] = await attempt(engine, root, () =>
        prepareEarshot({ root, semantic: engine === "earshot-find", allowDownload: request.allowDownload }),
      );
  if (request.engines.includes("asr")) {
    const policy = readLocalPolicy(path.join(root, "apple"));
    if (policy.downloads !== "task" && !request.allowDownload) {
      const status = asrStatus(root);
      engines.asr = status.available
        ? statusSummary(status)
        : {
            ...status,
            state: "needs_user_action",
            userAction: "Authorise this preparation with --allow-download, or use an installed backend.",
          };
    } else engines.asr = await attempt("asr", root, () => prepareAsr(root, request, progress));
  }
  if (request.engines.includes("ocr"))
    engines.ocr = await attempt("ocr", root, () => prepareOcr(root, request, progress));
  if (request.engines.includes("matte"))
    engines.matte = await attempt("matte", root, () => prepareMatte(root, progress));
  for (const engine of request.engines) {
    const domain = domainFromEngine(engine);
    if (domain)
      engines[engine] = await attempt(engine, root, () =>
        prepareApple(domain, {
          root: path.join(root, "apple"),
          language: request.language === "auto" ? undefined : request.language,
          downloads: request.allowDownload ? "task" : readLocalPolicy(path.join(root, "apple")).downloads,
        }),
      );
    if (engine === "visual" || engine === "category")
      engines[engine] = await attempt(engine, root, () => prepareLegacyVision(engine, root));
  }
  return { dryRun: false, outputDir: root, engines };
}
