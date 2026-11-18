/**
 * Setup plan and report for `pnpm bootstrap`: pure functions over probed facts,
 * so the plan, its consent scopes and the user-facing report are unit-tested
 * without touching the machine.
 *
 * Scopes decide consent: `repo` steps change only this checkout and its caches
 * and run with `--apply`; `user` steps install tools into the user's home and
 * `system` steps use a package manager or sudo. The agent asks the user before
 * either of those (setup.sh / setup.ps1 run them; this module only plans).
 */
import type { DoctorCheck, HostOs } from "../doctor";
import type { GoalStatus, KeyStatus } from "./keys";

export type StepScope = "repo" | "user" | "system";
export type StepState = "done" | "todo" | "applied" | "failed" | "skipped" | "needs-consent";

export interface SetupStep {
  id: string;
  title: string;
  scope: StepScope;
  required: boolean;
  state: StepState;
  /** The exact command, for a person or an agent; repo steps are run by bootstrap itself. */
  command?: string;
  detail?: string;
}

export interface MachineProfile {
  os: HostOs;
  platform: NodeJS.Platform;
  arch: string;
  cpus: number;
  memoryGb: number;
  diskFreeGb?: number;
  gpu: string;
  node: string;
}

export interface MachineLimit {
  id: string;
  level: "info" | "warn";
  message: string;
}

const NEEDED_DISK_GB = 8;

/** What this machine can comfortably do, said plainly. */
export function machineLimits(machine: MachineProfile): MachineLimit[] {
  const limits: MachineLimit[] = [];
  const concurrency = Math.max(1, Math.floor(machine.cpus / 2));
  limits.push({
    id: "render-concurrency",
    level: "info",
    message: `${machine.cpus} CPU cores: Remotion renders with about ${concurrency} parallel frames by default.`,
  });
  if (machine.memoryGb < 8)
    limits.push({
      id: "memory",
      level: "warn",
      message: `${machine.memoryGb} GB RAM: render one format at a time and keep 3D (Blender) and local speech models off while rendering.`,
    });
  else if (machine.memoryGb < 16)
    limits.push({
      id: "memory",
      level: "info",
      message: `${machine.memoryGb} GB RAM: fine for 1080p renders; run Blender or local models one at a time.`,
    });
  if (machine.diskFreeGb !== undefined && machine.diskFreeGb < NEEDED_DISK_GB)
    limits.push({
      id: "disk",
      level: "warn",
      message: `${machine.diskFreeGb} GB free disk: install, Chromium, Python workers and renders need about ${NEEDED_DISK_GB} GB; shared media more.`,
    });
  if (machine.gpu === "none")
    limits.push({
      id: "gpu",
      level: "info",
      message: "No GPU detected: local speech and cut-out models run on the CPU (slower, still free).",
    });
  return limits;
}

const byId = (checks: readonly DoctorCheck[], id: string) => checks.find((check) => check.id === id);
const failing = (check: DoctorCheck | undefined) => !!check && check.status !== "ok";

export interface PlanOptions {
  envFile: boolean;
  envExample: boolean;
  assets: boolean;
  smoke: boolean;
  /** Steps the setup.sh / setup.ps1 wrapper already applied before handing over. */
  appliedByWrapper?: readonly string[];
  /** The harness wiring plan (pnpm harness:setup): links and MCP configs still to write, and for which harnesses. */
  harness?: { todo: boolean; detail: string };
}

