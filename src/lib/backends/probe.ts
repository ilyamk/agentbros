import { pythonToolArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ensureBrowser } from "@remotion/renderer";
import type { BackendProbe } from "./handoff";
import { toolRoot } from "../hyperframes/render";
import { probeVork } from "../vork/runtime";
export { probeVork };
export type BlenderProbe = BackendProbe & { path?: string; routes: string[]; searched?: string[] };
export type ToolProbe = BackendProbe & { installed: boolean; path?: string; routes: string[] };
export type ProcessRunner = (
  executable: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => { status: number | null; stdout: string; stderr: string; error?: Error };
export const runLocalProcess: ProcessRunner = (executable, args, env) => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    env:
      env ??
      Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG", "PYTHONPATH", "RESOLVE_SCRIPT_API", "RESOLVE_SCRIPT_LIB"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]!]),
      ),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
};
const BLENDER_BUNDLES = [
  "/Applications/Blender.app/Contents/MacOS/Blender",
  path.join(homedir(), "Applications/Blender.app/Contents/MacOS/Blender"),
];
const atLeast = (version: string, major: number, minor: number) => {
  const [a = 0, b = 0] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
};
const blenderSupported = (version?: string) =>
  !!version && atLeast(version, 4, 2) && Number(version.split(".")[0]) <= 5;
