// Hermetic declared classifier, never actual AppleVision evidence.
import {readFileSync,writeFileSync,renameSync,symlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input),mode=readFileSync(process.argv[2],'utf8');
const ids=['cat','dog'];
const runtime={engine:'apple-vision-classification',osVersion:'hermetic-declaration',revision:2,inputPolicy:'classification-framework-default/full-image-region-v1',regionOfInterest:{x:0,y:0,width:1,height:1},cpuOnly:true,orientationPolicy:'validated-jpeg-png-exif-1-through-8-v1',taxonomy:{identifiers:ids,hash:createHash('sha256').update(ids.join('\n')).digest('hex')}};
if(request.operation==='probe'){if(mode==='bad-taxonomy')runtime.taxonomy.identifiers=['dog','cat'];console.log(JSON.stringify(runtime));process.exit(0);}
if(mode==='timeout'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);writeFileSync(process.argv[2]+'.pid',String(child.pid));setInterval(()=>{},1000);}else{
 const output={version:1,key:request.key,runtime,frames:request.frames.map((f,i)=>({hash:f.hash,width:320,height:180,observations:i?[{identifier:'dog',score:.9}]:[{identifier:'cat',score:0},{identifier:'dog',score:.1}]}))};
 if(mode==='swap-frame-parent'){const parent=path.dirname(request.frames[0].file),retained=parent+'.retained';renameSync(parent,retained);symlinkSync(retained,parent);}
 if(mode==='wrong-key')output.key='a'.repeat(64);
 if(mode==='missing-frame')output.frames.pop();
 if(mode==='wrong-hash')output.frames[0].hash='a'.repeat(64);
 if(mode==='wrong-policy')output.runtime.inputPolicy='scaleFill';
 if(mode==='wrong-region')output.runtime.regionOfInterest.width=.5;
 if(mode==='legacy-crop'){delete output.runtime.inputPolicy;delete output.runtime.regionOfInterest;output.runtime.crop='scaleFill';}
 if(mode==='wrong-runtime')output.runtime.osVersion='changed';
 if(mode==='unknown-label')output.frames[0].observations[0].identifier='unknown';
 if(mode==='duplicate-label')output.frames[0].observations.push(output.frames[0].observations[0]);
 if(mode==='wrong-order')output.frames[0].observations.reverse();
 if(mode==='negative-score')output.frames[0].observations[0].score=-1;
 if(mode==='oversized')output.frames[0].width=4097;
 if(mode==='empty')output.frames=[];
 if(mode==='overflow')console.log('x'.repeat(8*1024*1024+1));else console.log(JSON.stringify(output));
 if(mode==='extra-line')console.log('{}');
}
