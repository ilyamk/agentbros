import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import vm from "node:vm";
import { createHash } from "node:crypto";
import {
  handoffProcessInventory,
  HandoffOwnership,
  parseHandoffProcesses,
} from "../src/lib/delivery/platform-audio-handoff-ownership";

const start = "Mon Oct 12 08:00:00 2026",
  collector = 987650,
  workload = 987651;
const row = (pid: number, parent: number, birth = start) => `${pid} ${parent} ${birth}\n`;
// Exact retained 00ca881 ownership.ts line10; VM executes this consumer, not a surrogate.
const retained =
  "export function handoffProcessInventory(){const r=spawnSync('/bin/ps',['-axo','pid=,ppid=,lstart='],{encoding:'utf8',timeout:200,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});if(r.status!==0||r.error)throw Error('Owned process inventory unavailable');return parseHandoffProcesses(r.stdout);}";
const retainedSha = "b4b37abe5a5442632af838ca8eb78b19975ad136dbc5bee519abd132047cd0d5";
function withResult(result: Record<string, unknown>, action: () => void, expectedTimeout = 1000) {
  const original = cp.spawnSync;
  let calls = 0;
  cp.spawnSync = ((binary: unknown, args: unknown, options: unknown) => {
    calls++;
    assert.equal(binary, "/bin/ps");
    assert.equal(JSON.stringify(args), JSON.stringify(["-axo", "pid=,ppid=,lstart="]));
    assert.equal(
      JSON.stringify(options),
      JSON.stringify({
        encoding: "utf8",
        timeout: expectedTimeout,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      }),
    );
    return result;
  }) as unknown as typeof cp.spawnSync;
  syncBuiltinESMExports();
  try {
    action();
    assert.ok(calls > 0, "Actual fixed collector consumer called");
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
  }
}
const success = (text: string, id = collector) => ({
  pid: id,
  status: 0,
  signal: null,
  error: undefined,
  stdout: text,
  stderr: "",
});
const targets = (ownership: HandoffOwnership, rows: ReturnType<typeof handoffProcessInventory>) =>
  ownership.targets(rows).filter((item) => item.pid !== process.pid);
test("retained exact old consumer sees its closed collector as workload; current real consumer excludes only it", () => {
  assert.equal(createHash("sha256").update(retained).digest("hex"), retainedSha);
  const text = row(process.pid, process.ppid) + row(collector, process.pid);
  withResult(success(text), () => {
    const old = vm.runInNewContext(
      retained.replace("export ", "") + ";handoffProcessInventory;",
      {
        spawnSync: (binary: string, args: string[], options: { timeout: number }) => {
          assert.equal(binary, "/bin/ps");
          assert.deepEqual(Array.from(args), ["-axo", "pid=,ppid=,lstart="]);
          assert.equal(options.timeout, 200);
          return success(text);
        },
        parseHandoffProcesses,
      },
      { timeout: 1000 },
    )();
    const oldOwnership = new HandoffOwnership();
    oldOwnership.register(process.pid, process.ppid, old);
    assert.deepEqual(
      targets(oldOwnership, old).map((item) => item.pid),
      [collector],
    );
    const current = handoffProcessInventory(),
      ownership = new HandoffOwnership();
    ownership.register(process.pid, process.ppid, current);
    assert.deepEqual(current, [{ pid: process.pid, parent: process.ppid, start }]);
    assert.deepEqual(targets(ownership, current), []);
  });
});
test("repeated collector identities never accumulate false targets; genuine owned and foreign/unknown rows preserved", () => {
  const ownership = new HandoffOwnership();
  for (let index = 0; index < 4; index++)
    withResult(
      success(
        row(process.pid, process.ppid) +
          row(collector + index * 10, process.pid) +
          row(workload, process.pid) +
          row(42, 1),
        collector + index * 10,
      ),
      () => {
        const rows = handoffProcessInventory();
        if (index === 0) ownership.register(process.pid, process.ppid, rows);
        assert.deepEqual(
          rows.map((item) => item.pid),
          [process.pid, workload, 42],
        );
        assert.deepEqual(
          targets(ownership, rows).map((item) => item.pid),
          [workload],
        );
      },
    );
  withResult(success(row(process.pid, process.ppid) + row(collector + 100, process.pid), collector + 100), () =>
    assert.deepEqual(targets(ownership, handoffProcessInventory()), []),
  );
});
test("absent collector row preserves all census rows without guessing any workload identity", () => {
  const text = row(process.pid, process.ppid) + row(workload, process.pid) + row(42, 1);
  withResult(success(text), () => assert.deepEqual(handoffProcessInventory(), parseHandoffProcesses(text)));
});
for (const [name, patch] of [
  ["zero pid", { pid: 0 }],
  ["negative pid", { pid: -1 }],
  ["fraction pid", { pid: 1.5 }],
  ["unsafe pid", { pid: Number.MAX_SAFE_INTEGER + 1 }],
  ["out of domain pid", { pid: 2147483648 }],
  ["caller pid", { pid: process.pid }],
  ["missing pid", { pid: undefined }],
  ["unknown status", { status: null }],
  ["failed status", { status: 1 }],
  ["signal", { signal: "SIGKILL" }],
  ["missing signal", { signal: undefined }],
  ["error", { error: Error("inventory fault") }],
  ["wrong parent", { stdout: row(collector, 1) }],
  ["duplicate row", { stdout: row(collector, process.pid) + row(collector, process.pid) }],
  ["malformed row", { stdout: "invalid" }],
  ["oversize", { stdout: "x".repeat(1024 * 1024 + 1) }],
] as const)
  test(`real collector fails closed for ${name}`, () =>
    withResult({ ...success(row(collector, process.pid)), ...patch }, () => assert.throws(handoffProcessInventory)));
