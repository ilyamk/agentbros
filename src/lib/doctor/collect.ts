/**
 * The environment checks behind `pnpm preflight` and `pnpm bootstrap`. Probes
 * only: nothing here installs, downloads or prints a key's value.
 */
import { runtimePolicy, runtimeStatus } from "../runtime";
import { PYTHON_VERSION, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ensureBrowser } from "@remotion/renderer";
import { probeBlender, probeYtDlp } from "../backends/probe";
import { listSessions } from "../backends/blender-live";
import { FAMILIES, assetStatus, loadAssets } from "../shared-assets";
import { engineFacts } from "../matte";
import { selectEngine } from "../matte/engine";
import { missingSfx, readKindManifest } from "../audio/sfx-fetch";
import { SFX_KINDS, SHARED_SFX_DIR } from "../audio/sfx-index";
import { harnessHealth } from "../harness/health";
import {
  higgsfieldKeyCheck,
  API_KEYS,
  detectOs,
  hintFor,
  parseVersion,
  type DoctorCheck,
  type HostOs,
  type Tool,
} from "./index";

const os = detectOs(process.platform, existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "");

function run(executable: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 20000, shell: false });
  return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function check(id: Tool, label: string, required: boolean, passed: boolean | "warn", detail: string): DoctorCheck {
  const status = passed === true ? "ok" : passed === "warn" || !required ? "warn" : "fail";
  return { id, label, status, detail, required, ...(status === "ok" ? {} : { hint: hintFor(id, os) }) };
}

function versionOf(executable: string, args: string[]): string | undefined {
  const result = run(executable, args);
  if (!result.ok) return undefined;
  const parsed = parseVersion(result.output);
  return parsed ? parsed.join(".") : result.output.split("\n")[0];
}

function installedPackages(): { passed: boolean; detail: string } {
  if (!existsSync("package.json")) return { passed: false, detail: "run from the repository root" };
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string> };
  const pinned = Object.entries(manifest.dependencies ?? {}).filter(
    ([name]) => name === "remotion" || name.startsWith("@remotion/"),
  );
  const stale: string[] = [];
  for (const [name, version] of pinned) {
    const file = path.join("node_modules", name, "package.json");
    const installed = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version
      : "missing";
    if (installed !== version) stale.push(`${name} ${installed} (wants ${version})`);
  }
  return stale.length
    ? { passed: false, detail: `out of date: ${stale.join(", ")}` }
    : { passed: true, detail: `${pinned.length} Remotion packages at ${manifest.dependencies?.["remotion"] ?? "?"}` };
}

async function chromium(): Promise<{ passed: boolean | "warn"; detail: string }> {
  try {
    const status = await ensureBrowser({
      logLevel: "error",
      onBrowserDownload: () => {
        throw new Error("download refused");
      },
    });
    return { passed: true, detail: "path" in status ? status.path : status.type };
  } catch {
    return {
      passed: "warn",
      detail: "no local Chrome Headless Shell yet; Remotion downloads it on first render (needs network)",
    };
  }
}

export interface DoctorFacts {
  os: HostOs;
  checks: DoctorCheck[];
  keys: { name: string; unlocks: string; set: boolean }[];
}

