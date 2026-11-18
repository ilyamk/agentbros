import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { OperationStore } from "../src/lib/jobs/store";
const original = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "video-jobs-"));
const modulePath = path.join(original, "src/lib/jobs/store.ts");
test.after(() => rmSync(root, { recursive: true, force: true }));
function quote(cost = 1) {
  return {
    currency: "USD" as const,
    lowUsd: cost,
    expectedUsd: cost,
    highUsd: cost,
    bounded: true as const,
    source: "fixture",
    asOf: "2026-10-11",
    confidence: "published-rate" as const,
  };
}
function operation(id: string) {
  return { operationId: id, provider: "test", endpoint: "test/image", assetId: id, inputHash: id, quote: quote() };
}
function child(script: string, args: string[] = []) {
  const file = path.join(root, `${Math.random()}.ts`);
  writeFileSync(file, script);
  return spawn(path.join(original, "node_modules/.bin/tsx"), [file, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}
function completed(process: ReturnType<typeof child>) {
  return new Promise<string>((resolve, reject) => {
    let output = "",
      error = "";
    process.stdout.on("data", (data) => {
      output += data;
    });
    process.stderr.on("data", (data) => {
      error += data;
    });
    process.once("error", reject);
    process.once("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(error))));
  });
}

test("restart resumes provider result/download without another submit", () => {
  const directory = path.join(root, "resume");
  let store = new OperationStore("resume", { directory });
  store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  store.reserveOperation(operation("one"));
  store.transitionJob("one", "submitting");
  store.transitionJob("one", "queued", { providerRequestId: "provider-id" });
  store.transitionJob("one", "result-ready", { result: { video: { url: "fixture://result" } } });
  store.transitionJob("one", "downloading");
  store.transitionJob("one", "failed", { error: "disk full" });
  store = new OperationStore("resume", { directory });
  const remembered = store.snapshot().jobs.one;
  assert.equal(remembered.providerRequestId, "provider-id");
  assert.equal(remembered.paidAttempts, 1);
  assert.equal(store.summary().reservedUsd, 1);
  assert.deepEqual(store.summary().unreconciled, ["one"]);
  store.transitionJob("one", "downloading");
  store.transitionJob("one", "validated");
  store.transitionJob("one", "published");
  assert.equal(store.snapshot().jobs.one.paidAttempts, 1);
  assert.throws(() => store.transitionJob("one", "submitting"), /Cannot transition/);
});

test("competing process reservations stay under hard ceiling", async () => {
  const directory = path.join(root, "race");
  const store = new OperationStore("race", { directory });
  store.configure({ ceilingUsd: 4, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  const script = `import {OperationStore,BudgetError} from ${JSON.stringify(modulePath)};
async function main(){const store=new OperationStore('race',{directory:process.argv[2]});const id=process.argv[3];
for(let retry=0;;retry++){try{store.reserveOperation({operationId:id,assetId:id,provider:'test',endpoint:'test/image',inputHash:id,quote:${JSON.stringify(quote())}});console.log('reserved');break;}catch(error){if(error instanceof BudgetError&&error.code==='CONFLICT'&&retry<300){await new Promise(r=>setTimeout(r,5));continue;}if(error instanceof BudgetError&&error.code==='BUDGET_EXCEEDED'){console.log('denied');break;}throw error;}}}
main().catch(error=>{console.error(error);process.exitCode=1});`;
  const outputs = await Promise.all(
    Array.from({ length: 8 }, (_, i) => completed(child(script, [directory, `job-${i}`]))),
  );
  assert.equal(outputs.filter((output) => output.trim() === "reserved").length, 4);
  assert.equal(outputs.filter((output) => output.trim() === "denied").length, 4);
  assert.equal(store.summary().reservedUsd, 4);
  assert.equal(Object.keys(store.snapshot().jobs).length, 4);
  assert.doesNotThrow(() => JSON.parse(readFileSync(store.file, "utf8")));
});

test("SIGKILL during an acquired transaction preserves state and dead lock recovers", async () => {
  const directory = path.join(root, "kill");
  const store = new OperationStore("kill", { directory });
  store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  store.reserveOperation(operation("before"));
  const before = readFileSync(store.file, "utf8");
  const process = child(
    `import {OperationStore} from ${JSON.stringify(modulePath)};
const store=new OperationStore('kill',{directory:process.argv[2]});
(store as any).transaction((database:any)=>{database.jobs.before.state='unknown';console.log('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return {database,result:null};});`,
    [directory],
  );
  const exited = new Promise<void>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    process.stdout.once("data", () => resolve());
    process.once("error", reject);
  });
  const owner = JSON.parse(readFileSync(`${store.file}.lock`, "utf8")) as { pid: number };
  globalThis.process.kill(owner.pid, "SIGKILL");
  await exited;
  assert.equal(existsSync(`${store.file}.lock`), true);
  assert.equal(readFileSync(store.file, "utf8"), before);
  writeFileSync(`${store.file}.orphan.tmp`, "partial interrupted temporary write");
  store.reserveOperation(operation("after"));
  assert.equal(store.summary().reservedUsd, 2);
  assert.equal(store.snapshot().jobs.before.state, "reserved");
  assert.equal(existsSync(`${store.file}.lock`), false);
});
