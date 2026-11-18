import {spawnSync} from "node:child_process";
import {writeFileSync} from "node:fs";

const rootPid = Number(process.argv[2]), output = process.argv[3];
const started = Date.now(), samples = [];
let errors = 0;
function sample() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) { errors++; return; }
  const rows = result.stdout.trim().split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, command: match[4].split("/").at(-1)}] : [];
  });
  const included = new Set([rootPid]);
  for (let pass = 0; pass < rows.length; pass++) {
    let changed = false;
    for (const row of rows) if (row.pid !== process.pid && !included.has(row.pid) && included.has(row.ppid)) { included.add(row.pid); changed = true; }
    if (!changed) break;
  }
  const members = rows.filter(row => included.has(row.pid));
  samples.push({elapsedMs: Date.now() - started, rssBytes: members.reduce((n, row) => n + row.rssBytes, 0), processes: members});
}
sample();
process.stdout.write("ready\n");
const interval = setInterval(sample, 1000);
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true; clearInterval(interval); sample();
  const gaps = samples.slice(1).map((s, i) => s.elapsedMs - samples[i].elapsedMs);
  writeFileSync(output, JSON.stringify({rootPid, sampleCadenceMs: 1000, samples: samples.length, failedSamples: errors,
    maxGapMs: Math.max(0, ...gaps), peakSampledAggregateRssBytes: Math.max(0, ...samples.map(s => s.rssBytes)),
    limitations: ["RSS sums shared pages and may overcount physical memory", "Processes shorter than sample cadence may be missed", "Reparented/orphan processes cannot be attributed by ancestry", "Monitor and its ps children excluded", "Sampled maximum is not a guaranteed instantaneous maximum"], series: samples}, null, 2));
}
process.stdin.on("data", stop); process.stdin.on("end", stop);
process.on("SIGTERM", () => {stop(); process.exit(0);});
