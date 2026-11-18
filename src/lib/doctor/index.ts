import { runtimePolicy } from "../runtime";
import { parseHiggsfieldKey } from "../providers/higgsfield/client";
import { ENV_KEYS } from "../setup/keys";
export type CheckStatus = "ok" | "warn" | "fail";
export type HostOs = "macos" | "debian" | "linux" | "windows";
export type Tool =
  | "node"
  | "pnpm"
  | "corepack"
  | "install"
  | "ffmpeg"
  | "ffprobe"
  | "chromium"
  | "uv"
  | "blender"
  | "blender-live"
  | "yt-dlp"
  | "swiftc"
  | "assets"
  | "matte"
  | "harness";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  required: boolean;
  hint?: string;
}

/** Service keys the doctor reports as set or not: the setup registry, so the two cannot drift. */
export const API_KEYS: readonly { name: string; unlocks: string }[] = ENV_KEYS.map(({ name, unlocks }) => ({
  name,
  unlocks,
}));

const CHROMIUM_APT =
  "sudo apt-get install -y libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2";
const CHROMIUM_FETCH = "pnpm exec remotion browser ensure (or let the first render download Chrome Headless Shell)";

const STOP_LIVE =
  "pnpm blender:live --action stop [--project <id>] [--session <name>] for each session you no longer use";
const HINTS: Partial<Record<Tool, Partial<Record<HostOs, string>>>> = {
  node: {
    macos: "nvm install && nvm use (reads .nvmrc)",
    debian: "nvm install && nvm use (reads .nvmrc)",
    windows: "Install the exact Node version in .nvmrc with nvm-windows",
  },
  corepack: {
    macos: "npm install -g corepack (no longer bundled from Node 25)",
    debian: "npm install -g corepack (no longer bundled from Node 25)",
    windows: "npm install -g corepack (no longer bundled from Node 25)",
  },
  install: {
    macos: "pnpm install --frozen-lockfile",
    debian: "pnpm install --frozen-lockfile",
    windows: "pnpm install --frozen-lockfile",
  },
  ffmpeg: {
    macos: "brew install ffmpeg",
    debian: "sudo apt-get install -y ffmpeg",
    windows: "winget install Gyan.FFmpeg (or choco install ffmpeg)",
  },
  ffprobe: {
    macos: "brew install ffmpeg",
    debian: "sudo apt-get install -y ffmpeg",
    windows: "winget install Gyan.FFmpeg (or choco install ffmpeg)",
  },
  chromium: { macos: CHROMIUM_FETCH, debian: `${CHROMIUM_APT}; then ${CHROMIUM_FETCH}`, windows: CHROMIUM_FETCH },
  uv: {
    macos: "brew install uv",
    debian: "curl -LsSf https://astral.sh/uv/install.sh | sh",
    windows: "winget install astral-sh.uv (or choco install uv)",
  },
  blender: {
    macos: "brew install --cask blender",
    debian: "sudo snap install blender --classic (apt ships an old release)",
    windows: "winget install BlenderFoundation.Blender (or choco install blender)",
  },
  "blender-live": { macos: STOP_LIVE, debian: STOP_LIVE, windows: STOP_LIVE },
  "yt-dlp": {
    macos: "brew install yt-dlp (or rely on uv run --locked --no-default-groups --group yt-dlp yt-dlp)",
    debian: "rely on uv run --locked --no-default-groups --group yt-dlp yt-dlp (or sudo apt-get install -y yt-dlp)",
    windows: "winget install yt-dlp.yt-dlp (or choco install yt-dlp)",
  },
  swiftc: { macos: "xcode-select --install" },
  harness: {
    macos: "pnpm harness:setup --apply (rerun after a Node upgrade or moving the checkout)",
    debian: "pnpm harness:setup --apply (rerun after a Node upgrade or moving the checkout)",
    windows: "pnpm harness:setup --apply (rerun after a Node upgrade or moving the checkout)",
  },
  matte: {
    macos:
      "pnpm media:prepare --engines matte (Apple Vision); pnpm assets:sync --id models:birefnet-general-lite (ONNX, any OS)",
    debian: "pnpm assets:sync --id models:birefnet-general-lite (ONNX through uv)",
    linux: "pnpm assets:sync --id models:birefnet-general-lite (ONNX through uv)",
    windows: "pnpm assets:sync --id models:birefnet-general-lite (ONNX through uv)",
  },
  assets: {
    macos: "pnpm assets:sync --all (or let render fetch on demand)",
    debian: "pnpm assets:sync --all (or let render fetch on demand)",
    windows: "pnpm assets:sync --all (or let render fetch on demand)",
  },
};

export function parseVersion(text: string): number[] | undefined {
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? [0, 0, 0];
  const right = parseVersion(b) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function meetsMinimum(version: string, minimum: string): boolean {
  return parseVersion(version) !== undefined && compareVersions(version, minimum) >= 0;
}

export function detectOs(platform: NodeJS.Platform, osRelease = ""): HostOs {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return /^(ID|ID_LIKE)=.*\b(debian|ubuntu)\b/m.test(osRelease) ? "debian" : "linux";
}

export function hintFor(tool: Tool, os: HostOs): string | undefined {
  if (tool === "pnpm") return `npm install --global ${runtimePolicy().packageManager} --allow-scripts=pnpm`;
  const hints = HINTS[tool];
  return (
    hints?.[os] ??
    (os === "linux"
      ? hints?.debian?.replace(/sudo apt-get install -y/g, "install with your package manager:")
      : undefined)
  );
}

export function overall(checks: readonly DoctorCheck[]): { ok: boolean; counts: Record<CheckStatus, number> } {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { ok: counts.fail === 0, counts };
}

export function higgsfieldKeyCheck(value: string | undefined): DoctorCheck {
  let valid = false;
  try {
    parseHiggsfieldKey(value);
    valid = true;
  } catch {
    /* Report presence and shape only. */
  }
  return {
    id: "higgsfield-key",
    label: "HIGGSFIELD_API_KEY",
    status: valid ? "ok" : "warn",
    required: false,
    detail: valid
      ? "present and well-formed"
      : value?.trim()
        ? "present but malformed (expected <id>:<secret>)"
        : "not set",
    ...(valid ? {} : { hint: "https://open.higgsfield.ai/api-keys" }),
  };
}
export function formatReport(
  checks: readonly DoctorCheck[],
  keys: readonly { name: string; set: boolean; unlocks: string }[],
): string {
  const mark: Record<CheckStatus, string> = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
  const lines = ["", "Agent Bros. Pictures doctor", ""];
  for (const check of checks) {
    lines.push(`[${mark[check.status]}] ${check.label}${check.required ? "" : " (optional)"}: ${check.detail}`);
    if (check.status !== "ok" && check.hint) lines.push(`         fix: ${check.hint}`);
  }
  lines.push("", "API keys (none are needed for local rendering or tests):");
  for (const key of keys) lines.push(`  ${key.set ? "set    " : "not set"}  ${key.name.padEnd(20)} ${key.unlocks}`);
  const { ok, counts } = overall(checks);
  lines.push(
    "",
    `${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} failure(s). ${ok ? "Ready for local rendering." : "Fix the failures above, then run pnpm preflight again."}`,
    "",
  );
  return lines.join("\n");
}
