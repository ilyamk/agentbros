import fs from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);
if(process.env.FAL_KEY||process.env.ELEVENLABS_API_KEY)throw Error('Credentials leaked');
if(process.argv.includes('--probe')){console.log(JSON.stringify({available:true,engine:'whisper.cpp',versions:{fixture:'native-protocol-only'}}));process.exit(0);}
const rawRows=[{text:'',offsets:{from:0,to:20}},{text:' Привет,',offsets:{from:20,to:600}},{text:' world.',offsets:{from:600,to:1800}}];
const mode=fs.readFileSync(request.config.modelPath,'utf8');if(mode==='short')rawRows[2].offsets.to=610;
const segments=rawRows.filter(r=>r.text.trim()).map(r=>({text:r.text.trim(),startSec:r.offsets.from/1000,endSec:r.offsets.to/1000}));
const output={segments};if(request.config.wordTimingMethod)output.wordTimings={version:1,method:request.config.wordTimingMethod,status:'available',estimated:true,reviewRequired:true,rawRows};
if(mode==='unavailable'&&output.wordTimings){rawRows[1].offsets.to=20;output.wordTimings.status='unavailable';output.wordTimings.reason='Collapsed native row';output.segments=[{text:'Привет, world.',startSec:.02,endSec:1.8}];}
if(fs.readFileSync(request.config.modelPath,'utf8')==='bad'&&output.wordTimings)output.wordTimings.rawRows[2].offsets.from=1;
console.log(JSON.stringify({version:1,key:request.key,offline:true,output}));
