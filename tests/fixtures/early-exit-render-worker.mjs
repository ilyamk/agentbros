import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
import {registerOwnedRenderProcesses} from "../../src/lib/longform/bounded-worker.ts";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"], {detached: true, stdio: "ignore"});
writeFileSync(process.argv[2], String(child.pid));
await registerOwnedRenderProcesses();
process.exit(Number(process.argv[3]));
