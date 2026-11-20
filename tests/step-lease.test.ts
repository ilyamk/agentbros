import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMAND_REGISTRY } from "../src/lib/cli/commands";
import { FILM_CHAIN } from "../src/lib/film/chain";
import { FILM_TYPES, stepEnabled } from "../src/lib/film/routes";
import { renderBrief } from "../src/lib/film/brief";
import { commandsFor, openFilmProject, PROXY_KINDS } from "../src/lib/film/state";
import type { FootageNext } from "../src/lib/footage/next";
import { footageLeaseFor, issueBriefLease, leaseAllow, proseAliases } from "../src/lib/step-lease/issue";
import {
  admit,
  aliasesIn,
  ALWAYS_ADMITTED,
  chainHash,
  clearLease,
  CONTROL_ALIASES,
  leaseFile,
  projectFromArgv,
  readLease,
  summariseViolations,
  writeLease,
  type AdmissionInput,
} from "../src/lib/step-lease/lease";
import { benchmarkProxyRun, effectiveGuardMode } from "../src/lib/step-lease/guard";
import { COMMANDS } from "../src/mcp/catalog";
import { prepareCommand } from "../src/mcp/bridge";
import type { StepLease, StepViolation } from "../src/types/step-lease";
// @ts-expect-error plain Node hook without types
import * as hook from "../scripts/hooks/claude-step-guard.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const HOOK = path.join(REPO, "scripts/hooks/claude-step-guard.mjs");
const ALIASES = new Set(COMMAND_REGISTRY.flatMap((entry) => (entry.alias ? [entry.alias] : [])));
const NOW = new Date("2026-11-17T10:00:00Z");

const lease = (overrides: Partial<StepLease> = {}): StepLease => ({
  schemaVersion: 1,
  project: "film",
  route: "film",
  step: "material",
  owner: "asset-planner",
  role: "owner",
  lanes: [],
  allow: [...CONTROL_ALIASES, "generate:model", "asset:import"],
  spending: ["generate:model"],
  paidAllowed: false,
  chainHash: "a".repeat(64),
  issuedAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  issuedBy: "film:next",
  ...overrides,
});

const input = (overrides: Partial<AdmissionInput> = {}): AdmissionInput => ({
  lease: lease(),
  leaseHash: "h".repeat(64),
  aliases: ["asset:import"],
  spend: "none",
  dryRun: false,
  currentHash: "a".repeat(64),
  now: NOW,
  ...overrides,
});

function cli(root: string, script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENTBROS_NO_DOTENV: "1", AGENTBROS_STEP_ADMITTED: "", ...env },
  });
  const line = run.stdout.trim().split("\n").at(-1) ?? "{}";
  return { status: run.status, stderr: run.stderr, json: JSON.parse(line) as Record<string, any> };
}

function film(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "step-lease-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = cli(root, "scripts/film-init.ts", ["--project", "film"]);
  assert.equal(init.status, 0, JSON.stringify(init.json));
  return { root, dir: path.join(root, "public/projects/film") };
}

test("every film step of every type leases registered aliases: control set, own commands, route command tools", () => {
  for (const type of FILM_TYPES)
    for (const step of FILM_CHAIN) {
      if (!stepEnabled(step.id, type)) continue;
      const allow = leaseAllow(step.id, type);
      for (const alias of allow) assert.ok(ALIASES.has(alias), `${type}/${step.id}: ${alias} is not registered`);
      for (const alias of CONTROL_ALIASES) assert.ok(allow.includes(alias), `${type}/${step.id} lacks ${alias}`);
      for (const command of commandsFor(step))
        assert.ok(allow.includes(command.alias), `${type}/${step.id} lacks its own ${command.alias}`);
    }
  for (const alias of CONTROL_ALIASES) assert.ok(ALIASES.has(alias), `control ${alias} is registered`);
  assert.ok(!leaseAllow("intake", "motion-graphics").includes("generate:model"), "intake has no generation");
  assert.ok(
    FILM_TYPES.some((type) => stepEnabled("material", type) && leaseAllow("material", type).includes("generate:model")),
    "material generates",
  );
  // RFC 0003: reference inputs are planned, prepared and packed at material in every type, so enforce admits them.
  for (const type of FILM_TYPES)
    if (stepEnabled("material", type))
      for (const alias of ["refs:plan", "refs:profiles", "refs:derive", "refs:pack", "entity:card"])
        assert.ok(leaseAllow("material", type).includes(alias), `${type}/material lacks ${alias}`);
});

