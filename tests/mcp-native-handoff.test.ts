import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { COMMANDS } from "../src/mcp/catalog";
import { prepareCommand } from "../src/mcp/bridge";

const definition = COMMANDS.find((command) => command.name === "delivery")!;
function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "handoff-mcp-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = { root, codeRoot: path.resolve(import.meta.dirname, ".."), allowPaid: false };
  const scoped = { ...workspace, projectScope: "demo" };
  return { root, workspace, scoped };
}
test("native handoff scopes literal request/snapshot argv and exact recovery with paid tools disabled", (t) => {
  const f = fixture(t),
    recover = "a".repeat(64);
  const result = prepareCommand(
    definition,
    { action: "handoff", project: "demo", request: "request.json", snapshot: "snapshot.json", recover },
    f.scoped,
  );
  assert.deepEqual(result.argv, [
    "--action=handoff",
    "--request=" + path.join(f.root, "request.json"),
    "--snapshot=" + path.join(f.root, "snapshot.json"),
    "--project=demo",
    "--recover=" + recover,
  ]);
  assert.equal(result.enforcedDryRun, false);
  assert.equal(definition.paid, "local");
  assert.equal(definition.readOnly, false);
});
test("handoff requires explicit matching scoped project and snapshot before launching", (t) => {
  const f = fixture(t),
    input = { action: "handoff", request: "request.json", snapshot: "snapshot.json" };
  assert.throws(() => prepareCommand(definition, input, f.scoped), /scoped project/);
  assert.throws(() => prepareCommand(definition, { ...input, project: "another" }, f.scoped), /project scope/);
  assert.throws(
    () => prepareCommand(definition, { action: "handoff", request: "request.json", project: "demo" }, f.scoped),
    /source snapshot/,
  );
  assert.doesNotThrow(() => prepareCommand(definition, input, f.workspace));
});
test("legacy snapshot/check stay workspace-only even if a caller supplies matching project", (t) => {
  const f = fixture(t);
  for (const action of ["snapshot", "check"]) {
    const input = { action, request: "request.json", snapshot: "snapshot.json" };
    assert.throws(() => prepareCommand(definition, input, f.scoped), /workspace scope/);
    assert.throws(() => prepareCommand(definition, { ...input, project: "demo" }, f.scoped), /workspace scope/);
    assert.throws(() => prepareCommand(definition, { ...input, project: "demo" }, f.workspace), /project\/recover/);
    assert.throws(
      () => prepareCommand(definition, { ...input, recover: "a".repeat(64) }, f.workspace),
      /project\/recover/,
    );
    assert.deepEqual(prepareCommand(definition, input, f.workspace).argv, [
      "--action=" + action,
      "--request=" + path.join(f.root, "request.json"),
      "--snapshot=" + path.join(f.root, "snapshot.json"),
    ]);
  }
});
test("handoff refuses escaping paths, malformed recovery and caller worker/gate authority", (t) => {
  const f = fixture(t),
    input = { action: "handoff", project: "demo", request: "request.json", snapshot: "snapshot.json" };
  for (const field of ["request", "snapshot"])
    assert.throws(
      () => prepareCommand(definition, { ...input, [field]: "../outside.json" }, f.scoped),
      /outside|escapes/,
    );
  for (const recover of ["A".repeat(64), "a".repeat(63), "../marker"])
    assert.throws(() => prepareCommand(definition, { ...input, recover }, f.scoped));
  for (const extra of [{ worker: "/bin/sh" }, { policy: "allow network" }, { check: true }, { "scope-root": "/" }])
    assert.throws(() => prepareCommand(definition, { ...input, ...extra }, f.scoped));
});
