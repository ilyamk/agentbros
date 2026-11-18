import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { harnessHealth } from "../src/lib/harness/health";
import { HARNESSES } from "../src/lib/harness/registry";
import { buildPlan } from "../src/lib/setup/plan";
import { agentSources, applyHarnesses, manualSnippet, planHarnesses, renderAgent } from "../src/lib/harness/setup";

const repo = path.resolve(import.meta.dirname, "..");
const NODE = "/opt/node/bin/node";

function workspace() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "harness-setup-")));
  const root = path.join(base, "repo"),
    home = path.join(base, "home");
  mkdirSync(path.join(root, ".agents", "skills", "demo"), { recursive: true });
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  mkdirSync(home);
  writeFileSync(
    path.join(root, ".agents", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo\n---\nBody\n",
  );
  writeFileSync(
    path.join(root, ".agents", "agents", "critic.md"),
    '---\nname: critic\ndescription: Judges "films": fresh\nmodel: opus\ntools: Read, Bash\n---\n\nYou judge.\n',
  );
  writeFileSync(path.join(root, ".agents", "agents", "README.md"), "# Index\n");
  writeFileSync(path.join(root, ".mcp.json"), readFileSync(path.join(repo, ".mcp.json")));
  const options = { codeRoot: root, home, nodePath: NODE, which: () => false, appExists: () => false, all: true };
  return { base, root, home, options, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const states = (statuses: ReturnType<typeof planHarnesses>) =>
  statuses.flatMap((status) => status.actions.map((action) => `${action.harness}:${action.path}:${action.state}`));

test("registry: unique ids, https docs, a dated check, and every generated project path is git-ignored", () => {
  assert.equal(new Set(HARNESSES.map((spec) => spec.id)).size, HARNESSES.length);
  assert.ok(HARNESSES.length >= 10);
  for (const spec of HARNESSES) {
    assert.ok(spec.docs.length > 0 && spec.docs.every((url) => url.startsWith("https://")), spec.id);
    assert.match(spec.checked, /^\d{4}-\d{2}-\d{2}$/);
    const generated = [
      ...spec.mcp.filter((target) => target.scope === "project" && !target.committed).map((target) => target.file),
      ...(spec.agents ? [`${spec.agents.dir}/x.md`] : []),
      ...spec.links.filter((link) => !link.path.startsWith(".claude/")).map((link) => link.path),
    ];
    for (const file of generated) {
      const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: repo }).status === 0;
      assert.ok(ignored, `${spec.id}: ${file} must be git-ignored (it holds machine paths)`);
    }
  }
});

test("the tracked .mcp.json launches agentbros relative to the repository root", () => {
  const config = JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const server = config.mcpServers.agentbros!;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args.slice(0, 2), ["node_modules/tsx/dist/cli.mjs", "src/mcp/stdio.ts"]);
  assert.ok(server.args.every((arg) => !path.isAbsolute(arg)));
});

test("apply wires every project-scoped harness, keeps other keys and is idempotent", () => {
  const { root, home, options, cleanup } = workspace();
  try {
    mkdirSync(path.join(root, ".cursor"));
    writeFileSync(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }),
    );
    mkdirSync(path.join(root, ".codex"));
    writeFileSync(path.join(root, ".codex", "config.toml"), 'model = "gpt"\n');
    const before = planHarnesses(options);
    assert.ok(states(before).includes(`cursor:.cursor/mcp.json:todo`));
    const { written } = applyHarnesses(before, options);
    assert.ok(written.length > 0);

    const cursor = JSON.parse(readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8"));
    assert.deepEqual(cursor.mcpServers.other, { command: "x" });
    assert.equal(cursor.extra, 1);
    assert.equal(cursor.mcpServers.agentbros.command, NODE);
    assert.deepEqual(cursor.mcpServers.agentbros.args.slice(-4), ["--root", root, "--toolsets", "core"]);

    const toml = readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    assert.match(toml, /^model = "gpt"/);
    assert.match(toml, /\[mcp_servers\.agentbros\]\ncommand = "\/opt\/node\/bin\/node"/);

    const vscode = JSON.parse(readFileSync(path.join(root, ".vscode", "mcp.json"), "utf8"));
    assert.equal(vscode.servers.agentbros.type, "stdio");
    const opencode = JSON.parse(readFileSync(path.join(root, ".opencode", "opencode.json"), "utf8"));
    assert.deepEqual(opencode.mcp.servers.agentbros.command.slice(0, 1), [NODE]);
    const amp = JSON.parse(readFileSync(path.join(root, ".amp", "settings.json"), "utf8"));
    assert.ok(amp["amp.mcpServers"].agentbros);
    const gemini = JSON.parse(readFileSync(path.join(root, ".gemini", "settings.json"), "utf8"));
    assert.deepEqual(gemini.context.fileName, ["AGENTS.md"]);
    assert.ok(JSON.parse(readFileSync(path.join(root, ".kilo", "kilo.jsonc"), "utf8")).mcp.agentbros.enabled);

    assert.ok(lstatSync(path.join(root, ".github", "skills")).isSymbolicLink());
    assert.equal(realpathSync(path.join(root, ".github", "skills")), path.join(root, ".agents", "skills"));
    assert.ok(lstatSync(path.join(root, ".claude", "skills")).isSymbolicLink());

    const codexAgent = readFileSync(path.join(root, ".codex", "agents", "critic.toml"), "utf8");
    assert.match(codexAgent, /^# Generated by pnpm harness:setup from \.agents\/agents\/critic\.md/);
    assert.match(codexAgent, /description = "Judges \\"films\\": fresh"/);
    assert.ok(!existsSync(path.join(root, ".codex", "agents", "README.toml")));
    assert.match(readFileSync(path.join(root, ".github", "agents", "critic.agent.md"), "utf8"), /^---\nname: critic/);
    assert.match(readFileSync(path.join(root, ".opencode", "agents", "critic.md"), "utf8"), /mode: subagent/);

    assert.ok(!existsSync(path.join(home, ".cline")), "user configs need --global");
    const after = planHarnesses(options);
    assert.deepEqual(
      states(after).filter((state) => state.endsWith(":todo")),
      [],
      "a second plan has nothing left to do",
    );
    const again = readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    applyHarnesses(after, options);
    assert.equal(readFileSync(path.join(root, ".codex", "config.toml"), "utf8"), again);
  } finally {
    cleanup();
  }
});

