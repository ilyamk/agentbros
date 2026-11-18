import test from "node:test";
import assert from "node:assert/strict";
import type { DoctorCheck } from "../src/lib/doctor";
import { goalStatuses, keyStatuses } from "../src/lib/setup/keys";
import {
  buildPlan,
  consentSteps,
  machineLimits,
  renderReport,
  requiredReady,
  type MachineProfile,
} from "../src/lib/setup/plan";

const ok = (id: string, required = true): DoctorCheck => ({ id, label: id, status: "ok", detail: "fine", required });
const healthy = (): DoctorCheck[] => [
  ok("node"),
  ok("pnpm"),
  ok("install"),
  ok("ffmpeg"),
  ok("ffprobe"),
  ok("chromium"),
  ok("uv", false),
  ok("assets", false),
];
const replace = (checks: DoctorCheck[], next: DoctorCheck) => checks.map((c) => (c.id === next.id ? next : c));
const options = { envFile: true, envExample: true, assets: false, smoke: false };
const machine: MachineProfile = {
  os: "macos",
  platform: "darwin",
  arch: "arm64",
  cpus: 8,
  memoryGb: 16,
  diskFreeGb: 100,
  gpu: "Apple Silicon (Metal)",
  node: "26.13.1",
};

test("a healthy machine is ready with nothing to ask", () => {
  const steps = buildPlan("macos", healthy(), options);
  assert.ok(requiredReady(steps));
  assert.deepEqual(consentSteps(steps), []);
  assert.equal(steps.find((step) => step.id === "smoke")?.state, "skipped");
});

test("missing FFmpeg is a system step that needs consent, with the host's command", () => {
  const checks = replace(healthy(), {
    id: "ffmpeg",
    label: "ffmpeg",
    status: "fail",
    detail: "not on PATH",
    required: true,
    hint: "sudo apt-get install -y ffmpeg",
  });
  const steps = buildPlan("debian", checks, options);
  const ffmpeg = steps.find((step) => step.id === "ffmpeg")!;
  assert.equal(ffmpeg.scope, "system");
  assert.equal(ffmpeg.state, "needs-consent");
  assert.equal(ffmpeg.command, "sudo apt-get install -y ffmpeg");
  assert.equal(requiredReady(steps), false);
});

test("repository steps are plain to-dos: packages, Chromium, .env", () => {
  let checks = replace(healthy(), { id: "install", label: "", status: "fail", detail: "missing", required: true });
  checks = replace(checks, { id: "chromium", label: "", status: "warn", detail: "none yet", required: true });
  const steps = buildPlan("macos", checks, { ...options, envFile: false, smoke: true });
  for (const id of ["install", "chromium", "env", "smoke"]) {
    const step = steps.find((item) => item.id === id)!;
    assert.equal(step.scope, "repo", id);
    assert.equal(step.state, "todo", id);
  }
  assert.deepEqual(consentSteps(steps), []);
});

test("without uv the pinned Python is skipped, not attempted", () => {
  const checks = replace(healthy(), {
    id: "uv",
    label: "uv",
    status: "warn",
    detail: "uv not on PATH; Python 3.13.18: not installed",
    required: false,
    hint: "brew install uv",
  });
  const steps = buildPlan("macos", checks, options);
  assert.equal(steps.find((step) => step.id === "uv")?.state, "needs-consent");
  assert.equal(steps.find((step) => step.id === "python")?.state, "skipped");
  assert.ok(requiredReady(steps), "uv is optional");
});

test("steps the wrapper installed show as installed now", () => {
  const steps = buildPlan("macos", healthy(), { ...options, appliedByWrapper: ["node", "install"] });
  assert.equal(steps.find((step) => step.id === "node")?.state, "applied");
  assert.equal(steps.find((step) => step.id === "install")?.state, "applied");
  assert.equal(steps.find((step) => step.id === "pnpm")?.state, "done");
});

test("machine limits warn on small memory and disk", () => {
  const limits = machineLimits({ ...machine, memoryGb: 4, diskFreeGb: 3, gpu: "none" });
  assert.deepEqual(
    limits.filter((limit) => limit.level === "warn").map((limit) => limit.id),
    ["memory", "disk"],
  );
  assert.ok(limits.some((limit) => limit.id === "gpu"));
});

test("the report covers steps, machine, free work, keys by goal and next, without values", () => {
  const checks = replace(healthy(), {
    id: "ffmpeg",
    label: "ffmpeg",
    status: "fail",
    detail: "missing",
    required: true,
    hint: "brew install ffmpeg",
  });
  const steps = buildPlan("macos", checks, options);
  const keys = keyStatuses({ FAL_KEY: "value-that-must-not-appear" });
  const report = renderReport({
    date: "2026-11-16",
    mode: "plan",
    machine,
    steps,
    checks,
    keys,
    goals: goalStatuses(keys),
    focusGoals: ["voiceover", "image-generation"],
    activate: "fnm use 26.13.1",
  });
  for (const heading of ["## Steps", "## This machine", "## Works now, with no keys", "## Service keys", "## Next"])
    assert.ok(report.includes(heading), heading);
  assert.match(report, /Not ready yet/);
  assert.match(report, /brew install ffmpeg/);
  assert.match(report, /setup\.sh --apply --system/);
  assert.match(report, /fnm use 26\.13\.1/);
  assert.match(report, /Generated voiceover \| needs a key/);
  assert.match(report, /AI image generation \| ✅ via FAL_KEY/);
  assert.doesNotMatch(report, /Stock photos and video \|/, "focus goals limit the goal table");
  assert.match(report, /never paste a key into the agent chat/);
  assert.ok(!report.includes("value-that-must-not-appear"));
});
