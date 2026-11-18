import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMANDS, SCOPE_ROOT_EXEMPT } from "../src/mcp/catalog";
import { prepareCommand } from "../src/mcp/bridge";

const repo = path.resolve(import.meta.dirname, "..");
/** Path fields that name a file whose contents may carry further paths. */
const REQUEST_FIELD = /^(request|plan|manifest|patch|spec|command-file)$/;
const DECLARES = /name\s*:\s*['"]scope-root['"]/;

/** The script and the local modules it imports directly (viz and campaign tools share a CLI module). */
function declaresScopeRoot(script: string): boolean {
  const file = path.join(repo, "scripts", script);
  const text = readFileSync(file, "utf8");
  if (DECLARES.test(text)) return true;
  for (const match of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), match[1]!);
    const module = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
      (candidate) => existsSync(candidate) && candidate.endsWith(".ts"),
    );
    if (module && DECLARES.test(readFileSync(module, "utf8"))) return true;
  }
  return false;
}

test("every scopeRoot tool runs a script that declares --scope-root, and every MCP script that declares it is flagged", () => {
  for (const command of COMMANDS) {
    const declared = declaresScopeRoot(command.script);
    if (command.scopeRoot)
      assert.ok(
        declared,
        `${command.name} is flagged scopeRoot but scripts/${command.script} does not declare scope-root`,
      );
    else
      assert.ok(
        !declared,
        `scripts/${command.script} declares scope-root but MCP tool ${command.name} is not flagged scopeRoot`,
      );
  }
});

test("every tool taking a request, plan, manifest, patch, spec or command file is scoped or has a documented exemption", () => {
  const byName = new Map(COMMANDS.map((command) => [command.name, command]));
  for (const command of COMMANDS) {
    const fileFields = command.paths.filter((field) => REQUEST_FIELD.test(field));
    if (!fileFields.length || command.scopeRoot) continue;
    assert.ok(
      SCOPE_ROOT_EXEMPT[command.name],
      `${command.name} takes ${fileFields.join(", ")} but neither has scopeRoot nor an exemption in SCOPE_ROOT_EXEMPT`,
    );
  }
  for (const [name, reason] of Object.entries(SCOPE_ROOT_EXEMPT)) {
    const command = byName.get(name);
    assert.ok(command, `exemption names unknown tool ${name}`);
    assert.ok(!command.scopeRoot, `${name} is both flagged and exempt`);
    assert.ok(
      command.paths.some((field) => REQUEST_FIELD.test(field)),
      `${name} takes no request-like file; drop its exemption`,
    );
    assert.ok(reason.trim().length >= 20, `${name} exemption needs a reason`);
  }
});

test("no tool lets the caller supply scope-root", () => {
  for (const command of COMMANDS) assert.equal(Object.hasOwn(command.schema.shape, "scope-root"), false, command.name);
});

test("the bridge passes the launcher boundary only to flagged tools", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-scope-root-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { root, codeRoot: repo, allowPaid: false };
  const mix = COMMANDS.find((command) => command.name === "audio_mix")!;
  const planned = prepareCommand(mix, { plan: "plan.json", output: "out.wav" }, options);
  assert.ok(planned.argv.includes(`--scope-root=${root}`));
  assert.ok(planned.argv.includes(`--plan=${path.join(root, "plan.json")}`));
  const edit = COMMANDS.find((command) => command.name === "timeline_edit")!;
  assert.ok(
    !prepareCommand(edit, { project: "demo", command: "{}" }, options).argv.some((arg) =>
      arg.startsWith("--scope-root"),
    ),
  );
  assert.throws(() => prepareCommand(mix, { plan: "plan.json", output: "out.wav", "scope-root": "/" }, options));
});
