import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let input='';for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input),mode=readFileSync(process.argv[2],'utf8');
const runtime={engine:'apple-vision-feature-print',osVersion:'hermetic-declaration',revision:2,crop:'scaleFill',cpuOnly:true,orientationPolicy:'validated-jpeg-png-exif-1-through-8-v1'};
if(request.operation==='probe'){console.log(JSON.stringify(runtime));process.exit(0);}
if(mode==='timeout'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);writeFileSync(process.argv[2]+'.pid',String(child.pid));setInterval(()=>{},1000);}else{
 const output={version:1,key:request.key,runtime,queryFeatureHash:'c'.repeat(64),frames:request.frames.map((frame,i)=>({hash:frame.hash,width:320,height:180,featureHash:'d'.repeat(64),distance:i?0.1:1}))};
 if(mode==='wrong-key')output.key='a'.repeat(64);
 if(mode==='missing-frame')output.frames.pop();
 if(mode==='wrong-hash')output.frames[0].hash='a'.repeat(64);
 if(mode==='wrong-orientation')output.runtime.orientationPolicy='upright-only';
 if(mode==='wrong-runtime')output.runtime.osVersion='changed';
 if(mode==='negative-distance')output.frames[0].distance=-1;
 if(mode==='oversized')output.frames[0].width=4097;
 if(mode==='empty')output.frames=[];
 if(mode==='overflow')console.log('x'.repeat(300000));else console.log(JSON.stringify(output));
 if(mode==='extra-line')console.log('{}');
}
