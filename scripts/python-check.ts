import { probeBlender } from "../src/lib/backends/probe";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { PYTHON_ROOT, PYTHON_VERSION, pythonEnvironment, pythonUv, pythonVersion } from "../src/lib/python";
import type { PythonProfile } from "../src/lib/python";

const sources = ["."];
const nativeImports = [
  "bpy",
  "bmesh",
  "mathutils",
  "mathutils.*",
  "bpy_extras",
  "bpy_extras.*",
  "addon_utils",
  "DaVinciResolveScript",
];
const profiles: Partial<
  Record<PythonProfile, { modules: string[]; files: string[]; platform?: string; command?: string[] }>
> = {
  cmake: { modules: [], files: [], command: ["cmake", "--version"] },
  "yt-dlp": { modules: [], files: [], command: ["yt-dlp", "--version"] },
  reference: { modules: ["numpy", "cv2", "scenedetect"], files: ["reference-analysis.py", "footage-shots.py"] },
  "reference-audio": { modules: ["librosa"], files: ["reference-analysis.py"] },
  transnet: { modules: ["torch", "transnetv2_pytorch", "numpy", "cv2", "scenedetect"], files: ["footage-shots.py"] },
  "audio-map": { modules: ["numpy", "librosa", "scipy", "matplotlib"], files: ["audio-map.py", "audio-structure.py"] },
  stems: { modules: ["torch", "torchaudio", "demucs", "soundfile", "numpy"], files: ["audio-stems.py"] },
  multicam: { modules: ["numpy", "cv2"], files: ["multicam.py"] },
  offset: { modules: ["audio_offset_finder"], files: [] },
  asr: { modules: ["mlx", "parakeet_mlx", "huggingface_hub"], files: ["speech-local.py"], platform: "darwin-arm64" },
  "portable-voice": { modules: ["sherpa_onnx", "numpy"], files: ["portable-voice.py"] },
  vad: { modules: ["torch", "silero_vad", "numpy"], files: ["speech-local.py"] },
  diarize: { modules: ["torch", "torchaudio", "torchcodec", "pyannote"], files: ["speech-local.py"] },
  "sfx-index": { modules: ["numpy", "scipy", "pyloudnorm"], files: ["sfx-index.py"] },
  clap: { modules: ["torch", "transformers", "numpy"], files: ["sfx-clap.py"] },
  matte: { modules: ["onnxruntime", "numpy", "PIL"], files: ["frame-matte-onnx.py"] },
  vork: { modules: ["numpy", "cv2", "scipy"], files: ["vork-track.py", "colour.py"] },
  earshot: { modules: ["earshot", "torch", "transformers", "numpy"], files: ["earshot.py"] },
};
const optionalImports = [...new Set(Object.values(profiles).flatMap((profile) => profile.modules))];
// Prepared local engines and the Vork SDK are intentionally not installed by fast checks.
optionalImports.push("sentence_transformers", "vork", "soundfile", "scipy.spatial.transform");
const allowed = (required: string[] = []) => [
  ...nativeImports,
  ...optionalImports
    .filter((name) => !required.some((root) => name === root || name.startsWith(`${root}.`)))
    .flatMap((name) => [name, `${name}.*`]),
];
const typeConfig = (required: string[] = []) =>
  `analysis.allowed-unresolved-imports=${JSON.stringify(allowed(required))}`;
// scripts/workers is a search path only where a worker imports its siblings (colour.py and colour_*.py):
// on every path it would let a worker named after the package it wraps (earshot.py) shadow that package.
const WORKER_SIBLINGS = ["--extra-search-path", "scripts/workers"];

const devEnvironment: NodeJS.ProcessEnv = {
  ...pythonEnvironment("stdlib"),
  UV_PROJECT_ENVIRONMENT: path.join(PYTHON_ROOT, ".venv"),
};
const activeChildren = new Set<ChildProcess>();
function terminate(child: ChildProcess) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else child.kill("SIGKILL");
}
function terminateChecks() {
  for (const child of activeChildren) terminate(child);
}

async function execute(label: string, args: string[], env: NodeJS.ProcessEnv = devEnvironment): Promise<void> {
  process.stderr.write(`[python] ${label}\n`);
  await new Promise<void>((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...env, UV_NO_ENV_FILE: "1" };
    // Each check starts its own test runner rather than inheriting a surrounding runner.
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(pythonUv(), args, {
      cwd: PYTHON_ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.pipe(process.stderr, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    activeChildren.add(child);
    const timer = setTimeout(() => terminate(child), 20 * 60 * 1000);
    child.once("error", (error) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new CliErrorObject({
            code: signal ? "TIMEOUT" : "VALIDATION",
            message: `${label} failed (${signal ?? code}). See stderr for diagnostics.`,
          }),
        );
    });
  });
}

