/** C23 SOURCE preparation only; importing exports does not load compilers or build. */
function patchSourceSelection(text) {
 const contract=require('./instances-selection-contract.json');
 const original=contract.original,replacement=contract.replacement,start=text.indexOf(original);
 if(start<0||text.indexOf(original,start+original.length)>=0)throw Error('Exact source-selection hook count mismatch');
 return {text:text.slice(0,start)+replacement+text.slice(start+original.length),replacement:{start,end:start+original.length,original,text:replacement}};
}
module.exports={patchSourceSelection};
/** C23 source preparation only. Importing exports never loads esbuild or executes a build. */
function patchInertStyleSource(text) {
 const original='  doc.head.appendChild(style);';
 const replacement='  if (__avcClock.instanceMode === true) __avcClock.instanceRegisterInertStyle(style);\n'+original;
 const start=text.indexOf(original);
 if(start<0||text.indexOf(original,start+original.length)>=0)throw Error('Exact inert-style source hook count mismatch');
 return {text:text.slice(0,start)+replacement+text.slice(start+original.length),replacement:{start,end:start+original.length,original,text:replacement}};
}

function main(){
/** Source-exact offline instance feasibility build. Does NOT enable a product protocol. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module'),{spawnSync}=require('node:child_process');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const [source,deps,esbuildModule,output,record]=process.argv.slice(2);
if(!source||!deps||!esbuildModule||!output||record&&record!=='--record-receipt')throw Error('Usage: prepare-instances-selection.cjs SOURCE PRIVATE_DEPS ESBUILD_MODULE OUTPUT [--record-receipt]');
const dir=__dirname,originalPath=path.join(dir,'provenance.json'),treePath=path.join(dir,'tree-provenance.json'),original=JSON.parse(fs.readFileSync(originalPath)),tree=JSON.parse(fs.readFileSync(treePath)),root=fs.realpathSync(source),dependencyRoot=fs.realpathSync(deps);
const receiptPath=path.join(dir,'instances-selection-provenance.json'),contractPath=path.join(dir,'instances-selection-contract.json');
if(hash(fs.readFileSync(contractPath))!=='5c3882a193714b74af5e0c6d95b6c47fad909aa06fe4a69b8e6d60ab7602c535')throw Error('Immutable C23 source contract mismatch');
const c21Path=path.join(dir,'instances-provenance.json'),c21=JSON.parse(fs.readFileSync(c21Path));
const c22Path=path.join(dir,'instances-style-provenance.json'),c22=JSON.parse(fs.readFileSync(c22Path));
const selectionContract=JSON.parse(fs.readFileSync(contractPath));
for(const [file,sha] of Object.entries(selectionContract.predecessors))if(hash(fs.readFileSync(path.join(dir,file)))!==sha)throw Error('Immutable C23 predecessor mismatch: '+file);

if(hash(fs.readFileSync(c21Path))!=='a0424ba78fa6fd61df033fe400020ee818550badeb44be0c34259908658ca82d'||hash(fs.readFileSync(path.join(dir,'prepare-instances.cjs')))!=='753a6d1b8fb0c49d4f19a4a43d9ec9d64082f62b26167341680687c0e12a3a73')throw Error('Immutable C21 predecessor mismatch');
if(fs.existsSync(output))throw Error('C23 output already exists; never overwrite prior bundles');
if(record==='--record-receipt'&&fs.existsSync(receiptPath))throw Error('C23 receipt already exists; never overwrite prior provenance');
if(hash(fs.readFileSync(originalPath))!=='1b47fb8cb6eebe5c6fc9c8b2c62a1e25090aab4dd6f0e9326b93d1b6dff25158'||hash(fs.readFileSync(treePath))!=='4e99d33491725d499879b27d7e036303d7236d4a1eedce6eefca1ca4d8632027')throw Error('Immutable predecessor receipt mismatch');
const licences={};
for(const [name,pin]of Object.entries(original.packages))if(pin.notice){const sha=hash(fs.readFileSync(path.join(dir,pin.notice)));if(sha!==pin.noticeSha256)throw Error('Original licence notice mismatch: '+name);licences[name]={license:pin.license,sha256:sha};}
const apache=hash(fs.readFileSync(path.resolve(dir,'../../../vendor/hyperframes/LICENSE')));
if(apache!=='4259155fb06f127687ee7b0a8a3682d45132db0f2da26cbc0b7a2d1e796436b8')throw Error('Original Apache licence mismatch');
licences.hyperframes={license:'Apache-2.0',sha256:apache};
if(hash(fs.readFileSync(path.join(dir,'prepare-tree.cjs')))!==tree.patchToolSha256)throw Error('Predecessor patch recipe mismatch');
if(tree.originalReceiptSha256!==hash(fs.readFileSync(originalPath))||tree.sourceClosureSha256!==original.sourceClosureSha256)throw Error('Predecessor original receipt mismatch');
if(tree.engineSha256!=='88f3e5288737e752468d1bb11ca9afe43a31404fefe5f827b5cac37866e585eb')throw Error('Predecessor tree runtime pin mismatch');
for(const [name,sha]of Object.entries(original.files)){
 const file=name.startsWith('source/')?path.join(root,name.slice(7)):path.join(dependencyRoot,name.slice(13));
 if(hash(fs.readFileSync(file))!==sha)throw Error('Original audit input mismatch: '+name);
}
const esbuildPath=path.resolve(esbuildModule),esbuild=require(esbuildPath),buildRequire=createRequire(esbuildPath);
if(esbuild.version!==original.esbuild)throw Error('Pinned esbuild version required');
const binaryPath=buildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
const nativeVersion=spawnSync(binaryPath,['--version'],{encoding:'utf8',timeout:2000,maxBuffer:16384});
if(nativeVersion.status!==0||nativeVersion.stdout.trim()!==esbuild.version||nativeVersion.stderr)throw Error('Pinned native esbuild version required');
const manifests={};
const manifestNames=['@chenglou/pretext/package.json','acorn/package.json','acorn-walk/package.json','nanoid/package.json','nanoid/async/package.json','nanoid/non-secure/package.json','nanoid/url-alphabet/package.json','picocolors/package.json','postcss/package.json','source-map-js/package.json','typescript/package.json'];
for(const name of manifestNames)manifests['dependencies/'+name]=hash(fs.readFileSync(path.join(dependencyRoot,name)));
for(const name of ['packages/core/package.json','packages/parsers/package.json'])manifests['source/'+name]=hash(fs.readFileSync(path.join(root,name)));
manifests['private-dependency-package.json']=hash(fs.readFileSync(path.resolve(dependencyRoot,'../package.json')));
manifests['esbuild/package.json']=hash(fs.readFileSync(path.join(path.dirname(esbuildPath),'../package.json')));
manifests['esbuild-platform/package.json']=hash(fs.readFileSync(path.join(path.dirname(binaryPath),'../package.json')));
if(record!=='--record-receipt'&&JSON.stringify(Object.entries(manifests).sort())!==JSON.stringify(Object.entries(JSON.parse(fs.readFileSync(receiptPath)).resolutionManifests).sort()))throw Error('Pinned resolution manifest mismatch');
const browser=JSON.parse(fs.readFileSync(path.join(dependencyRoot,'postcss/package.json'))).browser;
if(JSON.stringify(browser)!==JSON.stringify({'./lib/terminal-highlight':false,'source-map-js':false,path:false,url:false,fs:false}))throw Error('Exact retained PostCSS browser mapping required');
const allowedDisabled=new Map([[path.join(dependencyRoot,'postcss/lib/terminal-highlight'),'./lib/terminal-highlight'],['source-map-js','source-map-js'],[path.join(dependencyRoot,'source-map-js/source-map.js'),'source-map-js'],['path','path'],['url','url'],['fs','fs']]);
const virtualInputs={};
const parser=JSON.parse(fs.readFileSync(path.join(root,'packages/parsers/package.json'))),patches={},loaded={};
function applyPredecessor(relative,text){
 const patch=tree.patches[relative];if(!patch)return text;
 if(hash(text)!==patch.originalSha256)throw Error('Predecessor original source mismatch: '+relative);
 const edits=[...patch.replacements].sort((a,b)=>b.start-a.start);
 for(const edit of edits){if(text.slice(edit.start,edit.end)!==edit.original)throw Error('Predecessor exact source mismatch: '+relative);text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);}
 return 'import __avcClock from "avc-private-clock";\n'+text;
}
function adapt(relative,intermediate){
 let text=intermediate;const replacements=[];
 const replace=(before,after,count=1)=>{
  const matches=[];let start=0;while((start=text.indexOf(before,start))>=0){matches.push(start);start+=before.length;}
  if(matches.length!==count)throw Error('Exact instance patch count mismatch: '+relative+' '+before.slice(0,65));
  for(const start of [...matches].reverse()){replacements.push({start,end:start+before.length,original:before,text:after});text=text.slice(0,start)+after+text.slice(start+before.length);}
 };
 const active='__avcClock.instanceMode === true';
 if(relative==='packages/core/src/runtime/compositionLoader.ts'){
  replace('const response = await __avcClock.fetch(src);',`const response = await (${active} ? __avcClock.instanceFetch(host, src) : __avcClock.fetch(src));`);
  replace('            params.compositionUrl?.href,\n          );',`            params.compositionUrl?.href,\n            ${active},\n          );`);
  replace('        document.body.appendChild(injectedScript);',`        if (${active}) __avcClock.instanceArmScript(host, injectedScript);\n        document.body.appendChild(injectedScript);`);
  replace('  __avcClock.treeGuard("mounted", [...mountedHosts]);',`  __avcClock.treeGuard("mounted", [...mountedHosts]);\n  if (${active}) __avcClock.instancePrepareMedia(assignMediaRenderIds);`);
  replace('import __avcClock from "avc-private-clock";',`import __avcClock from "avc-private-clock";\nimport { assignMediaRenderIds } from "../compiler/mediaRenderIds";`);
 }
 if(relative==='packages/core/src/compiler/compositionScoping.ts'){
  replace('  authoredRootId?: string | null,\n  compositionSrc?: string | null,\n): string {','  authoredRootId?: string | null,\n  compositionSrc?: string | null,\n  instanceScoped = false,\n): string {');
  replace('  var __hfCompId = ${compositionIdLiteral};',`  var __hfInstanceAuthority = null;\n  if (\${instanceScoped ? "true" : "false"}) {\n    var __hfAcquire = window.__avcPrivateInstanceAcquire;\n    delete window.__avcPrivateInstanceAcquire;\n    if (typeof __hfAcquire !== "function") throw Error("Missing private instance authority");\n    __hfInstanceAuthority = __hfAcquire(document.currentScript);\n    if (!__hfInstanceAuthority || !__hfInstanceAuthority.registry || typeof __hfInstanceAuthority.fail !== "function") throw Error("Invalid private instance authority");\n  }\n  var __hfCompId = \${compositionIdLiteral};`);
  replace('  var __hfGetTimelineRegistry = function() {','  var __hfGetTimelineRegistry = function() {\n    if (__hfInstanceAuthority) return __hfInstanceAuthority.registry;');
  replace('          if (prop === "__timelines") {','          if (prop === "__timelines") {\n            if (__hfInstanceAuthority) return __hfInstanceAuthority.fail("Instance registry replacement unsupported");');
  replace('    } catch (_err) {\n      console.error(__hfErrorLabel, __hfCompId, _err);','    } catch (_err) {\n      if (__hfInstanceAuthority) __hfInstanceAuthority.fail(_err);\n      console.error(__hfErrorLabel, __hfCompId, _err);');
 }
 if(relative==='packages/core/src/runtime/clipTree.ts'){
  replace('  return (el as HTMLElement).id || el.getAttribute("data-hf-id") || null;',`  if (${active}) {\n    const identity = __avcClock.instanceClipId(el);\n    if (identity !== null && (typeof identity !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(identity))) throw Error("Invalid private instance clip identity");\n    return identity;\n  }\n  return (el as HTMLElement).id || el.getAttribute("data-hf-id") || null;`);
 }
 if(relative==='packages/core/src/runtime/timeline.ts'){
  replace('          if (!childEl.id) continue;',`          if (!(${active} ? stableClipId(childEl) : childEl.id)) continue;`);
  replace('sceneElements.set(childEl, { id: childEl.id, start: Infinity, end: -Infinity });',`sceneElements.set(childEl, { id: (${active} ? stableClipId(childEl)! : childEl.id), start: Infinity, end: -Infinity });`);
  replace('if (gsapClipIds.has(el.id)) continue;',`if (gsapClipIds.has(${active} ? stableClipId(el) : el.id)) continue;`,2);
  replace('id: el.id,',`id: (${active} ? stableClipId(el)! : el.id),`,2);
  replace('gsapClipIds.add(el.id);',`gsapClipIds.add(${active} ? stableClipId(el) : el.id);`,2);
  replace('      if (!el.id) continue;',`      if (!(${active} ? stableClipId(el) : el.id)) continue;`);
  replace('        swallow("runtime.timeline.site1", err);',`        if (${active}) throw err;\n        swallow("runtime.timeline.site1", err);`);
 }
 if(relative==='packages/core/src/audioGroups.ts'){const patch=patchInertStyleSource(text);replacements.push(patch.replacement);text=patch.text;}
 if(!replacements.length)return intermediate;
 if(!tree.patches[relative])text='import __avcClock from "avc-private-clock";\n'+text;
 patches[relative]={originalSha256:original.files['source/'+relative],intermediateSha256:hash(intermediate),outputSha256:hash(text),addedPrivateClockImport:!tree.patches[relative],replacements};
 if(relative==='packages/core/src/runtime/compositionLoader.ts'){
  const beforeSelection=text,selection=patchSourceSelection(text);text=selection.text;
  patches[relative].selectionPredecessorOutputSha256=hash(beforeSelection);
  patches[relative].replacements.push(selection.replacement);patches[relative].outputSha256=hash(text);
 }

 return text;
}
const plugin={name:'source-exact-instance-feasibility',setup(build){
 build.onResolve({filter:/^avc-private-clock$/},()=>({path:'host',namespace:'avc-clock'}));
 build.onLoad({filter:/.*/,namespace:'avc-clock'},()=>({contents:'const clock=window.__avcPrivateEngineClock;delete window.__avcPrivateEngineClock;if(!clock)throw Error("Missing private host clock");export default clock;',loader:'js'}));
 build.onLoad({filter:/\.ts$/},args=>{
  if(!args.path.startsWith(root+'/'))return;
  const relative=path.relative(root,args.path),text=fs.readFileSync(args.path,'utf8');
  if(original.files['source/'+relative]!==hash(text))throw Error('Unaudited original loaded source: '+relative);
  loaded['source/'+relative]=hash(text);const intermediate=applyPredecessor(relative,text),transformed=adapt(relative,intermediate);
  if(transformed===text)return;return{contents:transformed,loader:'ts'};
 });
}};
esbuild.build({entryPoints:[root+'/packages/core/src/runtime/entry.ts'],bundle:true,write:false,metafile:true,platform:'browser',format:'iife',target:'es2020',minify:true,nodePaths:[dependencyRoot],alias:Object.fromEntries(Object.entries(parser.exports).filter(([,v])=>v?.import).map(([k,v])=>['@hyperframes/parsers'+(k==='.'?'':k.slice(1)),path.resolve(root,'packages/parsers',v.import)])),plugins:[plugin]}).then(result=>{
 for(const filename of Object.keys(result.metafile.inputs)){
  if(filename==='avc-clock:host')continue;
  if(filename.startsWith('(disabled):')){
   const raw=filename.slice(11),target=allowedDisabled.get(raw)??allowedDisabled.get(path.resolve(raw)),meta=result.metafile.inputs[filename];
   if(!target||browser[target]!==false||meta.bytes!==0||meta.imports.length!==0)throw Error('Unaudited disabled virtual input: '+filename);
   virtualInputs[target]={bytes:0,imports:[],mappingManifest:'dependencies/postcss/package.json'};continue;
  }
  const absolute=path.resolve(filename),name=absolute.startsWith(root+'/')?'source/'+path.relative(root,absolute):absolute.startsWith(dependencyRoot+'/')?'dependencies/'+path.relative(dependencyRoot,absolute):null;
  if(!name||!Object.hasOwn(original.files,name)||hash(fs.readFileSync(absolute))!==original.files[name])throw Error('Unaudited build input: '+filename);
  loaded[name]=original.files[name];
 }
 const counts=Object.fromEntries(Object.entries(patches).map(([name,p])=>[name,p.replacements.length]));
 const expected={'packages/core/src/runtime/compositionLoader.ts':6,'packages/core/src/compiler/compositionScoping.ts':5,'packages/core/src/runtime/clipTree.ts':1,'packages/core/src/runtime/timeline.ts':10,'packages/core/src/audioGroups.ts':1};
 if(JSON.stringify(Object.entries(counts).sort())!==JSON.stringify(Object.entries(expected).sort()))throw Error('Exact instance patch inventory mismatch');
 const predecessorPatch=(name)=>{
  const p=patches[name];if(name!=='packages/core/src/runtime/compositionLoader.ts')return p;
  const {selectionPredecessorOutputSha256,...rest}=p;
  return {...rest,outputSha256:selectionPredecessorOutputSha256,replacements:rest.replacements.slice(0,-1)};
 };
 for(const[name,p]of Object.entries(c21.patches))if(JSON.stringify(predecessorPatch(name))!==JSON.stringify(p))throw Error('C21 exact predecessor replacement changed: '+name);
 for(const[name,p]of Object.entries(c22.patches))if(JSON.stringify(predecessorPatch(name))!==JSON.stringify(p))throw Error('C22 exact predecessor replacement changed: '+name);
 const bytes=result.outputFiles[0].contents;if(bytes.length>1024*1024)throw Error('Instance artifact byte bound');
 const receipt={profile:'static-local-instances-v1',status:'source-build-only-not-product-enabled',inertStyleContract:'private-owned-inert-style-v1',inertStyleContractSha256:hash(fs.readFileSync(path.join(dir,'instances-style-contract.json'))),sourceRootSelectionContract:'private-owned-source-root-v1',sourceRootSelectionContractSha256:hash(fs.readFileSync(contractPath)),c22ReceiptSha256:hash(fs.readFileSync(c22Path)),c22RecipeSha256:hash(fs.readFileSync(path.join(dir,'prepare-instances-style.cjs'))),c22RuntimeSha256:c22.engineSha256,c21ReceiptSha256:hash(fs.readFileSync(c21Path)),c21RecipeSha256:hash(fs.readFileSync(path.join(dir,'prepare-instances.cjs'))),c21RuntimeSha256:c21.engineSha256,originalReceiptSha256:hash(fs.readFileSync(originalPath)),predecessorReceiptSha256:hash(fs.readFileSync(treePath)),predecessorRuntimeSha256:tree.engineSha256,sourceClosureSha256:original.sourceClosureSha256,patchToolSha256:hash(fs.readFileSync(__filename)),esbuild:{version:esbuild.version,nativeVersion:nativeVersion.stdout.trim(),apiSha256:hash(fs.readFileSync(esbuildPath)),binarySha256:hash(fs.readFileSync(binaryPath))},resolutionManifests:Object.fromEntries(Object.entries(manifests).sort()),virtualInputs:Object.fromEntries(Object.entries(virtualInputs).sort()),licences:Object.fromEntries(Object.entries(licences).sort()),buildOptions:{bundle:true,metafile:true,write:false,platform:'browser',format:'iife',target:'es2020',minify:true,entry:'packages/core/src/runtime/entry.ts',parserAliases:Object.keys(parser.exports).filter(k=>parser.exports[k]?.import).sort()},engineSha256:hash(bytes),engineBytes:bytes.length,loaded:Object.fromEntries(Object.entries(loaded).sort()),patches:Object.fromEntries(Object.entries(patches).sort())};
 if(record==='--record-receipt')fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 else if(JSON.stringify(receipt)!==JSON.stringify(JSON.parse(fs.readFileSync(receiptPath))))throw Error('Pinned instance artifact/patch receipt mismatch');
 fs.writeFileSync(output,bytes,{flag:'wx'});process.stdout.write(JSON.stringify({ok:true,sha256:hash(bytes),bytes:bytes.length,patchCounts:counts,loadedInputs:Object.keys(loaded).length})+'\n');
}).catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});

}
if(require.main===module)main();
