import fs from 'node:fs';
import { spawn } from 'node:child_process';
let bytes='';for await(const chunk of process.stdin)bytes+=chunk;
const input=JSON.parse(bytes), mode=fs.readFileSync(process.argv[2],'utf8');
const runtime={engine:'apple-vision',osVersion:'injected protocol fixture only',revision:3,supportedLanguages:['en-US','ru-RU']};
if(input.operation==='probe'){console.log(JSON.stringify(runtime));process.exit(0);}
if(mode==='timeout'){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2]+'.pid',String(child.pid));setInterval(()=>{},1000);
}else if(mode==='overflow'){process.stdout.write('x'.repeat(300000));}
else {
 const observations=[{text:mode==='empty'?'':'FRAME NOT DELETED',confidence:.8,box:{x:.1,y:.2,width:.8,height:.2}}];
 if(mode==='box')observations[0].box.x=.5;
 const output={version:1,key:mode==='wrong-key'?'a'.repeat(64):input.key,runtime,frames:input.frames.map(frame=>({hash:frame.hash,width:320,height:180,observations}))};
 if(mode==='missing-frame')output.frames.pop();if(mode==='wrong-hash')output.frames[0].hash='b'.repeat(64);
 if(mode==='wrong-runtime')output.runtime={...runtime,osVersion:'different'};
 console.log(JSON.stringify(output));if(mode==='extra-line')console.log('{}');
}
