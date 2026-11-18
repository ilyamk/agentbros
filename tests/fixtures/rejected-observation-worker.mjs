import fs from 'node:fs';
let bytes='';for await(const chunk of process.stdin)bytes+=chunk;const request=JSON.parse(bytes);
if(process.env.FAL_KEY||process.env.ELEVENLABS_API_KEY)throw Error('Credentials leaked');
if(process.argv.includes('--probe')){console.log(JSON.stringify({available:true,engine:'whisper.cpp',versions:{fixture:'quarantine-protocol-only'}}));process.exit(0);}
const mode=JSON.parse(fs.readFileSync(request.config.modelPath,'utf8'));
if(mode.mutate)fs.appendFileSync(mode.mutate,'changed');
if(mode.type==='timeout'){setTimeout(()=>{},5000);await new Promise(()=>{});}
if(mode.type==='exit'){console.error('failed');process.exit(1);}
if(mode.type==='oversize'){process.stdout.write(Buffer.alloc(16*1024*1024+1,120));process.exit(0);}
const rawRows=[{text:' Keep',offsets:{from:0,to:500}},{text:' not',offsets:{from:mode.type==='valid'?500:400,to:900}}];
const output={segments:request.config.wordTimingMethod?rawRows.map(r=>({text:r.text.trim(),startSec:r.offsets.from/1000,endSec:r.offsets.to/1000})):[{text:'Keep not.',startSec:0,endSec:mode.type==='valid'?1:2.02}]};
if(request.config.wordTimingMethod)output.wordTimings={version:1,method:'native-word-segments-v1',status:'available',estimated:true,reviewRequired:true,rawRows};
if(mode.type==='structural')output.wordTimings.rawRows[0].offsets.to='ASR spans overlap or exceed original source clock';
const reply={version:1,key:mode.type==='key'?'0'.repeat(64):request.key,offline:mode.type==='offline'?false:true,output};
console.log(mode.type==='json'?'not-json':JSON.stringify(reply));if(mode.type==='lines')console.log('{}');
