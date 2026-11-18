import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HookCursorSchema } from "../src/types/console";
import { hookEnv, PROJECT, runHook, workspace } from "./helpers/console-hooks";

const session = "dashboard-session";
const origin = "http://127.0.0.1:4317";
const otherProject = "another-film";
const link = (project = PROJECT, suffix = "a") => `${origin}/#pair=${suffix.repeat(32)}&project=${project}`;
const result = (project: string, url?: string, error?: string) => ({
  ok: true,
  metadata: { projectId: project, console: { url, error } },
});

for (const harness of ["codex", "claude"] as const) {
  test(`${harness}: one handoff per project, then check again on resume`, async (t) => {
    const ws = workspace();
    t.after(ws.cleanup);
    mkdirSync(path.join(ws.root, "public/projects", otherProject));
    const options = { env: hookEnv({ AGENTBROS_CONSOLE: "on" }) };
    const post = (toolResponse: unknown, name: string, input: object) =>
      runHook(
        harness,
        "present",
        {
          cwd: ws.root,
          session_id: session,
          hook_event_name: "PostToolUse",
          tool_name: name,
          tool_input: input,
          tool_response: toolResponse,
        },
        options,
      );
    const shell = (project: string, code = "a") => {
      const json = JSON.stringify(result(project, link(project, code)));
      return post(harness === "claude" ? { stdout: json, stderr: "progress" } : `Final output:\n${json}`, "Bash", {
        command:
          harness === "codex" ? ["zsh", "-lc", `pnpm next --project ${project}`] : `pnpm next --project ${project}`,
      });
    };
    const first = JSON.stringify(await shell(PROJECT));
    assert.match(first, /Reuse the dashboard tab/);
    assert.match(first, /navigate that same tab/);
    assert.match(first, harness === "codex" ? /open_in_codex/ : /Claude Code Desktop/);
    assert.ok(first.includes(link()));
    assert.deepEqual(await shell(PROJECT, "b"), {}, "a fresh pairing code does not open a second tab");

    const structured = result(otherProject, link(otherProject, "c"), "A newer server needs a restart");
    const mcp = await post(
      harness === "claude" ? [{ type: "text", text: JSON.stringify(structured) }] : { structuredContent: structured },
      "mcp__agentbros__avc_next",
      { project: otherProject },
    );
    assert.match(JSON.stringify(mcp), /console.error/);
    assert.ok(JSON.stringify(mcp).includes(link(otherProject, "c")));
    const saved = readFileSync(path.join(ws.root, "out/console/hooks", `${session}.json`), "utf8");
    assert.equal(HookCursorSchema.parse(JSON.parse(saved)).project, otherProject);
    assert.ok(!saved.includes("pair="), "pairing links are not stored in the cursor");

    const resume = await runHook(
      harness,
      "orient",
      {
        cwd: ws.root,
        session_id: session,
        hook_event_name: "SessionStart",
        source: "resume",
      },
      options,
    );
    assert.match(JSON.stringify(resume), /pnpm next --project another-film/);
    assert.ok(JSON.stringify(await shell(otherProject, "d")).includes(link(otherProject, "d")));
  });
}

test("the handoff is scoped to project commands and safe URLs and leaves an unavailable dashboard non-blocking", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  const base = { cwd: ws.root, session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash" };
  const run = (command: string, response: unknown, overrides = {}) =>
    runHook(
      "codex",
      "present",
      {
        ...base,
        tool_input: { command },
        tool_response: response,
        ...overrides,
      },
      { env: hookEnv({ AGENTBROS_CONSOLE: "on" }) },
    );
  const command = `pnpm film:init --project ${PROJECT}`;
  const good = result(PROJECT, link());
  assert.deepEqual(await run(`echo ${PROJECT}`, good), {});
  assert.deepEqual(await run(`pnpm next --project other-project`, good), {});
  assert.deepEqual(await run(`AGENTBROS_CONSOLE=off ${command}`, good), {});
  assert.deepEqual(await run(command, good, { agent_id: "child-agent" }), {});
  assert.deepEqual(await run(command, { ...good, ok: false }), {});
  for (const unsafe of [
    link().replace("127.0.0.1", "example.org"),
    link(otherProject),
    `${origin}/#token=${"a".repeat(64)}`,
  ]) {
    const output = JSON.stringify(await run(command, result(PROJECT, unsafe)));
    assert.ok(!output.includes(unsafe));
    assert.ok(!output.includes("#token="));
  }
  const valid = await run(
    "",
    { content: [{ type: "text", text: JSON.stringify(good, null, 2) }] },
    {
      tool_name: "mcp__agentbros__avc_call",
      tool_input: { tool: "film_init", arguments: { project: PROJECT } },
    },
  );
  assert.ok(JSON.stringify(valid).includes(link()));
  const error = await run(command, result(PROJECT, undefined, "Network error"));
  assert.match(JSON.stringify(error), /unavailable.*continue the project/);
});

test("a workspace starts with the explicit project and handles positional project creation", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const start = { cwd: ws.root, session_id: session, hook_event_name: "SessionStart", source: "startup" };
  const env = hookEnv({ AGENTBROS_CONSOLE: "on" });
  const unbound = await runHook("claude", "orient", start, { env });
  assert.doesNotMatch(JSON.stringify(unbound), /Check the dashboard with/);
  const known = await runHook("claude", "orient", start, { env: { ...env, AGENTBROS_PROJECT: PROJECT } });
  assert.match(JSON.stringify(known), /Check the dashboard with pnpm next --project demo-film/);
  const post = await runHook(
    "claude",
    "present",
    {
      ...start,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: `pnpm project:new ${PROJECT}` },
      tool_response: { stdout: JSON.stringify(result(PROJECT, link())) },
    },
    { env },
  );
  assert.ok(JSON.stringify(post).includes(link()));
});
