import { spawnSync } from "node:child_process";
export type HandoffProcess = { pid: number; parent: number; start: string };
/** comm deliberately excluded: sandbox/Node/tool exec changes it without changing ownership. */
export function parseHandoffProcesses(text: string): HandoffProcess[] {
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error("Process inventory exceeds bound");
  const lines = text.trim().split("\n");
  if (lines.length > 8192) throw Error("Process inventory count exceeds bound");
  const rows = lines.filter(Boolean).map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(line);
    if (!m) throw Error("Malformed process inventory");
    const pid = Number(m[1]),
      parent = Number(m[2]);
    if (
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      pid > 2147483647 ||
      !Number.isSafeInteger(parent) ||
      parent < 0 ||
      parent > 2147483647
    )
      throw Error("Invalid process identity");
    return { pid, parent, start: m[3] };
  });
  if (new Set(rows.map((x) => x.pid)).size !== rows.length) throw Error("Duplicate process inventory identity");
  return rows;
}
function inventoryDiagnostic(result: unknown, elapsedMs: number) {
  const get = (key: string) => {
    try {
      return (result as Record<string, unknown>)?.[key];
    } catch {
      return undefined;
    }
  };
  const status = get("status"),
    signal = get("signal"),
    pid = get("pid"),
    error = get("error");
  let code: unknown;
  try {
    code = (error as { code?: unknown })?.code;
  } catch {
    code = undefined;
  }
  const boundedToken = (value: unknown) =>
    typeof value === "string" && /^[A-Z0-9_]{1,32}$/.test(value) ? value : null;
  const bytes = (value: unknown) =>
    typeof value === "string" ? Math.min(Buffer.byteLength(value), 1024 * 1024 + 1) : null;
  return JSON.stringify({
    version: 1,
    status: typeof status === "number" && Number.isSafeInteger(status) ? status : null,
    signal: boundedToken(signal),
    errorPresent: error !== undefined,
    errorCode: boundedToken(code),
    collectorPidValid:
      typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647 && pid !== process.pid,
    elapsedMs: Math.min(Math.max(0, elapsedMs), 60000),
    stdoutBytes: bytes(get("stdout")),
    stderrBytes: bytes(get("stderr")),
  });
}
export function handoffProcessInventory() {
  const started = Date.now();
  const r = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  if (
    r.status !== 0 ||
    r.signal !== null ||
    r.error !== undefined ||
    !Number.isSafeInteger(r.pid) ||
    r.pid < 1 ||
    r.pid > 2147483647 ||
    r.pid === process.pid
  )
    throw Error("Owned process inventory unavailable " + inventoryDiagnostic(r, Date.now() - started));
  const rows = parseHandoffProcesses(r.stdout);
  // spawnSync has fully closed this exact direct child before its earlier census is consumed.
  const collector = rows.find((row) => row.pid === r.pid);
  if (collector && collector.parent !== process.pid) throw Error("Closed collector ancestry mismatch");
  return collector ? rows.filter((row) => row.pid !== r.pid) : rows;
}
export class HandoffOwnership {
  private owned = new Map<number, HandoffProcess>();
  private root?: HandoffProcess;
  register(pid: number, parent: number, rows: HandoffProcess[]) {
    const r = rows.find((x) => x.pid === pid && x.parent === parent);
    if (!r || this.root) throw Error("No unique live direct worker ancestry");
    this.root = r;
    this.owned.set(pid, r);
    this.capture(rows);
  }
  capture(rows: HandoffProcess[]) {
    if (!this.root) return;
    const alive = new Set(
      [...this.owned.values()]
        .filter((x) => rows.some((r) => r.pid === x.pid && r.start === x.start))
        .map((x) => x.pid),
    );
    for (let n = 0; n < rows.length; n++) {
      let changed = false;
      for (const r of rows)
        if (alive.has(r.parent) && !alive.has(r.pid)) {
          const old = this.owned.get(r.pid);
          if (old && old.start !== r.start) continue;
          alive.add(r.pid);
          this.owned.set(r.pid, r);
          changed = true;
        }
      if (!changed) break;
    }
  }
  targets(rows: HandoffProcess[]) {
    this.capture(rows);
    return [...this.owned.values()].reverse().filter((x) => rows.some((r) => r.pid === x.pid && r.start === x.start));
  }
}
