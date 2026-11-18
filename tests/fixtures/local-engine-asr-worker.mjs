// Injected protocol fixture with native word rows; never model inference or ASR quality evidence.
import fs from 'node:fs';
let bytes='';
for await(const chunk of process.stdin)bytes+=chunk;
const request=JSON.parse(bytes),mode=fs.readFileSync(request.config.modelPath,'utf8').trim();
if(process.argv.includes('--probe')){console.log(JSON.stringify({available:true,engine:request.config.engine,versions:{fixture:'protocol-only'}}));process.exit(0);}
fs.appendFileSync(request.config.modelPath+'.runs','x');
if(mode==='fail'){console.error('Injected engine failure');process.exit(1);}
const rows=[{text:' Привет',offsets:{from:100,to:400}},{text:' мир.',offsets:{from:400,to:700}},{text:' [BLANK_AUDIO]',offsets:{from:700,to:900}}];
const lexical=rows.filter(row=>row.text.trim());
const output=mode==='collapsed'
 ?{segments:[{text:lexical.map(row=>row.text.trim()).join(' '),startSec:.1,endSec:.9}],wordTimings:{status:'unavailable',reason:'Native lexical rows are collapsed or ambiguous',version:1,method:'native-word-segments-v1',estimated:true,reviewRequired:true,rawRows:rows}}
 :{segments:lexical.map(row=>({text:row.text.trim(),startSec:row.offsets.from/1000,endSec:row.offsets.to/1000})),wordTimings:{status:'available',version:1,method:'native-word-segments-v1',estimated:true,reviewRequired:true,rawRows:rows}};
console.log(JSON.stringify({version:1,key:request.key,offline:true,output}));