test("the music step leases generate:music and may spend once a ceiling is raised in the user's words", (t) => {
  const { root, dir } = film(t);
  const project = openFilmProject(dir, { rootDir: root });
  issueBriefLease(project, { step: "music", role: "owner", agent: "sound-director" });
  const loaded = readLease(dir);
  assert.ok(loaded && "lease" in loaded);
  assert.ok(loaded.lease.allow.includes("generate:music"));
  assert.ok(loaded.lease.spending.includes("generate:music"));
  assert.equal(loaded.lease.paidAllowed, false);
  assert.equal(loaded.lease.paidWhen, "budget-ceiling");
  const spend = input({
    lease: loaded.lease,
    aliases: ["generate:music"],
    spend: "paid",
    currentHash: loaded.lease.chainHash,
  });
  assert.equal(admit({ ...spend, budgetCeiling: false }).admitted, false);
  assert.equal(admit({ ...spend, budgetCeiling: true }).admitted, true);
  issueBriefLease(project, { step: "ideas", role: "owner", agent: "concept-director", lane: "a" });
  const ideas = readLease(dir);
  assert.ok(ideas && "lease" in ideas);
  assert.equal(ideas.lease.paidWhen, undefined);
});

test("every brief's own commands are in its lease; the user's records never come from prose", (t) => {
  const { root, dir } = film(t);
  const briefFile = path.join(dir, "pipeline/brief.json");
  const base = JSON.parse(readFileSync(briefFile, "utf8"));
  assert.deepEqual(proseAliases("pnpm film:approve --answer x; pnpm feedback; pnpm budget; pnpm critic:pack"), [
    "critic:pack",
  ]);
  let checked = 0;
  for (const type of FILM_TYPES) {
    writeFileSync(briefFile, JSON.stringify({ ...base, filmType: type }));
    const project = openFilmProject(dir, { rootDir: root });
    for (const step of FILM_CHAIN) {
      if (!stepEnabled(step.id, type)) continue;
      for (const role of ["owner", "critic", "fixer"] as const) {
        let prompt: string;
        try {
          prompt = renderBrief(project, step.id, { role, ...(step.fanOut ? { lane: "a" } : {}) }).prompt;
        } catch {
          continue;
        }
        issueBriefLease(project, { step: step.id, role, agent: "x", prompt });
        const loaded = readLease(dir);
        assert.ok(loaded && "lease" in loaded, `${type}/${step.id}/${role}`);
        for (const alias of proseAliases(prompt))
          assert.ok(loaded.lease.allow.includes(alias), `${type}/${step.id}/${role}: brief names ${alias}`);
        assert.ok(!loaded.lease.allow.includes("film:approve"), `${type}/${step.id}/${role}: no approval from a brief`);
        checked++;
      }
    }
  }
  assert.ok(checked > 50, `briefs checked: ${checked}`);
});

test("aliases are read from command lines, labels and chains", () => {
  assert.deepEqual(
    aliasesIn('Scribe: pnpm budget --project a --answer "x" && pnpm transcribe --project a; pnpm run footage:next'),
    ["budget", "transcribe", "footage:next"],
  );
  assert.deepEqual(aliasesIn("pnpm exec tsx scripts/x.ts"), []);
  assert.equal(projectFromArgv(["--project=demo-a"]), "demo-a");
  assert.equal(projectFromArgv(["--project", "../x"]), undefined);
  assert.equal(projectFromArgv(["--step", "x"]), undefined);
});