export function buildPlan(os: HostOs, checks: readonly DoctorCheck[], options: PlanOptions): SetupStep[] {
  const steps: SetupStep[] = [];
  const wrapper = new Set(options.appliedByWrapper ?? []);
  const state = (id: string, todo: boolean, fallback: StepState = "todo"): StepState =>
    !todo ? (wrapper.has(id) ? "applied" : "done") : fallback;

  const node = byId(checks, "node");
  steps.push({
    id: "node",
    title: "Node.js at the pinned version",
    scope: "user",
    required: true,
    state: state("node", node?.status === "fail", "needs-consent"),
    ...(node?.status !== "ok" && node?.hint ? { command: node.hint } : {}),
    detail: node?.detail,
  });
  const pnpm = byId(checks, "pnpm");
  steps.push({
    id: "pnpm",
    title: "pnpm at the version in package.json",
    scope: "user",
    required: true,
    state: state("pnpm", failing(pnpm), "needs-consent"),
    ...(failing(pnpm) && pnpm?.hint ? { command: pnpm.hint } : {}),
    detail: pnpm?.detail,
  });
  const install = byId(checks, "install");
  steps.push({
    id: "install",
    title: "Node packages (pnpm install --frozen-lockfile)",
    scope: "repo",
    required: true,
    state: state("install", failing(install)),
    command: "pnpm install --frozen-lockfile",
    detail: install?.detail,
  });
  const ffmpeg = byId(checks, "ffmpeg"),
    ffprobe = byId(checks, "ffprobe");
  const ffmpegMissing = failing(ffmpeg) || failing(ffprobe);
  steps.push({
    id: "ffmpeg",
    title: "FFmpeg and ffprobe",
    scope: "system",
    required: true,
    state: state("ffmpeg", ffmpegMissing, "needs-consent"),
    ...(ffmpegMissing && ffmpeg?.hint ? { command: ffmpeg.hint } : {}),
    detail: ffmpeg?.detail,
  });
  const chromium = byId(checks, "chromium");
  steps.push({
    id: "chromium",
    title: "Chrome Headless Shell for rendering",
    scope: "repo",
    required: true,
    state: state("chromium", failing(chromium)),
    command: "pnpm exec remotion browser ensure",
    detail:
      os === "debian" && failing(chromium)
        ? `${chromium?.detail ?? ""}; on Debian/Ubuntu it also needs system libraries: ${chromium?.hint ?? ""}`
        : chromium?.detail,
  });
  const uv = byId(checks, "uv");
  const uvMissing = !!uv && /uv not on PATH/.test(uv.detail);
  steps.push({
    id: "uv",
    title: "uv (Python workers: audio maps, reference analysis, local speech)",
    scope: "user",
    required: false,
    state: state("uv", uvMissing, "needs-consent"),
    ...(uvMissing && uv?.hint ? { command: uv.hint } : {}),
    detail: uv?.detail,
  });
  const pythonMissing = !!uv && !uvMissing && uv.status !== "ok";
  steps.push({
    id: "python",
    title: "Pinned Python for the workers (uv python install)",
    scope: "repo",
    required: false,
    state: uvMissing ? "skipped" : state("python", pythonMissing),
    command: "uv python install",
    detail: uvMissing ? "needs uv first" : uv?.detail,
  });
  steps.push({
    id: "env",
    title: ".env from .env.example (empty keys; the user fills it)",
    scope: "repo",
    required: false,
    state: options.envFile ? "done" : options.envExample ? "todo" : "skipped",
    detail: options.envFile ? ".env exists; left untouched" : "copies the template, never overwrites",
  });
  const assets = byId(checks, "assets");
  steps.push({
    id: "assets",
    title: "Shared media: HDRIs, 3D models, sounds (otherwise fetched on demand)",
    scope: "repo",
    required: false,
    state: !failing(assets) ? "done" : options.assets ? "todo" : "skipped",
    command: "pnpm assets:sync --all",
    detail: assets?.detail,
  });
  if (options.harness)
    steps.push({
      id: "harness",
      title: "Coding-agent harnesses: skill links and the agentbros MCP server (git-ignored files in this folder)",
      scope: "repo",
      required: false,
      state: options.harness.todo ? "todo" : "done",
      command: "pnpm harness:setup --apply",
      detail: options.harness.detail,
    });
  steps.push({
    id: "smoke",
    title: "One-second test render (proves bundler, Chromium and encoder)",
    scope: "repo",
    required: false,
    state: options.smoke ? "todo" : "skipped",
    command: "pnpm bootstrap --apply --smoke",
  });
  return steps;
}

/** Steps an agent must show the user and get a yes for before running them. */
export function consentSteps(steps: readonly SetupStep[]): SetupStep[] {
  return steps.filter((step) => step.state === "needs-consent");
}

export function requiredReady(steps: readonly SetupStep[]): boolean {
  return steps.filter((step) => step.required).every((step) => step.state === "done" || step.state === "applied");
}

export interface ReportInput {
  date: string;
  mode: "plan" | "apply";
  machine: MachineProfile;
  steps: readonly SetupStep[];
  checks: readonly DoctorCheck[];
  keys: readonly KeyStatus[];
  goals: readonly GoalStatus[];
  focusGoals: readonly string[];
  smokeOutput?: string;
  /** Shell line that puts the Node a wrapper just installed on PATH in a new shell. */
  activate?: string;
}

const STATE_MARK: Record<StepState, string> = {
  done: "✅ ready",
  applied: "✅ installed now",
  todo: "⏳ to do",
  failed: "❌ failed",
  skipped: "— skipped",
  "needs-consent": "🙋 needs the user's yes",
};

