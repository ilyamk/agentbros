import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { command } from "../src/lib/bench/io";
import { runWorkflowEvaluation } from "../src/lib/bench/workflow-run";
import { WorkflowReportSchema } from "../src/types/workflow-evaluation";

test("actual parent and leaf processes use the trusted command boundary in both harness formats", async (t) => {
  const root = process.cwd(),
    directory = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-fake-harness-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "harness.cjs"),
    outside = path.join(directory, "outside"),
    hook = path.join(directory, "slow-write.cjs");
  writeFileSync(
    hook,
    `const fs=require('node:fs'),write=fs.writeFileSync;fs.writeFileSync=function(file,data,options){if(String(file).includes('workflow-bridge')&&(String(file).endsWith('.request.tmp')||String(file).includes('/inbox/'))){const fd=fs.openSync(file,options?.flag||'w',options?.mode||0o600);try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);fs.writeSync(fd,data);}finally{fs.closeSync(fd);}}else return write.apply(this,arguments);};`,
  );
  const { mkdirSync } = await import("node:fs");
  mkdirSync(outside);
  writeFileSync(
    file,
    `#!${process.execPath}
const cp=require('node:child_process');
if(process.argv.includes('--version')){console.log('explicit-fixture-harness 1');process.exit(0);}
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
const slow=process.argv.includes('fixture-slow-publish'),setupEscape=process.argv.includes('fixture-setup-symlink'),forged=process.argv.includes('fixture-forged-request'),removeInbox=process.argv.includes('fixture-remove-inbox'),shared=process.argv.includes('fixture-shared-limit'),falseLeaf=process.argv.includes('fixture-false-leaf');
if(forged){require('node:fs').writeFileSync('.cache/workflow-bridge/root/inbox/'+require('node:crypto').randomUUID()+'.json',JSON.stringify({body:JSON.stringify({kind:'command',alias:'commands',argv:[]}),signature:'0'.repeat(64)}));setInterval(()=>{},10000);return;}
if(removeInbox){require('node:fs').rmSync('.cache/workflow-bridge/root/inbox',{recursive:true,force:true});setInterval(()=>{},10000);return;}
if(setupEscape)require('node:fs').symlinkSync(${JSON.stringify(outside)},'.cache/workflow-bridge/leaf-1','dir');
const outputs=[];function run(bin,args){const value=cp.execFileSync(bin,args,{encoding:'utf8',timeout:60000,...(slow?{env:{...process.env,NODE_OPTIONS:'--require='+${JSON.stringify(hook)}}}:{})});outputs.push(value);return JSON.parse(value);}
const leaf=prompt.includes('You are a leaf agent.');
if(!leaf){run('pnpm',['--help']);run('pnpm',['transcribe','--help']);run('pnpm',['shorts:prepare','--help']);}
if(shared&&!leaf)console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:60000,output_tokens:0}}));
if(!leaf&&prompt.includes('Use workflow-delegate')){run('workflow-delegate',['Prepare transcript.json from material/scribe.json and input.wav; do not delegate.']);if(falseLeaf)run('pnpm',['transcribe','--input','input.wav','--from-raw','material/scribe.json','--output','transcript.json']);}
else if(falseLeaf)run('pnpm',['speech:local','--help']);
else run('pnpm',['transcribe','--input','input.wav','--from-raw','material/scribe.json','--output','transcript.json','--language','en']);
if(!leaf)run('pnpm',['shorts:prepare','--transcript','transcript.json','--output-dir','shorts','--min-sec','1','--max-sec','3','--hard-max-sec','4']);
if(process.argv.includes('exec')){console.log(JSON.stringify({type:'item.completed',item:{id:'actual-tool',type:'command_execution',aggregated_output:outputs.join('')}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:shared?100000:10,output_tokens:5}}));}
else {console.log(JSON.stringify({type:'assistant',message:{id:'actual-message',content:[{type:'tool_use',id:'actual-tool'}],usage:{input_tokens:10,output_tokens:5}}}));console.log(JSON.stringify({type:'result',usage:{input_tokens:10,output_tokens:5}}));}
});
`,
    { mode: 0o700 },
  );
  chmodSync(file, 0o700);
  for (const harness of ["codex", "claude-code"] as const) {
    const key = `BENCH_HARNESS_BIN_${harness.replaceAll("-", "_").toUpperCase()}`,
      old = process.env[key];
    process.env[key] = file;
    try {
      const result = await runWorkflowEvaluation({
        root,
        mode: "agent",
        scenario: "leaf-handoff",
        agent: { harness, model: "explicit-fixture-model", allowAgent: true },
      });
      t.after(() => rmSync(path.join(root, path.dirname(result.outputs.at(-1)!)), { recursive: true, force: true }));
      assert.ok("counts" in result.metadata);
      assert.equal(result.metadata.counts.failed, 0, JSON.stringify(result));
      const report = WorkflowReportSchema.parse(JSON.parse(readFileSync(path.join(root, result.outputs[0]!), "utf8")));
      assert.equal(report.status, "passed", JSON.stringify(report.findings));
      assert.equal(report.harness?.fixture, true);
      assert.ok(report.events.some((e) => e.parent === "root" && e.actor === "leaf-1" && e.command === "transcribe"));
      assert.ok(report.events.some((e) => e.actor === "root" && e.command === "shorts:prepare"));
      assert.deepEqual(report.metrics.tokens, { input: 20, output: 10 });
      assert.equal(report.metrics.pendingOwnedCommands, 0);
      const campaign = path.basename(path.dirname(path.dirname(result.outputs[0]!)));
      assert.ok(
        !command("git", ["worktree", "list", "--porcelain"], root).includes(
          path.join(root, ".cache/bench/worktrees", campaign),
        ),
        "only this run owns and removes its worktree",
      );
    } finally {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  }
  for (const model of [
    "fixture-false-leaf",
    "fixture-remove-inbox",
    "fixture-shared-limit",
    "fixture-forged-request",
    "fixture-setup-symlink",
    "fixture-slow-publish",
  ]) {
    const key = "BENCH_HARNESS_BIN_CODEX",
      old = process.env[key],
      originalWrite = fs.writeFileSync;
    process.env[key] = file;
    if (model === "fixture-slow-publish") {
      fs.writeFileSync = (target, data, options) => {
        if (
          typeof target === "string" &&
          target.includes("workflow-bridge") &&
          (target.endsWith(".reply.tmp") || target.includes("/replies/"))
        ) {
          const opts = typeof options === "object" && options !== null ? options : {};
          const fd = fs.openSync(target, opts.flag ?? "w", opts.mode ?? 0o600);
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
            fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
          } finally {
            fs.closeSync(fd);
          }
        } else originalWrite(target, data, options);
      };
      syncBuiltinESMExports();
    }
    try {
      const result = await runWorkflowEvaluation({
        root,
        mode: "agent",
        scenario: "leaf-handoff",
        agent: { harness: "codex", model, allowAgent: true },
      });
      t.after(() => rmSync(path.join(root, path.dirname(result.outputs.at(-1)!)), { recursive: true, force: true }));
      const report = WorkflowReportSchema.parse(JSON.parse(readFileSync(path.join(root, result.outputs[0]!), "utf8")));
      assert.equal(
        report.status,
        model === "fixture-slow-publish" ? "passed" : "failed",
        model + ": " + JSON.stringify(report.findings),
      );
      if (model === "fixture-false-leaf")
        assert.ok(
          report.findings.some((f) => /not produced by.*leaf/u.test(f.message)),
          JSON.stringify(report.findings),
        );
      if (model === "fixture-remove-inbox" || model === "fixture-forged-request")
        assert.ok(report.findings.some((f) => f.boundary === "observation"));
      if (model === "fixture-setup-symlink") {
        const { existsSync } = await import("node:fs");
        assert.equal(existsSync(path.join(outside, "inbox")), false);
        assert.equal(existsSync(path.join(outside, "replies")), false);
      }
      if (model === "fixture-shared-limit") {
        assert.ok(
          report.metrics.observedTokens &&
            report.metrics.observedTokens.input + report.metrics.observedTokens.output > 150000,
          JSON.stringify({ findings: report.findings, metrics: report.metrics }),
        );
        assert.ok(
          !report.events.some(
            (e) => e.actor === "root" && e.command === "shorts:prepare" && !e.argv.includes("--help"),
          ),
          "shared usage stops the parent before further handoff",
        );
      }
      assert.equal(report.metrics.pendingOwnedCommands, 0);
    } finally {
      fs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  }
});
