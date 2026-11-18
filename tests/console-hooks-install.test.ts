/**
 * `pnpm harness:setup --hooks` (RFC 0004 §7.1 H2, H3, H5): plan, surgical merge into files holding other tools'
 * hooks, backup, idempotence, stale detection, remove-only-ours, relative commands, per-entry bounds and status.
 * Only temporary directories are written; never this checkout or a home directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyHookPlans,
  CODEX_AGENT_MATCHER,
  CONSOLE_PRESENT_MATCHER,
  HOOK_FILES,
  hookEntries,
  hooksStatus,
  planHooks,
  type HookEntries,
  type HookHarness,
} from "../src/lib/harness/hooks";
import { HooksStatusSchema } from "../src/types/console";
import { REPO } from "./helpers/console-hooks";

const OTHER_CLAUDE = {
  permissions: { allow: ["Bash(pnpm test:*)"] },
  env: { FOO: "1" },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "/opt/orchestrator/hook pre", timeout: 10 }] },
      { matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier-hook" }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "code-index prompt" }] }],
    Stop: [{ hooks: [{ type: "command", command: "/opt/orchestrator/hook stop", async: true }] }],
  },
};
const OTHER_CODEX = {
  description: "team hooks",
  hooks: {
    SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "python3 start.py" }] }],
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "python3 pre.py", statusMessage: "checking" }] },
    ],
  },
};

function checkout(withOthers = true) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "console-hooks-install-")));
  if (withOthers) {
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    mkdirSync(path.join(root, ".codex"), { recursive: true });
    writeFileSync(path.join(root, HOOK_FILES.claude), `${JSON.stringify(OTHER_CLAUDE, null, 2)}\n`);
    writeFileSync(path.join(root, HOOK_FILES.codex), `${JSON.stringify(OTHER_CODEX, null, 2)}\n`);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const read = (root: string, harness: HookHarness) =>
  JSON.parse(readFileSync(path.join(root, HOOK_FILES[harness]), "utf8")) as Record<string, unknown>;
const handlers = (entries: HookEntries) =>
  Object.entries(entries).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher, ...hook }))),
  );
const install = (root: string) =>
  applyHookPlans(
    root,
    (["claude", "codex"] as const).map((harness) => planHooks(root, harness)),
  );

test("entries: relative commands, bounded handlers and matchers scoped to each role", () => {
  for (const harness of ["claude", "codex"] as const) {
    const all = handlers(hookEntries(harness));
    for (const hook of all) {
      assert.ok(hook.command.startsWith("node "), hook.command);
      assert.ok(hook.command.includes(`scripts/hooks/agentbros-hook.mjs ${harness} `), hook.command);
      assert.ok(!/\/Users\/|\/home\/|^node \//.test(hook.command), `no machine path: ${hook.command}`);
      if (harness === "claude") assert.ok(hook.command.startsWith('node "$CLAUDE_PROJECT_DIR"/scripts/'));
      else assert.ok(hook.command.startsWith("node scripts/"));
      const role = hook.command.split(" ").at(-1);
      if (role === "guard") assert.equal(hook.timeout, 5);
      else if (role === "orient" || role === "relay" || role === "present") assert.equal(hook.timeout, 3);
      else if (hook.event === "SessionEnd") assert.equal(hook.timeout, 1);
      else assert.equal(hook.async, true, `${hook.event} ${role} is async`);
      if (role === "wake") {
        assert.equal(harness, "claude");
        assert.equal(hook.asyncRewake, true);
        assert.equal(hook.event, "Stop");
      }
      if (role === "guard")
        assert.equal(
          hook.matcher,
          harness === "claude" ? "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep" : "Bash|apply_patch",
        );
      else if (role === "present") {
        assert.equal(hook.event, "PostToolUse");
        assert.equal(hook.matcher, CONSOLE_PRESENT_MATCHER);
        const matcher = new RegExp(hook.matcher!);
        for (const tool of ["Bash", "mcp__agentbros__avc_next", "mcp__agentbros__avc_film_init"])
          assert.ok(matcher.test(tool));
        assert.ok(!matcher.test("mcp__agentbros__avc_generate_video"));
      } else if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(hook.event))
        assert.ok(
          hook.matcher &&
            (/^(Bash|Agent|Bash\|Agent)$/.test(hook.matcher) ||
              (harness === "codex" && hook.matcher === CODEX_AGENT_MATCHER)),
          `${hook.event} ${hook.matcher}`,
        );
    }
    assert.equal(all.filter((hook) => hook.command.endsWith(" guard")).length, 1);
    assert.equal(all.filter((hook) => hook.command.endsWith(" guard"))[0]!.event, "PreToolUse");
  }
  assert.ok(!handlers(hookEntries("codex")).some((hook) => hook.asyncRewake), "Codex cannot rewake");
});

test("plan prints the entries and writes nothing; apply merges beside other tools' hooks with a backup", (t) => {
  const { root, cleanup } = checkout();
  t.after(cleanup);
  const before = {
    claude: readFileSync(path.join(root, HOOK_FILES.claude), "utf8"),
    codex: readFileSync(path.join(root, HOOK_FILES.codex), "utf8"),
  };
  assert.deepEqual(hooksStatus(root), { claude: "missing", codex: "missing" });
  const plan = planHooks(root, "claude");
  assert.equal(plan.action, "write");
  assert.deepEqual(plan.entries, hookEntries("claude"));
  assert.equal(readFileSync(path.join(root, HOOK_FILES.claude), "utf8"), before.claude, "a plan writes nothing");

  const applied = install(root);
  assert.deepEqual(applied.written.sort(), [HOOK_FILES.claude, HOOK_FILES.codex].sort());
  assert.deepEqual(
    applied.backups.sort(),
    [`${HOOK_FILES.claude}.agentbros-backup`, `${HOOK_FILES.codex}.agentbros-backup`].sort(),
  );
  assert.equal(readFileSync(path.join(root, `${HOOK_FILES.claude}.agentbros-backup`), "utf8"), before.claude);
  assert.ok(HooksStatusSchema.safeParse(hooksStatus(root)).success);
  assert.deepEqual(hooksStatus(root), { claude: "installed", codex: "installed" });

  const claude = read(root, "claude");
  assert.deepEqual(claude.permissions, OTHER_CLAUDE.permissions);
  assert.deepEqual(claude.env, OTHER_CLAUDE.env);
  const hooks = claude.hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.PreToolUse!.slice(0, 2), OTHER_CLAUDE.hooks.PreToolUse, "other groups kept first, unchanged");
  assert.deepEqual(hooks.UserPromptSubmit![0], OTHER_CLAUDE.hooks.UserPromptSubmit[0]);
  assert.deepEqual(hooks.Stop![0], OTHER_CLAUDE.hooks.Stop[0]);
  const codex = read(root, "codex");
  assert.equal(codex.description, "team hooks");
  assert.deepEqual((codex.hooks as Record<string, unknown[]>).PreToolUse![0], OTHER_CODEX.hooks.PreToolUse[0]);
  const text =
    readFileSync(path.join(root, HOOK_FILES.claude), "utf8") + readFileSync(path.join(root, HOOK_FILES.codex), "utf8");
  assert.ok(!text.includes(root), "no checkout path is written");

  // Idempotent: nothing to change, no new write or backup.
  const again = install(root);
  assert.deepEqual(again, { written: [], backups: [] });
  assert.ok((["claude", "codex"] as const).every((harness) => planHooks(root, harness).action === "none"));
});

test("stale entries and the deprecated step-guard hook are replaced; remove takes out only ours", (t) => {
  const { root, cleanup } = checkout();
  t.after(cleanup);
  // The documented legacy entry from docs/step-lease.md.
  const legacy = structuredClone(OTHER_CLAUDE) as typeof OTHER_CLAUDE & { hooks: Record<string, unknown[]> };
  legacy.hooks.PreToolUse.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: "node scripts/hooks/claude-step-guard.mjs" }],
  });
  writeFileSync(path.join(root, HOOK_FILES.claude), JSON.stringify(legacy));
  assert.equal(hooksStatus(root).claude, "stale");
  const plan = planHooks(root, "claude");
  assert.deepEqual(plan.removes, ["node scripts/hooks/claude-step-guard.mjs"]);
  install(root);
  assert.equal(hooksStatus(root).claude, "installed");
  assert.ok(!readFileSync(path.join(root, HOOK_FILES.claude), "utf8").includes("claude-step-guard"));

  // An entry of ours that changed (an older release, a hand edit) is stale until applied again.
  const edited = read(root, "codex") as { hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]> };
  const guard = edited.hooks
    .PreToolUse!.flatMap((group) => group.hooks)
    .find((hook) => hook.command.endsWith(" guard"))!;
  guard.timeout = 30;
  writeFileSync(path.join(root, HOOK_FILES.codex), JSON.stringify(edited));
  assert.equal(hooksStatus(root).codex, "stale");
  install(root);
  assert.equal(hooksStatus(root).codex, "installed");

  // Remove: only ours go; the other tools' hooks and keys are back as they were.
  const removed = applyHookPlans(
    root,
    (["claude", "codex"] as const).map((harness) => planHooks(root, harness, "remove")),
  );
  assert.equal(removed.written.length, 2);
  assert.deepEqual(hooksStatus(root), { claude: "missing", codex: "missing" });
  assert.deepEqual(read(root, "claude"), OTHER_CLAUDE);
  assert.deepEqual(read(root, "codex"), OTHER_CODEX);
  assert.deepEqual(
    applyHookPlans(
      root,
      (["claude", "codex"] as const).map((harness) => planHooks(root, harness, "remove")),
    ),
    { written: [], backups: [] },
    "removing twice changes nothing",
  );
});

test("fresh checkout: files are created; a file that is not plain JSON is a conflict and stays untouched", (t) => {
  const { root, cleanup } = checkout(false);
  t.after(cleanup);
  const applied = install(root);
  assert.deepEqual(applied.backups, [], "nothing to back up");
  assert.deepEqual(hooksStatus(root), { claude: "installed", codex: "installed" });
  assert.deepEqual(Object.keys(read(root, "claude")), ["hooks"]);
  applyHookPlans(
    root,
    (["claude", "codex"] as const).map((harness) => planHooks(root, harness, "remove")),
  );
  assert.deepEqual(read(root, "claude"), {}, "our keys only: removal leaves an empty object");

  const commented = '{\n  // my settings\n  "hooks": {}\n}\n';
  writeFileSync(path.join(root, HOOK_FILES.claude), commented);
  const plan = planHooks(root, "claude");
  assert.equal(plan.action, "conflict");
  assert.match(plan.conflict!, /not plain JSON/);
  applyHookPlans(root, [plan]);
  assert.equal(readFileSync(path.join(root, HOOK_FILES.claude), "utf8"), commented);
});

test("both hook files are git-ignored in this repository", () => {
  for (const file of Object.values(HOOK_FILES)) {
    const result = spawnSync("git", ["check-ignore", "-q", file], { cwd: REPO });
    assert.equal(result.status, 0, `${file} is ignored`);
  }
});

test("harness:setup --hooks plans, --apply installs and --remove removes in the given checkout (CLI)", (t) => {
  const { root, cleanup } = checkout();
  t.after(cleanup);
  const run = (...flags: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(REPO, "node_modules/tsx/dist/cli.mjs"),
        path.join(REPO, "scripts/harness-setup.ts"),
        "--hooks",
        ...flags,
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, AGENTBROS_STEP_GUARD: "off" } },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { ok: boolean; metadata: Record<string, unknown> };
  };
  const plan = run();
  assert.equal(plan.metadata.mode, "hooks-plan");
  assert.equal((plan.metadata.hooks as unknown[]).length, 2);
  assert.deepEqual(plan.metadata.status, { claude: "missing", codex: "missing" });
  const applied = run("--apply", "--harness", "codex");
  assert.equal(applied.metadata.mode, "hooks-apply");
  assert.deepEqual(applied.metadata.status, { claude: "missing", codex: "installed" });
  assert.equal((applied.metadata.trust as string[]).length, 1);
  assert.match((applied.metadata.trust as string[])[0]!, /\/hooks/);
  const removed = run("--remove");
  assert.deepEqual(removed.metadata.status, { claude: "missing", codex: "missing" });
  assert.ok(existsSync(path.join(root, `${HOOK_FILES.codex}.agentbros-backup`)));
});

test("review 6: backups are git-ignored and the first (original) backup is never overwritten", (t) => {
  for (const file of Object.values(HOOK_FILES))
    assert.equal(spawnSync("git", ["check-ignore", "-q", `${file}.agentbros-backup`], { cwd: REPO }).status, 0, file);
  const { root, cleanup } = checkout();
  t.after(cleanup);
  const original = readFileSync(path.join(root, HOOK_FILES.claude), "utf8");
  install(root);
  // The user edits the file, our entries go stale, and a second apply changes it again.
  const edited = read(root, "claude") as {
    hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
  };
  edited.hooks.PreToolUse!.flatMap((group) => group.hooks).find((hook) => hook.command.endsWith(" guard"))!.timeout = 9;
  writeFileSync(path.join(root, HOOK_FILES.claude), JSON.stringify(edited));
  const again = install(root);
  assert.deepEqual(again.written, [HOOK_FILES.claude]);
  assert.deepEqual(again.backups, [], "no new backup");
  assert.equal(readFileSync(path.join(root, `${HOOK_FILES.claude}.agentbros-backup`), "utf8"), original);
});

for (const harness of ["claude", "codex"] as const)
  test(`${harness}: an install from before the guard covered the file tools (matcher Bash) is stale`, (t) => {
    const { root, cleanup } = checkout();
    t.after(cleanup);
    const entries = hookEntries(harness);
    const old = structuredClone(entries);
    for (const group of old.PreToolUse ?? [])
      if (group.hooks.some((hook) => hook.command.endsWith(" guard"))) group.matcher = "Bash";
    writeFileSync(path.join(root, HOOK_FILES[harness]), JSON.stringify({ hooks: old }));
    assert.equal(hooksStatus(root)[harness], "stale");
    writeFileSync(path.join(root, HOOK_FILES[harness]), JSON.stringify({ hooks: entries }));
    assert.equal(hooksStatus(root)[harness], "installed");
  });