runScript(async () => {
  const interrupt = () => {
    terminateChecks();
    process.exit(130);
  };
  const terminateSignal = () => {
    terminateChecks();
    process.exit(143);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminateSignal);
  process.once("exit", terminateChecks);
  try {
    const args = parseArgs([
      {
        name: "mode",
        choices: ["fast", "profiles", "native", "models", "audit"],
        default: "fast",
        description: "Fast quality gate, installed profiles, native Blender, public CPU models, or complete lock audit",
      },
      {
        name: "profile",
        description: "Dependency group in profiles mode, or vad/stems/matte in models mode; omit to check all",
      },
    ] as const);
    const completed: string[] = [];
    const skipped: { profile: string; reason: string }[] = [];
    const dev = ["run", "--project", PYTHON_ROOT, "--locked", "--python", PYTHON_VERSION];
    if (args.mode === "audit") {
      const platforms = [
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "x86_64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
      ];
      for (const platform of platforms)
        await execute(`Audit host dependency groups (${platform})`, [
          "audit",
          "--locked",
          "--no-group",
          "offset",
          "--python-platform",
          platform,
          "--preview-features",
          "audit-command",
        ]);
      const legacy = mkdtempSync(path.join(tmpdir(), "agentbros-offset-audit-"));
      try {
        for (const file of ["pyproject.toml", "uv.lock"])
          copyFileSync(path.join(PYTHON_ROOT, file), path.join(legacy, file));
        writeFileSync(path.join(legacy, ".python-version"), `${pythonVersion("offset")}\n`);
        for (const platform of platforms)
          await execute(`Audit legacy offset dependencies (${platform})`, [
            "audit",
            "--project",
            legacy,
            "--locked",
            "--only-group",
            "offset",
            "--python-platform",
            platform,
            "--preview-features",
            "audit-command",
          ]);
      } finally {
        rmSync(legacy, { recursive: true, force: true });
      }
      completed.push("lock-audit");
    } else if (args.mode === "fast") {
      await execute("Check manifest and lock", ["lock", "--check", "--offline"]);
      const results = await Promise.allSettled([
        execute("Ruff ALL", [...dev, "ruff", "check", ...sources]),
        execute("Ruff format", [...dev, "ruff", "format", "--check", ...sources]),
        execute("Host and native boundary types", [
          ...dev,
          "ty",
          "check",
          ...WORKER_SIBLINGS,
          "--config",
          typeConfig(),
        ]),
        execute("Pure contracts and regressions", [...dev, "pytest", "-q", "-m", "not slow"]),
      ]);
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length)
        throw new CliErrorObject({ code: "VALIDATION", message: `${failed.length} Python checks failed; see stderr.` });
      completed.push("lock", "ruff", "format", "types", "contracts");
    } else if (args.mode === "profiles") {
      if (args.profile && !Object.hasOwn(profiles, args.profile))
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown profile: ${args.profile}` });
      for (const [name, profile] of Object.entries(profiles)) {
        if (args.profile && name !== args.profile) continue;
        if (profile.platform && profile.platform !== `${process.platform}-${process.arch}`) {
          if (args.profile)
            throw new CliErrorObject({ code: "VALIDATION", message: `${name} requires ${profile.platform}` });
          skipped.push({ profile: name, reason: `Requires ${profile.platform}` });
          process.stderr.write(`[python] Skipped ${name}: requires ${profile.platform}\n`);
          continue;
        }
        const env = pythonEnvironment(name as PythonProfile);
        const version = pythonVersion(name as PythonProfile);
        await execute(`Install locked ${name}`, ["sync", "--locked", "--only-group", name, "--python", version], env);
        const code = profile.modules
          .map((module) => `import ${module === "pyannote" ? "pyannote.audio" : module}`)
          .join("; ");
        await execute(
          `Import ${name} native extensions`,
          ["run", "--locked", "--no-sync", "--python", version, "python", "-I", "-c", code],
          env,
        );
        if (profile.command)
          await execute(
            `Execute ${name}`,
            ["run", "--locked", "--no-sync", "--python", version, ...profile.command],
            env,
          );
        if (profile.files.length) {
          const interpreter = path.join(
            env.UV_PROJECT_ENVIRONMENT!,
            process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
          );
          await execute(`Typecheck ${name}`, [
            ...dev,
            "ty",
            "check",
            "--python",
            interpreter,
            "--config",
            typeConfig(profile.modules),
            ...(profile.files.some((file) => file.startsWith("colour")) ? WORKER_SIBLINGS : []),
            ...profile.files.map((file) => `scripts/workers/${file}`),
          ]);
        }
        completed.push(name);
      }
    } else if (args.mode === "models") {
      if (args.profile && !["vad", "stems", "matte"].includes(args.profile))
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Model acceptance profiles: vad, stems, matte" });
      await execute(
        "Public model acceptance",
        [
          ...dev,
          "pnpm",
          "exec",
          "tsx",
          "--test",
          "--test-concurrency=1",
          "--import",
          "./tests/helpers/memory-root.ts",
          "tests/python-models.test.ts",
        ],
        { ...devEnvironment, RUN_PYTHON_MODELS: "1", PYTHON_MODEL_PROFILE: args.profile ?? "" },
      );
      completed.push(...(args.profile ? [args.profile] : ["vad", "stems", "matte"]));
    } else {
      const blender = probeBlender();
      if (!blender.available)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: blender.reason ?? "Supported Blender is required for native acceptance.",
        });
      await execute(
        "Blender integration contracts",
        [
          ...dev,
          "pnpm",
          "exec",
          "tsx",
          "--test",
          "--import",
          "./tests/helpers/memory-root.ts",
          "tests/blender-live.test.ts",
          "tests/blender-run.test.ts",
          "tests/python-quality-native.test.ts",
        ],
        { ...devEnvironment, RUN_BLENDER_TESTS: "1" },
      );
      completed.push("blender");
    }
    return { metadata: { mode: args.mode, profile: args.profile ?? null, python: PYTHON_VERSION, completed, skipped } };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminateSignal);
    process.off("exit", terminateChecks);
    terminateChecks();
  }
});