test("stale generated agents are removed, hand-written ones kept", () => {
  const { root, options, cleanup } = workspace();
  try {
    const only = { ...options, all: false, only: ["opencode"] };
    applyHarnesses(planHarnesses(only), only);
    const dir = path.join(root, ".opencode", "agents");
    writeFileSync(path.join(dir, "mine.md"), "---\ndescription: mine\n---\n");
    rmSync(path.join(root, ".agents", "agents", "critic.md"));
    const plan = planHarnesses(only);
    assert.ok(states(plan).includes("opencode:.opencode/agents:todo"));
    applyHarnesses(plan, only);
    assert.ok(!existsSync(path.join(dir, "critic.md")));
    assert.ok(existsSync(path.join(dir, "mine.md")));
  } finally {
    cleanup();
  }
});

test("conflicts are reported and left untouched: comments in JSON, a foreign link, a real folder, a hand-made server", () => {
  const { root, options, cleanup } = workspace();
  try {
    mkdirSync(path.join(root, ".cursor"));
    writeFileSync(path.join(root, ".cursor", "mcp.json"), "// mine\n{}");
    mkdirSync(path.join(root, ".github", "skills"), { recursive: true });
    mkdirSync(path.join(root, ".claude"));
    symlinkSync("../elsewhere", path.join(root, ".claude", "skills"));
    mkdirSync(path.join(root, ".codex"));
    writeFileSync(path.join(root, ".codex", "config.toml"), '[mcp_servers.agentbros]\ncommand = "mine"\n');
    const plan = planHarnesses(options);
    const all = states(plan);
    for (const expected of [
      "cursor:.cursor/mcp.json:conflict",
      "copilot:.github/skills:conflict",
      "codex:.codex/config.toml:conflict",
    ])
      assert.ok(all.includes(expected), expected);
    applyHarnesses(plan, options);
    assert.equal(readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8"), "// mine\n{}");
    assert.ok(lstatSync(path.join(root, ".github", "skills")).isDirectory());
    assert.match(readFileSync(path.join(root, ".codex", "config.toml"), "utf8"), /command = "mine"/);
  } finally {
    cleanup();
  }
});

test("a link checked out as a placeholder file (no symlink support) is replaced by a link", () => {
  const { root, options, cleanup } = workspace();
  try {
    mkdirSync(path.join(root, ".claude"));
    writeFileSync(path.join(root, ".claude", "agents"), "../.agents/agents");
    const only = { ...options, all: false, only: ["claude-code"] };
    const plan = planHarnesses(only);
    assert.ok(states(plan).includes("claude-code:.claude/agents:todo"));
    applyHarnesses(plan, only);
    assert.equal(realpathSync(path.join(root, ".claude", "agents")), path.join(root, ".agents", "agents"));
  } finally {
    cleanup();
  }
});

test("user-scope configs are written only with global, with a backup", () => {
  const { home, options, cleanup } = workspace();
  try {
    const only = { ...options, all: false, only: ["cline"] };
    const file = path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "y" } } }));
    const plan = planHarnesses(only);
    assert.ok(states(plan).includes("cline:~/.cline/data/settings/cline_mcp_settings.json:manual"));
    applyHarnesses(plan, only);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.agentbros, undefined);
    const { backups } = applyHarnesses(plan, { ...only, global: true });
    const merged = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(merged.mcpServers.agentbros && merged.mcpServers.other);
    assert.equal(backups.length, 1);
    assert.ok(existsSync(`${file}.agentbros-backup`));
    assert.ok(states(planHarnesses(only)).includes("cline:~/.cline/data/settings/cline_mcp_settings.json:ok"));
  } finally {
    cleanup();
  }
});

