import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
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
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowObserver } from "../src/lib/bench/workflow-observer";
import { captureWorkflowSource } from "../src/lib/bench/workflow-source";
import { workflowScenarios } from "../src/lib/bench/workflow-scenarios";
import { command, digest } from "../src/lib/bench/io";
import { runWorkflowEvaluation } from "../src/lib/bench/workflow-run";

const repo = process.cwd();
function fixture(t: test.TestContext, signal?: AbortSignal) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-boundary-"))),
    workspace = path.join(root, "workspace"),
    code = path.join(root, "code");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(workspace);
  mkdirSync(path.join(code, "scripts"), { recursive: true });
  symlinkSync(path.join(repo, "node_modules"), path.join(code, "node_modules"), "dir");
  writeFileSync(
    path.join(code, "package.json"),
    JSON.stringify({ scripts: { commands: "tsx scripts/commands.ts", "film:init": "tsx scripts/film-init.ts" } }),
  );
  const entry = workflowScenarios(repo).find((e) => e.scenario.id === "playbook-intake")!;
  const observer = new WorkflowObserver(
    code,
    workspace,
    path.join(root, "evidence"),
    entry.scenario,
    undefined,
    signal,
  );
  t.after(() => observer.stop());
  return { root, workspace, code, observer };
}
test("passive help, task discovery and offline verification remain available across task families", async (t) => {
  const { code, workspace, observer } = fixture(t);
  const scripts = {
    commands: "scripts/commands.ts",
    "local:capabilities": "scripts/local-capabilities.ts",
    transcribe: "scripts/transcribe.ts",
    "shorts:prepare": "scripts/shorts-prepare.ts",
    "voiceover:local": "scripts/local-task.ts",
  };
  writeFileSync(
    path.join(code, "package.json"),
    JSON.stringify({
      scripts: Object.fromEntries(Object.entries(scripts).map(([alias, file]) => [alias, `tsx ${file}`])),
    }),
  );
  for (const file of Object.values(scripts))
    writeFileSync(
      path.join(code, file),
      "console.log(JSON.stringify({ok:true,elapsedMs:0,metadata:{argv:process.argv.slice(2)}}));",
    );
  for (const alias of ["transcribe", "shorts:prepare"]) {
    const result = await observer.execute(alias, ["-h"]);
    assert.equal(result.event.passed, true, alias);
    assert.deepEqual(result.event.inputs, []);
    assert.deepEqual(result.event.argv, ["--help"]);
    assert.deepEqual(result.envelope.metadata?.argv, ["--help"]);
  }
  assert.equal(
    (await observer.execute("local:capabilities", ["--task", "speech.synthesise", "--language", "en"])).event.passed,
    true,
  );
  mkdirSync(path.join(workspace, "material"));
  writeFileSync(path.join(workspace, "input.wav"), "scoped fixture input");
  const material = observer.scenario.material.find((m) => m.path.endsWith("/scribe.json"))!;
  copyFileSync(path.join(repo, material.path), path.join(workspace, "material/scribe.json"));
  assert.equal(
    (
      await observer.execute("transcribe", [
        "--input",
        "input.wav",
        "--from-raw",
        "material/scribe.json",
        "--output",
        "transcript.json",
      ])
    ).event.passed,
    true,
  );
  for (const [alias, argv] of [
    ["transcribe", ["--input", "input.wav"]],
    ["transcribe", ["--help", "--force"]],
    ["voiceover:local", ["--task", "text.assist"]],
  ] as [string, string[]][])
    await assert.rejects(observer.execute(alias, argv), /authority/);
  assert.equal(observer.activeProcesses, 0);
});
test("output destinations and project/material paths are confined before any process starts", async (t) => {
  const { root, workspace, code, observer } = fixture(t),
    outside = path.join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(workspace, "linked"), "dir");
  observer.scenario.commands.push("transcribe");
  const manifest = JSON.parse(readFileSync(path.join(code, "package.json"), "utf8"));
  manifest.scripts.transcribe = "tsx scripts/transcribe.ts";
  writeFileSync(path.join(code, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    path.join(code, "scripts/transcribe.ts"),
    `import fs from 'node:fs';fs.writeFileSync('launched','yes');const a=process.argv.slice(2);const n=a.findIndex(x=>x==='-o'||x==='--output');const e=a.find(x=>x.startsWith('-o=')||x.startsWith('--output='));const output=n>=0?a[n+1]:e?.slice(e.indexOf('=')+1);if(output)fs.writeFileSync(output,'escaped');console.log(JSON.stringify({ok:true,outputs:output?[output]:[],elapsedMs:0}));`,
  );
  writeFileSync(
    path.join(workspace, "raw.json"),
    readFileSync(path.join(repo, "bench/workflows/v2/material/scribe.json")),
  );
  writeFileSync(path.join(workspace, "input.wav"), "fixture");
  for (const args of [
    ["--project", "safe", "--output", "../outside/leak.json"],
    ["--project=safe", "--output=" + path.join(outside, "leak.json")],
    ["--project", "../outside"],
    ["--project", "safe", "--output-dir", "linked"],
  ])
    await assert.rejects(observer.execute("film:init", args));
  for (const args of [
    ["--from-raw", "raw.json", "-i", "input.wav", "-o", path.join(outside, "leak.json")],
    ["--from-raw=raw.json", "-i=input.wav", "-o=" + path.join(outside, "leak.json")],
    ["--from-raw", "raw.json", "-i", "input.wav", "-f"],
    ["--from-raw", "raw.json", "-f=true"],
    ["--from-raw", "raw.json", "-fo=" + path.join(outside, "leak.json")],
  ])
    await assert.rejects(observer.execute("transcribe", args));
  assert.equal(existsSync(path.join(outside, "leak.json")), false);
  assert.equal(existsSync(path.join(workspace, "launched")), false);
  assert.equal(observer.activeProcesses, 0);
});
test("value profiles are not mistaken for paths; UTF-8 replies and credential withholding remain exact", async (t) => {
  const { code, observer } = fixture(t);
  writeFileSync(
    path.join(code, "scripts/film-init.ts"),
    `import fs from 'node:fs'; const b=Buffer.from(JSON.stringify({ok:true,outputs:[],metadata:{word:'Кириллица',keySeen:!!process.env.FAL_KEY},elapsedMs:0})+'\\n');const i=b.indexOf(Buffer.from('К'))+1;fs.writeSync(1,b.subarray(0,i));setTimeout(()=>fs.writeSync(1,b.subarray(i)),30);`,
  );
  const old = process.env.FAL_KEY;
  process.env.FAL_KEY = "explicit-test-sentinel";
  try {
    const result = await observer.execute("film:init", ["--project", "safe", "--profile", "promo"], {
      authority: "fixture",
    });
    assert.equal(result.event.passed, true, result.event.stderr ?? "");
    assert.equal(result.envelope.metadata?.word, "Кириллица");
    assert.equal(result.envelope.metadata?.keySeen, false);
  } finally {
    if (old === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = old;
  }
});
test(
  "cancellation kills owned executor descendants and prevents subsequent commands",
  { skip: process.platform === "win32" },
  async (t) => {
    const controller = new AbortController(),
      { code, workspace, observer } = fixture(t, controller.signal);
    writeFileSync(
      path.join(code, "scripts/commands.ts"),
      `import{spawn}from'node:child_process';import fs from'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync('child.json',JSON.stringify({pid:c.pid}));setInterval(()=>{},10000);`,
    );
    const running = observer.execute("commands", [], { authority: "fixture", timeoutMs: 15000 });
    const marker = path.join(workspace, "child.json");
    for (let i = 0; i < 250 && !existsSync(marker); i++) await delay(20);
    assert.ok(existsSync(marker), "fixture child started within the generous setup limit");
    controller.abort();
    const result = await running;
    assert.equal(result.event.passed, false);
    assert.equal(observer.activeProcesses, 0);
    await assert.rejects(observer.execute("commands", []), /cancelled/);
    const pid = JSON.parse(observer.read("child.json").toString()).pid as number;
    const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      timeout: 5000,
    }).stdout.trim();
    assert.ok(!status || status.startsWith("Z"), `owned descendant is still live: ${status}`);
  },
);
test("FIFO inputs never block the observer", { skip: process.platform === "win32" }, (t) => {
  const { workspace, observer } = fixture(t);
  assert.equal(spawnSync("mkfifo", [path.join(workspace, "pipe.json")], { timeout: 5000 }).status, 0);
  assert.throws(() => observer.pin("pipe.json"), /regular file/);
});
test("trusted source changes refuse continuation rather than retaining a stale commit claim", (t) => {
  const { code } = fixture(t);
  writeFileSync(path.join(code, "scripts/commands.ts"), "export const version = 1;");
  command("git", ["init", "-b", "fixture"], code);
  command("git", ["add", "package.json", "scripts"], code);
  command(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"],
    code,
  );
  const source = captureWorkflowSource(code);
  assert.equal(source.dirty, false);
  source.verify();
  writeFileSync(path.join(code, "scripts/commands.ts"), "export const version = 2;");
  assert.throws(() => source.verify(), /source changed/);
});
test("an unrelated custom scenario cannot pass by falling through to a convenient oracle", async (t) => {
  const entry = workflowScenarios(repo)[0]!,
    qa = path.join(repo, "out/qa");
  mkdirSync(qa, { recursive: true });
  // The suite must sit inside the evaluated root, so the scratch folder is a unique temporary directory under the ignored out/qa/, removed afterwards.
  const directory = mkdtempSync(path.join(qa, "workflow-unknown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scenario = { ...entry.scenario, id: "unregistered-task", task: "An unrelated task has no registered oracle." },
    bytes = JSON.stringify(scenario) + "\n",
    file = path.join(directory, "scenario.json");
  writeFileSync(file, bytes);
  const suite = path.join(directory, "suite.json");
  writeFileSync(
    suite,
    JSON.stringify({
      version: 2,
      protocol: "agent-workflow",
      scenarios: [{ id: scenario.id, path: path.relative(repo, file), sha256: digest(bytes) }],
    }),
  );
  const result = await runWorkflowEvaluation({ root: repo, suite: path.relative(repo, suite) });
  t.after(() => rmSync(path.join(repo, path.dirname(result.outputs.at(-1)!)), { recursive: true, force: true }));
  assert.ok("counts" in result.metadata);
  assert.equal(result.metadata.counts.inconclusive, 1);
  assert.equal(result.metadata.accepted, false);
});