const blenderVersion = (output: string) => output.match(/Blender (\d+\.\d+(?:\.\d+)?)/)?.[1];
/** Local routes this version can take. MCP routes are eligibility only: this never connects or installs one. */
function blenderRoutes(version: string, executable: string): string[] {
  return [
    "headless-run",
    "procedural-capture",
    ...(version === "4.5.14" ? ["declarative-scene"] : []),
    ...(atLeast(version, 5, 1) ? ["mcp-official-eligible"] : []),
    "mcp-community-eligible",
    ...(executable.includes(".app/") || process.platform !== "darwin" ? ["gui"] : []),
  ];
}
/** With no executable this searches PATH, then the macOS app bundles. */
export function probeBlender(executable?: string, runner: ProcessRunner = runLocalProcess): BlenderProbe {
  const candidates = executable
    ? [executable]
    : ["blender", ...BLENDER_BUNDLES.filter((candidate) => existsSync(candidate))];
  let found: { path: string; version?: string } | undefined;
  for (const candidate of candidates) {
    const result = runner(candidate, ["--version"]);
    if (result.status !== 0) continue;
    const version = blenderVersion(result.stdout);
    if (blenderSupported(version)) {
      found = { path: candidate, version };
      break;
    }
    found ??= { path: candidate, version };
  }
  if (!found)
    return {
      backend: "blender",
      available: false,
      capabilities: [],
      routes: [],
      searched: candidates,
      reason: "Blender executable unavailable",
      liveVerified: false,
    };
  const supported = blenderSupported(found.version);
  return {
    backend: "blender",
    available: supported,
    ...(found.version ? { version: found.version } : {}),
    path: found.path,
    routes: supported ? blenderRoutes(found.version!, found.path) : [],
    capabilities: supported ? ["procedural-scene", "absolute-frame-seek", "png-capture", "headless-python-run"] : [],
    reason: supported ? undefined : "Only Blender 4.2+/5.x protocols are supported",
    liveVerified: false,
  };
}
/** Never downloads: `--offline` reads uv's cache only. */
export function probeYtDlp(runner: ProcessRunner = runLocalProcess): ToolProbe {
  const direct = runner("yt-dlp", ["--version"]);
  if (direct.status === 0)
    return {
      backend: "yt-dlp",
      available: true,
      installed: true,
      version: direct.stdout.trim(),
      routes: ["path"],
      capabilities: ["media-download"],
      liveVerified: false,
    };
  if (runner(pythonUv(), ["--version"]).status !== 0)
    return {
      backend: "yt-dlp",
      available: false,
      installed: false,
      routes: [],
      capabilities: [],
      reason: "Neither yt-dlp nor uv is on PATH",
      liveVerified: false,
    };
  const cached = runner(
    pythonUv(),
    ["--offline", ...pythonToolArgs("yt-dlp", "yt-dlp", ["--version"])],
    pythonEnvironment("yt-dlp"),
  );
  const installed = cached.status === 0;
  return {
    backend: "yt-dlp",
    available: true,
    installed,
    ...(installed ? { version: cached.stdout.trim() } : {}),
    routes: ["uv"],
    capabilities: ["media-download"],
    reason: installed ? undefined : "The locked uv yt-dlp profile downloads it on first use; ask the user first",
    liveVerified: false,
  };
}
/** Never downloads: `--no` refuses an install and `--offline` keeps npm off the network. The pinned install is read, not run, because running it would write to the real home. */
export function probeHyperframesCli(runner: ProcessRunner = runLocalProcess, home = homedir()): ToolProbe {
  const tool = path.join(toolRoot(home), "tool", "node_modules");
  if (existsSync(path.join(tool, ".bin", "hyperframes"))) {
    const { version } = JSON.parse(readFileSync(path.join(tool, "hyperframes", "package.json"), "utf8")) as {
      version: string;
    };
    return {
      backend: "hyperframes-cli",
      available: true,
      installed: true,
      version,
      path: path.join(tool, ".bin", "hyperframes"),
      routes: ["pinned"],
      capabilities: ["html-to-video-cli"],
      liveVerified: false,
    };
  }
  const npx = ["npx", path.join(path.dirname(process.execPath), "npx")].find(
    (candidate) => runner(candidate, ["--version"]).status === 0,
  );
  if (!npx)
    return {
      backend: "hyperframes-cli",
      available: false,
      installed: false,
      routes: [],
      capabilities: [],
      reason: "npx is unavailable",
      liveVerified: false,
    };
  const local = runner(npx, ["--no", "--offline", "--", "hyperframes", "--version"]);
  const installed = local.status === 0;
  return {
    backend: "hyperframes-cli",
    available: true,
    installed,
    ...(installed ? { version: local.stdout.trim() } : {}),
    path: npx,
    routes: ["npx"],
    capabilities: ["html-to-video-cli"],
    reason: installed ? undefined : "`npx hyperframes` downloads it on first use; ask the user first",
    liveVerified: false,
  };
}
/** A read-only connection probe does not claim permission/capability to mutate Resolve. */
export function probeResolve(python = "python3", runner: ProcessRunner = runLocalProcess): BackendProbe {
  const code = `import json\ntry:\n import DaVinciResolveScript as module\n app = module.scriptapp("Resolve")\n if app is None: raise RuntimeError("Resolve scripting connection unavailable")\n print(json.dumps({"available":True,"version":app.GetVersionString()}))\nexcept Exception:\n print(json.dumps({"available":False,"reason":"Resolve scripting module or running application unavailable"}))`;
  const result = runner(python, ["-c", code]);
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
      available?: boolean;
      version?: string;
      reason?: string;
    };
    const supported = parsed.available === true && /^(19|20)\./.test(parsed.version ?? "");
    return {
      backend: "resolve",
      available: supported,
      version: parsed.version,
      capabilities: supported ? ["read-only-version-probe"] : [],
      reason:
        parsed.reason ??
        (supported ? "Live clone/import/readback adapter not configured" : "Unsupported Resolve version"),
      liveVerified: supported,
    };
  } catch {
    return {
      backend: "resolve",
      available: false,
      capabilities: [],
      reason: "Resolve read-only probe failed",
      liveVerified: false,
    };
  }
}
/** Checks the bundled Chromium without permitting a download or remote request. */
export async function probeHtml(): Promise<BackendProbe> {
  try {
    const status = await ensureBrowser({
      logLevel: "error",
      onBrowserDownload: () => {
        throw new Error("Installed Chromium required; no download attempted");
      },
    });
    return {
      backend: "hyperframes-html",
      available: ["local-puppeteer-browser", "user-defined-path"].includes(status.type),
      capabilities: [
        "offline-asset-allowlist",
        "absolute-frame-seek",
        "avc-frame-v1",
        "hyperframes-seek-subset",
        "png-capture",
        "silent-mp4",
        "native-local-media-v1",
        "static-local-instances-v1",
        "static-local-instances-v2-compiled-source",
      ],
      liveVerified: false,
      reason:
        "Installed Chromium located; verify each trusted composition through capture. Pinned offline native local audio and opt-in static-local-instances-v2 compiled subset are supported; genuine C24 runtime acceptance is false/pending. Full engine support is not claimed.",
    };
  } catch (error) {
    return {
      backend: "hyperframes-html",
      available: false,
      capabilities: [],
      liveVerified: false,
      reason: (error as Error).message,
    };
  }
}
export function listOptionalBackends() {
  return [
    {
      backend: "vork",
      available: false,
      capabilities: ["scene-check", "gpu-render", "slang-programs", "native-geometry-export", "control-passes"],
      reason: "Optional pinned Vork 0.5.1 runtime; probe and verify locally",
      liveVerified: false,
    },
    {
      backend: "otio",
      available: true,
      capabilities: ["tracks", "source-fps", "trim", "linear-rate", "exact-metadata", "caption-sidecars"],
      liveVerified: false,
    },
    {
      backend: "fcpxml",
      available: true,
      capabilities: ["connected-tracks", "source-fps", "trim", "cut-only", "caption-sidecars"],
      liveVerified: false,
    },
    {
      backend: "resolve",
      available: false,
      implementation: true,
      capabilities: [
        "recoverable-handoff",
        "local-sdk-worker",
        "clone-only",
        "native-readback",
        "cut-only-equal-integer-fps",
      ],
      reason: "Optional Resolve 20.2+ SDK/application required; probe a prepared handoff with resolve:handoff",
      liveVerified: false,
    },
    {
      backend: "blender",
      available: false,
      capabilities: ["conditional-procedural-capture", "headless-python-run"],
      reason: "Optional Blender 4.2+/5.x executable required; run the probe for its routes",
      liveVerified: false,
    },
    {
      backend: "yt-dlp",
      available: false,
      capabilities: ["media-download"],
      reason: "Optional; run the probe, which never downloads",
      liveVerified: false,
    },
    {
      backend: "hyperframes-cli",
      available: false,
      capabilities: ["html-to-video-cli"],
      reason: "Optional; run the probe, which never downloads",
      liveVerified: false,
    },
    {
      backend: "opencut",
      available: false,
      capabilities: [],
      reason: "Audited rewrite has no verified versioned editor/headless API",
      liveVerified: false,
    },
    {
      backend: "hyperframes-html",
      available: false,
      implementation: true,
      capabilities: [
        "offline-asset-allowlist",
        "absolute-frame-seek",
        "avc-frame-v1",
        "hyperframes-seek-subset",
        "png-capture",
        "silent-mp4",
        "native-local-media-v1",
        "static-local-instances-v1",
        "static-local-instances-v2-compiled-source",
      ],
      reason:
        "Probe installed Chromium, then explicitly capture trusted offline HTML; pinned offline native local audio and explicit C24 compiled subset; genuine C24 runtime acceptance remains false/pending",
      liveVerified: false,
    },
  ];
}