test("the predicate: control, nested, expiry, staleness, allow list, spend, unlock", () => {
  assert.deepEqual(admit(input()), { admitted: true, via: "lease", alias: "asset:import" });
  assert.equal(
    admit(input({ aliases: ["film:next"], currentHash: "b".repeat(64) })).admitted,
    true,
    "control on stale",
  );
  const outside = admit(input({ aliases: ["film:measure"] }));
  assert.equal(!outside.admitted && outside.code, "not-in-step");
  assert.equal(admit(input({ aliases: ["film:measure"], nested: "h".repeat(64) })).admitted, true, "nested child");
  assert.equal(admit(input({ aliases: ["film:measure"], nested: "x".repeat(64) })).admitted, false, "other lease");
  const stale = admit(input({ currentHash: "b".repeat(64) }));
  assert.equal(!stale.admitted && stale.code, "stale");
  const expired = admit(input({ now: new Date(NOW.getTime() + 2 * 3_600_000) }));
  assert.equal(!expired.admitted && expired.code, "expired");
  const paid = admit(input({ aliases: ["generate:model"], spend: "paid" }));
  assert.equal(!paid.admitted && paid.code, "paid");
  assert.equal(admit(input({ aliases: ["generate:model"], spend: "paid", dryRun: true })).admitted, true, "planning");
  assert.equal(
    admit(input({ aliases: ["generate:model"], spend: "paid", lease: lease({ paidAllowed: true }) })).admitted,
    true,
  );
  const budgetLease = lease({ paidWhen: "budget-ceiling" });
  assert.equal(admit(input({ aliases: ["generate:model"], spend: "paid", lease: budgetLease })).admitted, false);
  assert.equal(
    admit(input({ aliases: ["generate:model"], spend: "paid", lease: budgetLease, budgetCeiling: true })).admitted,
    true,
  );
  const unlock = { at: NOW.toISOString(), until: NOW.toISOString(), reason: "manual repair" };
  assert.deepEqual(admit(input({ aliases: ["film:measure"], unlock })), {
    admitted: true,
    via: "unlock",
    alias: "film:measure",
    code: "not-in-step",
  });
  const unlockedPaid = admit(input({ aliases: ["generate:model"], spend: "paid", unlock }));
  assert.equal(!unlockedPaid.admitted && unlockedPaid.code, "paid", "an unlock never authorises spend");
});

