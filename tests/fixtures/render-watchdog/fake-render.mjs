// Fake `remotion render`: prints progress, then either finishes or repeats the last line forever (a hung Chromium).
// argv: <mode: stall|ok|stall-once> <pid-file> <marker-file>
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const [mode, pidFile, marker] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(grandchild.pid));
const stall = mode === "stall" || (mode === "stall-once" && !existsSync(marker));
if (mode === "stall-once") writeFileSync(marker, "1");
let frame = 0;
const timer = setInterval(() => {
  if (frame < 3 || !stall) frame++;
  process.stdout.write(`Rendered ${frame}/10, time remaining: 1s\r`);
  if (!stall && frame >= 10) {
    clearInterval(timer);
    grandchild.kill();
    process.stdout.write("\nEncoded 10/10\n");
    process.exit(0);
  }
}, 20);
