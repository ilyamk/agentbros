// Injected protocol fixture, never model inference or semantic/ASR quality evidence.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
let bytes='';
for await(const chunk of process.stdin)bytes+=chunk;
const request=JSON.parse(bytes),mode=fs.readFileSync(request.config.modelPath,'utf8').trim();
if(process.argv.includes('--probe')){if(mode==='runtime-missing'){console.error('Installed dependency missing');process.exit(1);}console.log(JSON.stringify({available:true,engine:request.config.engine,versions:{fixture:'protocol-only'}}));process.exit(0);}
if(process.env.FAL_KEY || process.env.ELEVENLABS_API_KEY)process.exit(8);
if(mode==='timeout') { const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); fs.writeFileSync(request.config.modelPath+'.pid',String(child.pid)); setInterval(()=>{},1000); }
else if(mode==='overflow') process.stdout.write('x'.repeat(17*1024*1024));
else {
  const output=request.payload.operation==='asr'?{segments:[{text:'Product works.',startSec:.2,endSec:1},{text:'Under stated conditions.',startSec:.9,endSec:1.4}]}:{vectors:request.payload.texts.map(()=>[1,0])};
  if(mode==='ok' && request.payload.operation==='asr')output.segments[1].startSec=1;
  if(mode==='out-of-bounds' && request.payload.operation==='asr')output.segments[1].endSec=999;
  if(mode==='bad-vector')output.vectors=[[0,0]];
  if(mode==='missing-vector')output.vectors=[];
  if(mode==='offline-env' && (process.env.HF_HUB_OFFLINE!=='1' || process.env.TRANSFORMERS_OFFLINE!=='1'))process.exit(5);
  console.log(JSON.stringify({version:1,key:mode==='wrong-key'?'stale':request.key,offline:true,output}));
  if(mode==='extra-line')console.log('{}');
}
