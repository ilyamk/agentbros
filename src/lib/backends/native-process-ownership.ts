import { spawnSync } from "node:child_process";
type Identity = { pid: number; ppid: number; start: string };
function snapshot(): Identity[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart=,comm="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw Error("Native owned process inventory unavailable");
  return result.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3] }] : [];
  });
}
/** Authenticated IPC caller supplies a directly observed worker child, never an authored PID. */
export class NativePreparationOwnership {
  private identities: Identity[] = [];
  private roots: Identity[] = [];
  register(pid: number, parentPid: number) {
    const rows = snapshot(),
      identity = rows.find((r) => r.pid === pid && r.ppid === parentPid);
    if (!identity) throw Error("Native preparation claim has no live direct ancestry");
    this.roots.push(identity);
    this.capture();
  }
  capture() {
    if (!this.roots.length) return;
    const rows = snapshot(),
      included = new Set(
        this.identities.filter((r) => rows.some((x) => x.pid === r.pid && x.start === r.start)).map((r) => r.pid),
      );
    for (const root of this.roots)
      if (rows.some((r) => r.pid === root.pid && r.start === root.start)) included.add(root.pid);
    for (let i = 0; i < rows.length; i++) {
      let changed = false;
      for (const r of rows)
        if (included.has(r.ppid) && !included.has(r.pid)) {
          included.add(r.pid);
          changed = true;
        }
      if (!changed) break;
    }
    for (const r of rows)
      if (included.has(r.pid) && !this.identities.some((x) => x.pid === r.pid && x.start === r.start))
        this.identities.push(r);
  }
  kill() {
    if (!this.roots.length) return;
    this.capture();
    const rows = snapshot();
    for (const root of this.roots)
      if (rows.some((r) => r.pid === root.pid && r.start === root.start))
        try {
          process.kill(-root.pid, "SIGKILL");
        } catch {}
    for (const owned of this.identities.slice().reverse())
      if (rows.some((r) => r.pid === owned.pid && r.start === owned.start))
        try {
          process.kill(owned.pid, "SIGKILL");
        } catch {}
  }
}