const cell = (text: string | undefined) => (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Works with no key: listed only when its tool checks pass. */
function worksNow(checks: readonly DoctorCheck[]): string[] {
  const ok = (id: string) => byId(checks, id)?.status === "ok";
  const items = [
    "Motion-graphics films, ads, explainers and lessons built in code (Remotion), rendered locally",
    "Editing the user's own videos: cuts, captions, shorts, vertical crops",
    "Preview in Remotion Studio (`pnpm studio`) and local review (`pnpm review:ui`)",
    "Synthesised sound-effect pack (`pnpm sfx:synth`)",
    "Images the user's agent made itself, imported without paying again (`pnpm asset:import`)",
  ];
  if (ok("uv")) items.push("Free local transcription and speech detection (`pnpm speech:local`)");
  if (ok("matte")) items.push("Free local background removal (`pnpm matte`)");
  if (ok("blender")) items.push("Blender 3D shots (`pnpm blender:run`)");
  if (ok("yt-dlp")) items.push("Downloading public references by link (`pnpm media:fetch`)");
  return items;
}

export function renderReport(input: ReportInput): string {
  const ready = requiredReady(input.steps);
  const consent = consentSteps(input.steps);
  const lines: string[] = [
    "# Agent Bros. Pictures: setup report",
    "",
    `${input.date} · ${input.machine.os} ${input.machine.arch} · Node ${input.machine.node} · mode: ${input.mode}`,
    "",
    ready
      ? "**Ready for local work.** Everything required is installed; keys below are optional and unlock paid or extra services."
      : "**Not ready yet.** The required steps marked below still need doing.",
    "",
    "## Steps",
    "",
    "| Step | Scope | State | Command |",
    "|---|---|---|---|",
    ...input.steps.map(
      (step) =>
        `| ${cell(step.title)}${step.required ? "" : " (optional)"} | ${step.scope} | ${STATE_MARK[step.state]} | ${step.command && step.state !== "done" && step.state !== "skipped" ? `\`${cell(step.command)}\`` : ""} |`,
    ),
    "",
  ];
  if (consent.length)
    lines.push(
      "These change the machine outside this folder, so the agent asks first:",
      "",
      ...consent.map((step) => `- ${step.title}: \`${step.command ?? "see docs/install.md"}\` (${step.scope})`),
      "",
      "After a yes: `./setup.sh --apply --system` (Windows: `./setup.ps1 -Apply -System`).",
      "",
    );
  if (input.activate)
    lines.push(
      "Node was installed through a version manager. A new shell does not see it yet; run this first:",
      "",
      `\`${input.activate}\``,
      "",
    );
  if (input.smokeOutput) lines.push(`Test render: \`${input.smokeOutput}\``, "");

  lines.push("## This machine", "");
  const m = input.machine;
  lines.push(
    `- ${m.cpus} CPU cores, ${m.memoryGb} GB RAM${m.diskFreeGb !== undefined ? `, ${m.diskFreeGb} GB free disk` : ""}, GPU: ${m.gpu}`,
  );
  for (const limit of machineLimits(m)) lines.push(`- ${limit.level === "warn" ? "⚠️ " : ""}${limit.message}`);
  const optional = input.checks.filter(
    (check) => !check.required && check.status !== "ok" && check.hint && !check.id.endsWith("-key"),
  );
  if (optional.length) {
    lines.push("", "Optional tools not installed (each unlocks more; none is needed to start):", "");
    for (const check of optional) lines.push(`- ${check.label}: \`${cell(check.hint)}\``);
  }

  lines.push("", "## Works now, with no keys", "", ...worksNow(input.checks).map((item) => `- ${item}`), "");

  lines.push(
    "## Service keys",
    "",
    "Keys are optional. Paid ones bill the user's own account, and a key never authorises spending by itself: every paid job also needs a project budget. The user puts keys into `.env` in this folder themselves; **never paste a key into the agent chat**. Check with `pnpm keys` (shows set or not, never values).",
    "",
  );
  const goals = input.focusGoals.length
    ? input.goals.filter((goal) => input.focusGoals.includes(goal.id))
    : input.goals;
  lines.push("| Goal | Status | Add one of | Without a key |", "|---|---|---|---|");
  for (const goal of goals)
    lines.push(
      `| ${goal.label} | ${goal.ready ? `✅ via ${goal.via.join(", ")}` : "needs a key"} | ${goal.ready ? "" : goal.options.map((o) => `\`${o.name}\` (${o.service}, ${o.cost})`).join("<br>")} | ${cell(goal.withoutKeys) || "—"} |`,
    );
  const problems = input.keys.filter((key) => key.state === "malformed" || key.state === "incomplete");
  if (problems.length)
    lines.push(
      "",
      ...problems.map((key) =>
        key.state === "malformed"
          ? `- ⚠️ \`${key.name}\` is set but malformed (${key.unlocks}).`
          : `- ⚠️ \`${key.name}\` is set without its pair; set both or neither.`,
      ),
    );
  lines.push("", "Where to get each key:", "");
  for (const key of input.keys)
    lines.push(`- \`${key.name}\` [${key.cost}]${key.state === "set" ? " (set)" : ""}: ${key.unlocks}. ${key.signup}`);

  lines.push(
    "",
    "## Next",
    "",
    ready
      ? "1. Read `AGENTS.md` (the rules and the first step of any video request)."
      : "1. Finish the steps above, then run `pnpm bootstrap` again.",
    "2. Make the offline demo with no keys: `docs/install.md`, section 4.",
    '3. Ask for a video in one sentence; the agent starts with `pnpm playbook --match "<request>"`.',
    "",
  );
  return lines.join("\n");
}