test("film:next and film:brief write the lease; the guard warns, enforces, admits children and goes off", (t) => {
  const { root, dir } = film(t);
  const next = cli(root, "scripts/film-next.ts", ["--project", "film"]);
  assert.equal(next.status, 0, JSON.stringify(next.json));
  assert.equal(next.json.metadata.stepLease.step, next.json.metadata.step);
  const loaded = readLease(dir);
  assert.ok(loaded && "lease" in loaded);
  assert.equal(loaded.lease.paidAllowed, false);
  assert.equal(loaded.lease.chainHash, chainHash(dir, "film"));

  // Warn (default): the command runs, metadata.stepGuard and violations.jsonl say so.
  const warned = cli(root, "scripts/film-measure.ts", ["--project", "film"]);
  assert.match(warned.stderr, /\[step-guard\]/);
  const violations = path.join(dir, "pipeline/session/violations.jsonl");
  assert.match(
    readFileSync(violations, "utf8"),
    /"code":"not-in-step".*"mode":"warn","modeSource":"default","refused":false/,
  );
  if (warned.json.ok) assert.equal(warned.json.metadata.stepGuard.code, "not-in-step");

  // Enforce: refused before the script's own work, naming step, owner, the next command and the escape hatch.
  const refused = cli(root, "scripts/film-measure.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.equal(refused.json.error, "VALIDATION");
  assert.match(refused.json.message, /Step guard \(enforce\)/);
  assert.match(refused.json.message, /pnpm next --project film/);
  assert.match(refused.json.message, /step:unlock/);
  assert.match(refused.json.message, new RegExp(`step ${loaded.lease.step}`));

  // Paid without approval is refused, even when the alias would be listed.
  const paid = cli(root, "scripts/generate-model.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.match(paid.json.message ?? "", /Step guard/);

  // A child of an admitted command carries the lease hash and is admitted.
  const child = cli(root, "scripts/film-measure.ts", ["--project", "film"], {
    AGENTBROS_STEP_GUARD: "enforce",
    AGENTBROS_STEP_ADMITTED: loaded.hash,
  });
  assert.doesNotMatch(child.json.message ?? "", /Step guard/);

  // Off: no guard at all.
  const off = cli(root, "scripts/film-measure.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "off" });
  assert.doesNotMatch(off.json.message ?? "", /Step guard/);

  // Control commands pass on a stale lease; step tools fail closed with "run pnpm next".
  mkdirSync(path.join(dir, "pipeline/chain"), { recursive: true });
  writeFileSync(path.join(dir, "pipeline/chain/intake.json"), "{}");
  const status = cli(root, "scripts/film-status.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.equal(status.json.ok, true, JSON.stringify(status.json));
  assert.ok(status.json.metadata.stepGuard.outOfStep >= 1, "film:status reports out-of-step runs");
  const route = cli(root, "scripts/film-route.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.match(route.json.message ?? "", /chain changed/);

  // Expired leases fail closed too.
  rmSync(path.join(dir, "pipeline/chain/intake.json"));
  writeLease(dir, { ...loaded.lease, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const expired = cli(root, "scripts/film-route.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.match(expired.json.message ?? "", /expired/);

  // film:brief issues the brief's own lease.
  const brief = cli(root, "scripts/film-brief.ts", ["--project", "film", "--step", loaded.lease.step]);
  assert.equal(brief.status, 0, JSON.stringify(brief.json));
  assert.equal(brief.json.metadata.stepLease.role, "owner");
  const after = readLease(dir);
  assert.ok(after && "lease" in after && after.lease.issuedBy === "film:brief");
});

test("no lease: the guard is a no-op; clearLease only clears the named step", (t) => {
  const { root, dir } = film(t);
  const plain = cli(root, "scripts/film-route.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.equal(plain.json.ok, true, JSON.stringify(plain.json));
  assert.equal(plain.json.metadata.stepGuard, undefined);
  writeLease(dir, lease({ chainHash: chainHash(dir, "film") }));
  assert.equal(clearLease(dir, "intake"), false);
  assert.ok(existsSync(leaseFile(dir)));
  assert.equal(clearLease(dir, "material"), true);
  assert.equal(existsSync(leaseFile(dir)), false);
});

test("step:unlock admits out-of-step runs for a while, recorded as unlocked; spend stays refused", (t) => {
  const { root, dir } = film(t);
  writeLease(dir, lease({ step: "intake", allow: [...CONTROL_ALIASES], chainHash: chainHash(dir, "film") }));
  assert.equal(
    cli(root, "scripts/step-unlock.ts", ["--project", "film", "--reason", "x", "--minutes", "999"]).json.error,
    "INVALID_INPUT",
  );
  const unlock = cli(root, "scripts/step-unlock.ts", ["--project", "film", "--reason", "repair the brief by hand"]);
  assert.equal(unlock.status, 0, JSON.stringify(unlock.json));
  assert.equal(unlock.json.metadata.lease.step, "intake");
  const run = cli(root, "scripts/film-measure.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.doesNotMatch(run.json.message ?? "", /Step guard/);
  assert.match(readFileSync(path.join(dir, "pipeline/session/violations.jsonl"), "utf8"), /"unlocked":true/);
  const status = cli(root, "scripts/film-status.ts", ["--project", "film"]);
  assert.equal(status.json.metadata.stepGuard, undefined, "unlocked runs are not reported");
  const paid = cli(root, "scripts/generate-model.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "enforce" });
  assert.match(paid.json.message ?? "", /Step guard.*may spend/);
});

test("MCP: enforce refuses out-of-step tools before --allow-paid and narrows spend to a dry run", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "step-lease-mcp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/film");
  mkdirSync(dir, { recursive: true });
  // The MCP guard checks expiry against the real clock, so this lease must be live now (not at the fixed NOW).
  const live = new Date(Date.now() + 3_600_000).toISOString();
  writeLease(dir, lease({ chainHash: chainHash(dir, "film"), expiresAt: live }));
  const previous = process.env.AGENTBROS_STEP_GUARD;
  t.after(() =>
    previous === undefined ? delete process.env.AGENTBROS_STEP_GUARD : (process.env.AGENTBROS_STEP_GUARD = previous),
  );
  const options = { root, codeRoot: REPO, allowPaid: true };
  const measure = COMMANDS.find((command) => command.name === "film_measure")!;
  const model = COMMANDS.find((command) => command.name === "generate_model")!;
  const request = { project: "film", request: "request.json", output: "out.json", "dry-run": false };

  process.env.AGENTBROS_STEP_GUARD = "warn";
  assert.doesNotThrow(() => prepareCommand(measure, { project: "film" }, options), "warn leaves it to the child");
  assert.ok(prepareCommand(model, request, options).argv.includes("--dry-run=false"), "warn does not narrow");

  process.env.AGENTBROS_STEP_GUARD = "enforce";
  assert.throws(() => prepareCommand(measure, { project: "film" }, options), /Step guard \(enforce\).*film:measure/);
  const narrowed = prepareCommand(model, request, options);
  assert.ok(narrowed.argv.includes("--dry-run=true"), "--allow-paid can only narrow: no approval, a dry run");
  writeLease(dir, lease({ chainHash: chainHash(dir, "film"), paidAllowed: true, expiresAt: live }));
  assert.ok(prepareCommand(model, request, options).argv.includes("--dry-run=false"), "approved spend passes");
  assert.match(readFileSync(path.join(dir, "pipeline/session/violations.jsonl"), "utf8"), /"via":"mcp"/);
});

test("footage leases come from the answer's argv and follow-ups; spend waits for a budget ceiling", () => {
  const next = {
    action: "ask",
    step: "1-transcript",
    title: "Transcript",
    why: "",
    thenRun: [
      'Scribe: pnpm budget --project rec --ceiling-usd 1 --answer "<the user\'s words>" && pnpm transcribe --project rec',
      "local: pnpm footage:next --project rec --transcriber local",
    ],
    argv: [["pnpm", "speech:local", "--project", "rec"]],
    state: { project: "rec" },
  } as unknown as FootageNext;
  const leased = footageLeaseFor(tmpdir(), next, "footage:next", NOW)!;
  assert.ok(leased.allow.includes("transcribe") && leased.allow.includes("speech:local"));
  assert.deepEqual(leased.spending, ["transcribe"]);
  assert.equal(leased.paidWhen, "budget-ceiling");
  assert.equal(leased.paidAllowed, false);
  assert.equal(footageLeaseFor(tmpdir(), { ...next, action: "stop" }, "next", NOW), undefined);
});

test("the Claude Code hook denies out-of-step pnpm calls in enforce mode only", (t) => {
  assert.deepEqual(hook.ALWAYS_ADMITTED, [...ALWAYS_ADMITTED], "hook and lease share the always-admitted list");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "step-lease-hook-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/film");
  mkdirSync(dir, { recursive: true });
  // The hook (a shim over agentbros-hook.mjs's guard role, RFC 0004 §7.1) acts only inside a checkout.
  writeFileSync(path.join(root, "package.json"), "{}\n");
  mkdirSync(path.join(root, "scripts/hooks"), { recursive: true });
  writeFileSync(path.join(root, "scripts/hooks/agentbros-hook.mjs"), "// marker\n");
  writeLease(
    dir,
    lease({ expiresAt: new Date(Date.now() + 3_600_000).toISOString(), chainHash: chainHash(dir, "film") }),
  );
  const run = (command: string, mode: string) =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root }),
      encoding: "utf8",
      env: { ...process.env, AGENTBROS_STEP_GUARD: mode, AGENTBROS_HOOKS: "on" },
    });
  const denied = run("pnpm film:measure --project film", "enforce");
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /not a tool of step material/);
  assert.equal(run("pnpm film:measure --project film", "warn").stdout, "");
  assert.equal(run("pnpm asset:import --project film && pnpm next --project film", "enforce").stdout, "");
  assert.match(run("pnpm generate:model --project=film", "enforce").stdout, /may spend/);
  assert.equal(run("pnpm generate:model --project film --dry-run", "enforce").stdout, "");
  assert.equal(run("pnpm film:measure", "enforce").stdout, "", "no project, no lease");
  assert.equal(run("not json", "enforce").stdout, "");
  const garbage = spawnSync(process.execPath, [HOOK], { input: "{", encoding: "utf8" });
  assert.equal(garbage.status, 0, "a broken input allows");
});

const policyFile = (dir: string, ...modes: ("interactive" | "autonomous")[]) => {
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  const grantedBy = { answer: "run it on your own", at: NOW.toISOString() };
  writeFileSync(
    path.join(dir, "pipeline/policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectId: path.basename(dir),
      revisions: modes.map((autonomy, index) => ({ revision: index + 1, at: NOW.toISOString(), autonomy, grantedBy })),
    }),
  );
};

test("effective mode: the variable wins; an autonomous policy or a benchmark run enforces; interactive warns", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "step-lease-mode-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/film");
  mkdirSync(dir, { recursive: true });
  assert.deepEqual(effectiveGuardMode(dir, {}), { mode: "warn", source: "default" }, "interactive: warn");
  assert.deepEqual(effectiveGuardMode(dir, { AGENTBROS_STEP_GUARD: "bogus" }), { mode: "warn", source: "default" });
  assert.deepEqual(effectiveGuardMode(dir, { AGENTBROS_STEP_GUARD: "enforce" }), { mode: "enforce", source: "env" });

  policyFile(dir, "autonomous");
  assert.deepEqual(effectiveGuardMode(dir, {}), { mode: "enforce", source: "policy" });
  assert.deepEqual(effectiveGuardMode(dir, { AGENTBROS_STEP_GUARD: "warn" }), { mode: "warn", source: "env" });
  policyFile(dir, "autonomous", "interactive");
  assert.deepEqual(effectiveGuardMode(dir, {}), { mode: "warn", source: "default" }, "the revision in force decides");
  writeFileSync(path.join(dir, "pipeline/policy.json"), "{ not json");
  assert.deepEqual(effectiveGuardMode(dir, {}), { mode: "warn", source: "default" }, "a broken policy never crashes");
  rmSync(path.join(dir, "pipeline/policy.json"));

  assert.deepEqual(effectiveGuardMode(dir, { AGENTBROS_INTERACTION_MODE: "autonomous" }), {
    mode: "enforce",
    source: "benchmark",
  });
  mkdirSync(path.join(dir, "pipeline/approvals"), { recursive: true });
  writeFileSync(path.join(dir, "pipeline/approvals/broken.json"), "{");
  const approval = (proxy?: string) =>
    writeFileSync(
      path.join(dir, "pipeline/approvals/concept.json"),
      JSON.stringify({
        schemaVersion: 1,
        step: "concept",
        events: [{ answer: "yes", at: NOW.toISOString(), artefacts: {}, ...(proxy ? { proxy } : {}) }],
      }),
    );
  approval();
  assert.equal(benchmarkProxyRun(dir), false, "the user's own approval is not a benchmark");
  approval(PROXY_KINDS.policy);
  assert.equal(benchmarkProxyRun(dir), false, "a policy approval is not a benchmark");
  approval(PROXY_KINDS.benchmark);
  assert.equal(benchmarkProxyRun(dir), true);
  assert.deepEqual(effectiveGuardMode(dir, {}), { mode: "enforce", source: "benchmark" });
  assert.deepEqual(effectiveGuardMode(dir, { AGENTBROS_STEP_GUARD: "off" }), { mode: "off", source: "env" });
});