test("detection selects found harnesses plus Claude Code and Codex; unknown ids are refused", () => {
  const { home, options, cleanup } = workspace();
  try {
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    const plan = planHarnesses({ ...options, all: false, which: (bin) => bin === "cursor" });
    const selected = plan.filter((status) => status.selected).map((status) => status.id);
    assert.deepEqual(selected.sort(), ["claude-code", "codex", "cursor", "opencode"]);
    assert.throws(() => planHarnesses({ ...options, only: ["nope"] }), /Unknown harness/);
  } finally {
    cleanup();
  }
});

test("snippets and agent rendering carry no Claude-only fields", () => {
  const agents = agentSources(repo);
  assert.ok(agents.length > 10 && agents.every((agent) => agent.description.length > 0));
  for (const format of ["codex-toml", "copilot", "opencode"] as const) {
    const { text } = renderAgent(format, agents[0]!);
    assert.doesNotMatch(text, /^model:|^tools:/m, format);
  }
  const cursor = HARNESSES.find((spec) => spec.id === "cursor")!.mcp[0]!;
  assert.match(manualSnippet(cursor, "/x", NODE), /"agentbros"/);
});

test("health: fresh wiring is clean; a gone Node, a moved checkout, stale agents and a broken link are reported", () => {
  const { root, home, options, cleanup } = workspace();
  try {
    for (const file of ["node_modules/tsx/dist/cli.mjs", "src/mcp/stdio.ts"]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "");
    }
    const live = { ...options, nodePath: process.execPath };
    applyHarnesses(planHarnesses(live), live);
    const versionOf = () => process.versions.node;
    const clean = harnessHealth({ codeRoot: root, home, versionOf });
    assert.deepEqual(clean.problems, []);
    assert.ok(clean.wired.includes("Cursor") && clean.wired.includes("OpenAI Codex (CLI, IDE, app)"));

    const cursor = path.join(root, ".cursor", "mcp.json");
    const config = JSON.parse(readFileSync(cursor, "utf8"));
    config.mcpServers.agentbros.command = "/nonexistent/node";
    writeFileSync(cursor, JSON.stringify(config));
    const toml = path.join(root, ".codex", "config.toml");
    writeFileSync(toml, readFileSync(toml, "utf8").replaceAll(root, "/old/checkout"));
    writeFileSync(
      path.join(root, ".agents", "agents", "critic.md"),
      "---\nname: critic\ndescription: Changed\n---\nNew\n",
    );
    rmSync(path.join(root, ".github", "skills"));
    symlinkSync("../nowhere", path.join(root, ".github", "skills"));

    const broken = harnessHealth({ codeRoot: root, home, versionOf });
    const found = (fragment: string, file: string) =>
      broken.problems.some((item) => item.path === file && item.problem.includes(fragment));
    assert.ok(found("no longer exists", ".cursor/mcp.json"));
    assert.ok(found("is not this checkout", ".codex/config.toml"));
    assert.ok(found("out of date", ".codex/agents"));
    assert.ok(found("does not resolve", ".github/skills"));

    const old = harnessHealth({ codeRoot: root, home, versionOf: () => "18.0.0" });
    assert.ok(old.problems.some((item) => item.problem.includes("outside the runtime policy")));
  } finally {
    cleanup();
  }
});

test("bootstrap's harness step: planned as todo, applied, then done", () => {
  const { root, home, options, cleanup } = workspace();
  try {
    const plan = (todo: boolean) =>
      buildPlan("macos", [], {
        envFile: true,
        envExample: true,
        assets: false,
        smoke: false,
        harness: { todo, detail: "x" },
      });
    const step = (todo: boolean) => plan(todo).find((item) => item.id === "harness")!;
    assert.equal(step(true).state, "todo");
    assert.equal(step(true).scope, "repo");
    assert.equal(step(false).state, "done");
    assert.equal(
      buildPlan("macos", [], { envFile: true, envExample: true, assets: false, smoke: false }).some(
        (item) => item.id === "harness",
      ),
      false,
    );
    const only = { ...options, all: false, only: ["cursor"] };
    const todo = planHarnesses(only).some((status) => status.actions.some((action) => action.state === "todo"));
    assert.ok(todo);
    applyHarnesses(planHarnesses(only), only);
    assert.ok(!planHarnesses(only).some((status) => status.actions.some((action) => action.state === "todo")));
    assert.ok(existsSync(path.join(root, ".cursor", "mcp.json")) && !existsSync(path.join(home, ".cursor")));
  } finally {
    cleanup();
  }
});
