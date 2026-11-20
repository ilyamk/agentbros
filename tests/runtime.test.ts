import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { enginesRange, runtimePolicy, runtimeStatus, runtimeWarning } from "../src/lib/runtime";

test("runtime policy distinguishes primary, reserve, compatible and unsupported versions", () => {
  const policy = runtimePolicy();
  assert.equal(runtimeStatus(policy.primary).role, "primary");
  assert.equal(runtimeStatus(policy.fallback).role, "fallback");
  for (const version of [
    "26.0.0",
    "26.8.2",
    "26.12.9",
    "26.13.0",
    "26.14.0",
    "26.40.2",
    "24.0.0",
    "24.21.0",
    "24.22.0",
    "24.23.1",
  ])
    assert.equal(runtimeStatus(version).role, "compatible", version);
  for (const version of ["22.22.1", "25.9.0", "27.0.0", "23.11.0", "26.14.0-pre", "latest"])
    assert.equal(runtimeStatus(version).role, "unsupported", version);
  assert.match(runtimeWarning(runtimeStatus("26.14.0")), /^\[runtime\] Node 26\.14\.0 is accepted but untested/u);
  assert.equal(runtimeWarning(runtimeStatus(policy.primary)), "");
});
test("common CLI runs a compatible runtime with one stderr warning", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-runtime-compatible-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "probe.ts"),
    cli = path.resolve("src/lib/cli/index.ts");
  writeFileSync(
    file,
    `import { runScript } from ${JSON.stringify(cli)}; Object.defineProperty(process.versions,'node',{value:'26.14.0'}); runScript(async()=>({metadata:{ran:true}}));`,
  );
  const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), file], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).metadata.ran, true);
  assert.equal(child.stderr.match(/\[runtime\] Node 26\.14\.0 is accepted but untested/gu)?.length, 1);
});
test("runtime metadata cannot drift from engines or nvm pins", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = runtimePolicy(),
    manifest = {
      config: { nodePrimary: policy.primary, nodeFallback: policy.fallback },
      engines: { node: enginesRange(policy.primary, policy.fallback) },
      packageManager: policy.packageManager,
    };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, ".nvmrc"), policy.primary);
  writeFileSync(path.join(root, ".nvmrc.fallback"), policy.fallback);
  assert.deepEqual(runtimePolicy(root), policy);
  writeFileSync(path.join(root, ".nvmrc"), "26");
  assert.throws(() => runtimePolicy(root), /disagree/u);
  writeFileSync(path.join(root, ".nvmrc"), policy.primary);
  manifest.engines.node = ">=20";
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  assert.throws(() => runtimePolicy(root), /disagree/u);
});
test("CI uses exact pnpm bootstrap without bundled Corepack and checks both runtime roles", () => {
  const { packageManager } = runtimePolicy();
  for (const file of readdirSync(".github/workflows").filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(path.join(".github/workflows", file), "utf8");
    assert.doesNotMatch(text, /corepack enable/u, file);
    if (text.includes("actions/setup-node@"))
      assert.ok(text.includes(`npm install --global ${packageManager} --allow-scripts=pnpm`), file);
  }
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.ok(ci.includes("'.nvmrc.fallback'"));
  assert.ok(ci.includes("runtime:check --expected"));
  // Pull requests run the primary role; pushes to main and the merge queue run both.
  assert.ok(ci.includes(`github.event_name == 'pull_request' && '["primary"]' || '["primary","fallback"]'`));
});
test("selected Node propagates to explicit child executables", () => {
  const child = spawnSync(
    process.execPath,
    ["-p", "JSON.stringify({version:process.versions.node,executable:process.execPath})"],
    { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { version: process.versions.node, executable: process.execPath });
});
test("common CLI rejects an unsupported runtime before the task callback", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-runtime-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "probe.ts"),
    cli = path.resolve("src/lib/cli/index.ts");
  writeFileSync(
    file,
    `import { runScript } from ${JSON.stringify(cli)}; Object.defineProperty(process.versions,'node',{value:'22.22.1'}); runScript(async()=>{throw new Error('TASK_MUST_NOT_RUN')});`,
  );
  const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), file], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  assert.equal(child.status, 1, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.error, "VALIDATION");
  assert.match(result.message, /unsupported/u);
  assert.doesNotMatch(result.message, /TASK_MUST_NOT_RUN/u);
});

test("installation guides retain the exact runtime and package-manager pins", () => {
  const policy = runtimePolicy();
  for (const file of ["README.md", "docs/install.md"]) {
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(policy.primary), file);
    assert.ok(text.includes(policy.fallback), file);
    assert.ok(text.includes(`npm install --global ${policy.packageManager} --allow-scripts=pnpm`), file);
  }
});

test("preflight policy drift stays inside the one-envelope error boundary", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-runtime-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "probe.ts"),
    pin = path.resolve(".nvmrc"),
    doctor = path.resolve("scripts/doctor.ts");
  writeFileSync(
    file,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file)===${JSON.stringify(pin)})return '26';return read.call(this,file,...args)};syncBuiltinESMExports();import(${JSON.stringify(doctor)});`,
  );
  const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), file, "--help"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.error, "VALIDATION");
  assert.match(result.message, /Runtime policy/u);
});
test("MCP refuses unsupported Node without advertising JSON-RPC tools", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-runtime-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "probe.ts"),
    server = path.resolve("src/mcp/stdio.ts");
  writeFileSync(
    file,
    `Object.defineProperty(process.versions,'node',{value:'22.22.1'});import(${JSON.stringify(server)});`,
  );
  const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), file], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /MCP startup failed: Unsupported Node/u);
});

test("the isolated UI scratch package shares the project runtime declarations", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8")),
    scratch = JSON.parse(readFileSync("ui-sources/package.json", "utf8"));
  assert.equal(scratch.packageManager, root.packageManager);
  assert.equal(scratch.engines.node, root.engines.node);
});