test("an autonomous policy enforces without the variable; step:violations and step:unlock still run", (t) => {
  const { root, dir } = film(t);
  const unset = { AGENTBROS_STEP_GUARD: "", AGENTBROS_INTERACTION_MODE: "" };
  writeLease(dir, lease({ step: "intake", allow: [...CONTROL_ALIASES], chainHash: chainHash(dir, "film") }));
  const warned = cli(root, "scripts/film-measure.ts", ["--project", "film"], unset);
  assert.match(warned.stderr, /Step guard \(warn\)/, "interactive: warn");

  policyFile(dir, "autonomous");
  const refused = cli(root, "scripts/film-measure.ts", ["--project", "film"], unset);
  assert.equal(refused.json.error, "VALIDATION");
  assert.match(refused.json.message, /Step guard \(enforce, the project's autonomous policy\)/);
  assert.match(
    readFileSync(path.join(dir, "pipeline/session/violations.jsonl"), "utf8"),
    /"mode":"enforce","modeSource":"policy","refused":true/,
  );

  // The report is always admitted, even on a stale lease.
  mkdirSync(path.join(dir, "pipeline/chain"), { recursive: true });
  writeFileSync(path.join(dir, "pipeline/chain/intake.json"), "{}");
  const report = cli(root, "scripts/step-violations.ts", ["--project", "film"], unset);
  assert.equal(report.json.ok, true, JSON.stringify(report.json));
  assert.deepEqual(report.json.metadata.guard, { mode: "enforce", source: "policy" });
  assert.equal(report.json.metadata.clean, false);
  assert.equal(report.json.metadata.outOfStep, 2);
  assert.equal(report.json.metadata.refused, 1);
  rmSync(path.join(dir, "pipeline/chain/intake.json"));

  // The emergency exit: step:unlock admits out-of-step runs in enforce mode; spend still needs the user's approval.
  const unlock = cli(root, "scripts/step-unlock.ts", ["--project", "film", "--reason", "repair by hand"], unset);
  assert.equal(unlock.status, 0, JSON.stringify(unlock.json));
  const run = cli(root, "scripts/film-measure.ts", ["--project", "film"], unset);
  assert.doesNotMatch(run.json.message ?? "", /Step guard/);
  const paid = cli(root, "scripts/generate-model.ts", ["--project", "film"], unset);
  assert.match(paid.json.message ?? "", /Step guard \(enforce, the project's autonomous policy\).*may spend/);
  const after = cli(root, "scripts/step-violations.ts", ["--project", "film"], unset);
  assert.equal(after.json.metadata.unlocked, 1);
  assert.equal(after.json.metadata.outOfStep, 3, "the refused spend counts; the unlocked run does not");

  // The user's own controls stay open under enforce, even on an expired lease: show and narrow the policy.
  const loaded = readLease(dir);
  assert.ok(loaded && "lease" in loaded);
  writeLease(dir, { ...loaded.lease, expiresAt: new Date(Date.now() - 1000).toISOString() });
  writeFileSync(path.join(dir, "pipeline/session/unlocks.jsonl"), "");
  const shown = cli(root, "scripts/film-policy.ts", ["--project", "film"], unset);
  assert.doesNotMatch(shown.json.message ?? "", /Step guard/, JSON.stringify(shown.json));
  const revert = cli(root, "scripts/film-revert.ts", ["--project", "film"], unset);
  assert.doesNotMatch(revert.json.message ?? "", /Step guard/);
  const narrowed = cli(root, "scripts/film-policy.ts", ["--project", "film", "--autonomy", "interactive"], unset);
  assert.equal(narrowed.json.ok, true, JSON.stringify(narrowed.json));
  assert.deepEqual(effectiveGuardMode(dir, {}), { mode: "warn", source: "default" }, "back to interactive: warn");
});

test("MCP: an autonomous policy enforces without the variable", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "step-lease-mcp-policy-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/film");
  mkdirSync(dir, { recursive: true });
  writeLease(dir, lease({ chainHash: chainHash(dir, "film") }));
  const saved = { guard: process.env.AGENTBROS_STEP_GUARD, mode: process.env.AGENTBROS_INTERACTION_MODE };
  t.after(() => {
    if (saved.guard === undefined) delete process.env.AGENTBROS_STEP_GUARD;
    else process.env.AGENTBROS_STEP_GUARD = saved.guard;
    if (saved.mode === undefined) delete process.env.AGENTBROS_INTERACTION_MODE;
    else process.env.AGENTBROS_INTERACTION_MODE = saved.mode;
  });
  delete process.env.AGENTBROS_STEP_GUARD;
  delete process.env.AGENTBROS_INTERACTION_MODE;
  const options = { root, codeRoot: REPO, allowPaid: true };
  const measure = COMMANDS.find((command) => command.name === "film_measure")!;
  const report = COMMANDS.find((command) => command.name === "step_violations")!;
  assert.ok(report.readOnly, "the report is a read-only tool");
  assert.doesNotThrow(
    () => prepareCommand(measure, { project: "film" }, options),
    "interactive leaves it to the child",
  );
  policyFile(dir, "autonomous");
  assert.throws(() => prepareCommand(measure, { project: "film" }, options), /Step guard \(enforce, the project's/);
  assert.doesNotThrow(() => prepareCommand(report, { project: "film" }, options));
});

test("step:violations sums violations.jsonl by step, command and code; clean ignores unlocked runs", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "step-lease-report-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/film");
  const other = path.join(root, "public/projects/other");
  mkdirSync(path.join(dir, "pipeline/session"), { recursive: true });
  mkdirSync(path.join(other, "pipeline/session"), { recursive: true });
  // Listed by step:violations because it has a (here empty) violation log, not merely a session folder.
  writeFileSync(path.join(other, "pipeline/session/violations.jsonl"), "");
  const entry = (at: string, step: string, alias: string, extra: Partial<StepViolation> = {}): StepViolation => ({
    at,
    project: "film",
    step,
    owner: "agent",
    alias,
    code: "not-in-step",
    mode: "warn",
    refused: false,
    via: "cli",
    ...extra,
  });
  const entries = [
    entry("2026-11-17T09:00:00.000Z", "script", "film:measure"),
    entry("2026-11-17T09:05:00.000Z", "script", "film:measure"),
    entry("2026-11-17T09:10:00.000Z", "material", "generate:model", { code: "paid", mode: "enforce", refused: true }),
    entry("2026-11-17T09:20:00.000Z", "material", "film:render", { unlocked: true }),
  ];
  writeFileSync(
    path.join(dir, "pipeline/session/violations.jsonl"),
    `${entries.map((value) => JSON.stringify(value)).join("\n")}\nnot json\n`,
  );

  const summary = summariseViolations(entries);
  assert.equal(summary.total, 4);
  assert.equal(summary.outOfStep, 3);
  assert.equal(summary.unlocked, 1);
  assert.equal(summary.refused, 1);
  assert.equal(summary.clean, false);
  assert.deepEqual(summary.byMode, { warn: 3, enforce: 1 });
  assert.deepEqual(
    summary.byStep.find((row) => row.step === "script"),
    { step: "script", count: 2, outOfStep: 2, refused: 0 },
  );
  assert.deepEqual(summary.byCommand[0], { alias: "film:measure", count: 2, outOfStep: 2, refused: 0 });
  assert.deepEqual(
    summary.byCode.map((row) => row.code),
    ["not-in-step", "paid"],
  );
  assert.equal(summary.rows.length, 3);
  assert.equal(summariseViolations(entries, "2026-11-17T09:15:00Z").clean, true, "only an unlocked run after --since");
  assert.equal(summariseViolations([]).clean, true);

  const one = cli(root, "scripts/step-violations.ts", ["--project", "film"], { AGENTBROS_STEP_GUARD: "" });
  assert.equal(one.json.ok, true, JSON.stringify(one.json));
  assert.equal(one.json.metadata.total, 4, "unparsable lines are skipped");
  assert.equal(one.json.metadata.clean, false);
  assert.deepEqual(one.json.metadata.guard, { mode: "warn", source: "default" });
  assert.deepEqual(one.json.outputs, ["public/projects/film/pipeline/session/violations.jsonl"]);
  const all = cli(root, "scripts/step-violations.ts", [], { AGENTBROS_STEP_GUARD: "" });
  assert.deepEqual(
    all.json.metadata.projects.map((project: { projectId: string; clean: boolean }) => [
      project.projectId,
      project.clean,
    ]),
    [
      ["film", false],
      ["other", true],
    ],
  );
  assert.equal(all.json.metadata.clean, false);
  assert.equal(cli(root, "scripts/step-violations.ts", ["--since", "yesterday"]).json.error, "INVALID_INPUT");
  assert.equal(cli(root, "scripts/step-violations.ts", ["--project", "missing"]).json.error, "PROJECT_NOT_FOUND");
});
