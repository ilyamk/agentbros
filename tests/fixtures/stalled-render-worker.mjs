import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"], {detached: true, stdio: "ignore"});
process.on("SIGTERM", () => {
  if (process.argv[4] === "late") setTimeout(() => {
    const late = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"], {detached: true, stdio: "ignore"});
    writeFileSync(process.argv[2], JSON.stringify({worker: process.pid, detached: child.pid, late: late.pid}));
  }, 950);
});
writeFileSync(process.argv[2], JSON.stringify({worker: process.pid, detached: child.pid}));
if (process.argv[3]) writeFileSync(process.argv[3], "partial unverified render");
setInterval(() => process.send?.({renderedFrames: 849, encodedFrames: 810}), 100);
