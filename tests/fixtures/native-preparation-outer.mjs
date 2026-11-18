import {runBoundedRenderWorker} from '../../src/lib/longform/bounded-worker.ts';
import {writeFileSync} from 'node:fs';
const controller=new AbortController();
let task;
process.once('SIGTERM',()=>{
 controller.abort();
 void (async()=>{try{await task;}catch{}process.exit(143);})();
});
task=runBoundedRenderWorker(process.execPath,['-e',`setTimeout(()=>{process.send({type:'owned-processes',processes:[]});process.on('message',()=>require('node:fs').writeFileSync(process.argv[1],'activated'));},3000);setInterval(()=>{},100);`,process.argv[3]],process.cwd(),{
 timeoutMs:5000,stallTimeoutMs:5000,signal:controller.signal,
 onRegisteredRoot:async(pid)=>{writeFileSync(process.argv[2],String(pid));await new Promise(()=>{});},
});
try{await task;}catch{process.exitCode=1;}