test("filter does not change stable workload birth/reparenting or admit reused owned PID", () => {
  const ownership = new HandoffOwnership();
  withResult(success(row(process.pid, process.ppid) + row(workload, process.pid) + row(collector, process.pid)), () =>
    ownership.register(process.pid, process.ppid, handoffProcessInventory()),
  );
  withResult(success(row(workload, 1) + row(collector, process.pid)), () =>
    assert.deepEqual(
      targets(ownership, handoffProcessInventory()).map((item) => item.pid),
      [workload],
    ),
  );
  withResult(success(row(workload, 1, start.replace("00:00", "00:01")) + row(collector, process.pid)), () =>
    assert.deepEqual(targets(ownership, handoffProcessInventory()), []),
  );
});

test("failed collector diagnostic is closed bounded and preserves guard without raw stderr disclosure", () => {
  for (const patch of [
    { status: null, signal: "SIGTERM", error: Object.assign(Error("private detail"), { code: "ETIMEDOUT" }) },
    { status: 2, signal: null, error: undefined },
  ])
    withResult({ ...success("private rows"), stderr: "secret body", ...patch }, () => {
      let error: unknown;
      try {
        handoffProcessInventory();
      } catch (value) {
        error = value;
      }
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith("Owned process inventory unavailable "));
      const row = JSON.parse(error.message.slice("Owned process inventory unavailable ".length));
      assert.deepEqual(Object.keys(row).sort(), [
        "collectorPidValid",
        "elapsedMs",
        "errorCode",
        "errorPresent",
        "signal",
        "status",
        "stderrBytes",
        "stdoutBytes",
        "version",
      ]);
      assert.equal(row.collectorPidValid, true);
      assert.equal(row.status, patch.status);
      assert.equal(row.signal, patch.signal);
      assert.equal(row.stderrBytes, 11);
      assert.ok(error.message.length <= 512);
      assert.ok(!error.message.includes("secret") && !error.message.includes("private"));
    });
});
test("hostile frozen error formatter never masks inventory refusal or discloses arbitrary error code", () => {
  const error = Object.freeze({
    get code() {
      throw Error("HOSTILE");
    },
    toString() {
      throw Error("HOSTILE");
    },
  });
  withResult({ ...success(""), error }, () =>
    assert.throws(
      handoffProcessInventory,
      (value) =>
        value instanceof Error &&
        value.message.startsWith("Owned process inventory unavailable ") &&
        JSON.parse(value.message.slice("Owned process inventory unavailable ".length)).errorCode === null,
    ),
  );
});