export async function collectDoctorChecks(env: NodeJS.ProcessEnv = process.env): Promise<DoctorFacts> {
  const checks: DoctorCheck[] = [];

  const node = process.versions.node;
  const runtime = runtimeStatus(node);
  checks.push(
    check(
      "node",
      "Node.js",
      true,
      runtime.role === "primary" ? true : runtime.role === "fallback" || runtime.role === "compatible" ? "warn" : false,
      `${node} at ${runtime.executable}; ${runtime.role}; primary ${runtime.primary}, fallback ${runtime.fallback}`,
    ),
  );

  const agent = process.env["npm_config_user_agent"]?.match(/pnpm\/(\S+)/)?.[1];
  const pnpm = agent ?? (process.platform === "win32" ? undefined : versionOf("pnpm", ["--version"]));
  checks.push(
    check(
      "pnpm",
      "pnpm",
      true,
      pnpm === runtimePolicy().packageManager.slice(5),
      `${pnpm ?? "not found"}; expected ${runtimePolicy().packageManager}`,
    ),
  );
  if (!pnpm) {
    const corepack = process.platform === "win32" ? undefined : versionOf("corepack", ["--version"]);
    checks.push(check("corepack", "corepack", false, !!corepack, corepack ?? "not found"));
  }

  const packages = installedPackages();
  checks.push(check("install", "node_modules", true, packages.passed, packages.detail));

  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const version = versionOf(tool, ["-version"]);
    checks.push(check(tool, tool, true, !!version, version ?? "not on PATH"));
  }

  const browser = await chromium();
  checks.push(check("chromium", "Chromium for Remotion", true, browser.passed, browser.detail));

  const uv = versionOf(pythonUv(), ["--version"]);
  const python = uv ? run(pythonUv(), ["python", "find", "--no-python-downloads", PYTHON_VERSION]) : undefined;
  checks.push(
    check(
      "uv",
      "uv / pinned Python workers",
      false,
      !!uv && !!python?.ok,
      `${uv ?? "uv not on PATH"}; Python ${PYTHON_VERSION}: ${python?.ok ? python.output : "not installed; run uv python install"}`,
    ),
  );

  const blender = probeBlender();
  checks.push(
    check(
      "blender",
      "Blender 4.2+/5.x",
      false,
      blender.available,
      blender.available ? `${blender.version ?? "?"} at ${blender.path ?? "?"}` : (blender.reason ?? "not found"),
    ),
  );
  if (blender.available) {
    // Sessions hold a Blender process each; a running one is fine, a forgotten one is worth a warning.
    const sessions = listSessions(process.cwd()),
      running = sessions.filter((item) => item.running);
    const names = running.map((item) => `${item.key}/${item.session} (pid ${item.pid})`).join(", ");
    checks.push(
      check(
        "blender-live",
        "Blender live session (127.0.0.1, token)",
        false,
        running.length ? "warn" : true,
        running.length
          ? `${running.length} running: ${names}`
          : `ready; no session running${sessions.length ? `, ${sessions.length} stale record(s)` : ""}`,
      ),
    );
  }

  const ytDlp = probeYtDlp();
  checks.push(
    check(
      "yt-dlp",
      "yt-dlp (reference downloads)",
      false,
      ytDlp.available,
      ytDlp.available
        ? `${ytDlp.version ?? "via locked uv profile on first use"} (${ytDlp.routes.join(", ")})`
        : (ytDlp.reason ?? "not found"),
    ),
  );

  if (os === "macos") {
    const swift = versionOf("swiftc", ["--version"]);
    checks.push(check("swiftc", "swiftc (macOS Vision workers)", false, !!swift, swift ?? "not found"));
  }

  // Free local cut-outs (pnpm matte): which engines can run, and which one auto picks.
  const matte = await engineFacts();
  const auto = selectEngine("auto", "subject", matte);
  const engineLine = (name: string, state: { available: boolean; reason?: string }) =>
    `${name} ${state.available ? "ready" : `not ready (${state.reason ?? "unavailable"})`}`;
  checks.push(
    check(
      "matte",
      "Cut-out engines (pnpm matte)",
      false,
      auto.ok,
      [
        os === "macos" ? engineLine("vision", matte.vision) : "vision macOS only",
        engineLine("onnx", matte.onnx),
        auto.ok ? `auto: ${auto.engine}` : "auto: none",
      ].join("; "),
    ),
  );

  // Model weights are reported by the matte line above, not as missing shared media.
  const assets = loadAssets(
    process.cwd(),
    FAMILIES.filter((family) => family !== "models"),
  ).map((entry) => assetStatus(entry));
  const byFamily: { family: string; present: number; total: number }[] = FAMILIES.map((family) => {
    const own = assets.filter((asset) => asset.family === family);
    return {
      family,
      present: own.filter((asset) => asset.state !== "missing" && asset.state !== "corrupt").length,
      total: own.length,
    };
  }).filter((item) => item.total);
  const sfxTotal = SFX_KINDS.reduce(
    (sum, kind) => sum + (readKindManifest(SHARED_SFX_DIR, kind)?.entries.length ?? 0),
    0,
  );
  const sfxMissing = SFX_KINDS.reduce((sum, kind) => sum + missingSfx(SHARED_SFX_DIR, kind).length, 0);
  if (sfxTotal) byFamily.push({ family: "sfx", present: sfxTotal - sfxMissing, total: sfxTotal });
  const assetsReady = !sfxMissing && assets.every((asset) => asset.state === "present" || asset.state === "drifted");
  checks.push(
    check(
      "assets",
      "Shared media (pnpm assets:sync --check)",
      false,
      assetsReady,
      byFamily.map((item) => `${item.family} ${item.present}/${item.total}`).join(", "),
    ),
  );

  // Coding-agent wiring (pnpm harness:setup): generated configs pin a Node path and this checkout's path.
  try {
    const harness = harnessHealth({ codeRoot: process.cwd() });
    checks.push(
      check(
        "harness",
        "Coding-agent harness wiring (pnpm harness:setup)",
        false,
        harness.problems.length === 0,
        harness.problems.length
          ? harness.problems.map((item) => `${item.path}: ${item.problem}`).join("; ")
          : harness.wired.length
            ? `agentbros wired for ${harness.wired.join(", ")}`
            : "no harness config yet",
      ),
    );
  } catch (error) {
    checks.push(
      check("harness", "Coding-agent harness wiring (pnpm harness:setup)", false, "warn", (error as Error).message),
    );
  }

  checks.push(higgsfieldKeyCheck(env.HIGGSFIELD_API_KEY));
  const keys = API_KEYS.map((key) => ({ ...key, set: !!env[key.name]?.trim() }));
  return { os, checks, keys };
}
