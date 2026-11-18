/** Offline staged feasibility build; no shipped protocol. Binds original and exact tree patch receipts. */
const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [source,deps,esbuildModule,typescriptModule,output,recordReceipt]=process.argv.slice(2);
if(!source||!deps||!esbuildModule||!typescriptModule||!output)throw Error('Usage: node prepare-tree.cjs SOURCE PRIVATE_DEPS ESBUILD_MODULE TYPESCRIPT_MODULE OUTPUT.js');
const pin=require('./provenance.json'),patchedPin=require('./patched-provenance.json'),mediaReceiptPath=path.join(__dirname,'tree-provenance.json'),mediaPin=recordReceipt==='--record-receipt'?null:require(mediaReceiptPath),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const [name,sha]of Object.entries(pin.files)){
 const file=name.startsWith('source/')?path.join(source,name.slice(7)):path.join(deps,name.slice(13));
 if(hash(fs.readFileSync(file))!==sha)throw Error('Original audit input mismatch: '+name);
}
const esbuild=require(path.resolve(esbuildModule)),ts=require(path.resolve(typescriptModule));
if(esbuild.version!==pin.esbuild||ts.version!==patchedPin.typescript.version)throw Error('Pinned build versions required');
if(hash(fs.readFileSync(require.resolve(path.resolve(typescriptModule))))!==patchedPin.typescript.apiSha256)throw Error('TypeScript API hash mismatch');
const root=fs.realpathSync(source),parser=JSON.parse(fs.readFileSync(root+'/packages/parsers/package.json')),patches={};
const exported=new Set(['__player','__playerReady','__renderReady','__clipManifest','__hfWaitForSeekCompletion','__hfRuntimeTeardown']);
const clocks=new Set(['setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','fetch']);
const plugin={name:'explicit-private-host-clock-static-tree',setup(build){
 build.onResolve({filter:/^avc-private-clock$/},()=>({path:'host',namespace:'avc-clock'}));
 build.onLoad({filter:/.*/,namespace:'avc-clock'},()=>({contents:'const clock=window.__avcPrivateEngineClock;delete window.__avcPrivateEngineClock;if(!clock)throw Error("Missing private host clock");export default clock;',loader:'js'}));
 build.onLoad({filter:/\.ts$/},args=>{
  if(!args.path.startsWith(root+'/'))return;
  const text=fs.readFileSync(args.path,'utf8'), ast=ts.createSourceFile(args.path,text,ts.ScriptTarget.Latest,true),replacements=[];
  if(args.path.endsWith('/runtime/compositionLoader.ts')){
   const replaceExact=(original,replacement)=>{const start=text.indexOf(original);if(start<0||text.indexOf(original,start+original.length)>=0)throw Error('Exact tree source patch mismatch: '+original.slice(0,80));replacements.push({start,end:start+original.length,text:replacement,original});};
   replaceExact('async function mountExternalCompositions(\n  params: LoadCompositionsParams,\n): Promise<MountedComposition[]> {','async function mountExternalCompositions(\n  params: LoadCompositionsParams,\n  mountedHosts: ReadonlySet<Element> = new Set(),\n): Promise<MountedComposition[]> {');
   replaceExact('const hostIdentityByElement = assignRuntimeCompositionIds(trackedHosts, new Set());','const hostIdentityByElement = assignRuntimeCompositionIds(trackedHosts, mountedHosts);');
   replaceExact('const hosts = trackedHosts.filter((host) => host.hasAttribute("data-composition-src"));','const hosts = trackedHosts.filter((host) => host.hasAttribute("data-composition-src") && !mountedHosts.has(host));\n  __avcClock.treeGuard("before-mount", hosts);');
   replaceExact('const external = await mountExternalCompositions(params);',`const external: MountedComposition[] = [];
  const mountedHosts = new Set<Element>();
  for (let depth = 0; depth < 3; depth++) {
    const next = await mountExternalCompositions(params, mountedHosts);
    if (!next.length) break;
    for (const composition of next) mountedHosts.add(composition.host);
    if (mountedHosts.size > 16) throw Error("Static tree loaded host count bound");
    external.push(...next);
  }
  if (getTrackedCompositionHosts().some(host => host.hasAttribute("data-composition-src") && !mountedHosts.has(host))) throw Error("Static tree unmounted external host/depth bound");
  __avcClock.treeGuard("mounted", [...mountedHosts]);`);
   replaceExact('await Promise.all(external.map((composition) => composition.runScripts()));','for (const composition of external) await composition.runScripts();\n  __avcClock.treeGuard("scripts-complete", [...mountedHosts]);');
  }
  if(args.path.endsWith('/runtime/init.ts')){
   const replaceExact=(original,replacement)=>{const start=text.indexOf(original);if(start<0||text.indexOf(original,start+original.length)>=0)throw Error('Exact sanitizer source patch mismatch');replacements.push({start,end:start+original.length,text:replacement,original});};
   const before='    for (const node of compositionNodes) {\n      // Preserve explicit root duration';
   replaceExact(before,'    const __avcNormalizationNodes = compositionNodes.filter(node => node !== rootEl);\n    __avcClock.treeNormalize("before", __avcNormalizationNodes);\n'+before);
   const after='      node.removeAttribute("data-end");\n    }\n  };\n\n  const applyClipLayout';
   replaceExact(after,'      node.removeAttribute("data-end");\n    }\n    __avcClock.treeNormalize("after", __avcNormalizationNodes);\n  };\n\n  const applyClipLayout');
  }
  function visit(n){
   if(args.path.endsWith('/runtime/init.ts')&&ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==='buildRuntimeMediaCache'))replacements.push({start:n.getEnd(),end:n.getEnd(),text:'\n__avcClock.mediaResolver(()=>buildRuntimeMediaCache().mediaClips,sourceTimeAt,isInClipWindow);',original:''});
   if(args.path.endsWith('/runtime/init.ts')&&ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&ts.isIdentifier(n.expression.expression)&&n.expression.expression.text==='webAudio'&&n.expression.name.text==='init')replacements.push({start:n.getStart(ast),end:n.getEnd(),text:'Promise.resolve(false)',original:text.slice(n.getStart(ast),n.getEnd())});
   if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(n.left)&&ts.isIdentifier(n.left.expression)&&n.left.expression.text==='window'&&exported.has(n.left.name.text))replacements.push({start:n.getStart(ast),end:n.getEnd(),text:'__avcClock.publish('+JSON.stringify(n.left.name.text)+','+text.slice(n.right.getStart(ast),n.right.getEnd())+')',original:text.slice(n.getStart(ast),n.getEnd())});
   if(ts.isDeleteExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&ts.isIdentifier(n.expression.expression)&&n.expression.expression.text==='window'&&exported.has(n.expression.name.text))replacements.push({start:n.getStart(ast),end:n.getEnd(),text:'__avcClock.publish('+JSON.stringify(n.expression.name.text)+',undefined)',original:text.slice(n.getStart(ast),n.getEnd())});
   if(ts.isCallExpression(n)){
    const x=n.expression;
    const name=ts.isIdentifier(x)?x.text:ts.isPropertyAccessExpression(x)&&ts.isIdentifier(x.expression)&&['window','win','target'].includes(x.expression.text)?x.name.text:null;
    if(clocks.has(name))replacements.push({start:x.getStart(ast),end:x.getEnd(),text:'__avcClock.'+name,original:text.slice(x.getStart(ast),x.getEnd())});
   }
   ts.forEachChild(n,visit);
  }visit(ast);
  if(!replacements.length)return;
  let transformed=text;for(const r of [...replacements].sort((a,b)=>b.start-a.start))transformed=transformed.slice(0,r.start)+r.text+transformed.slice(r.end);
  patches[path.relative(root,args.path)]={originalSha256:crypto.createHash('sha256').update(text).digest('hex'),replacements};
  return{contents:'import __avcClock from "avc-private-clock";\n'+transformed,loader:'ts'};
 });
}};
esbuild.build({entryPoints:[root+'/packages/core/src/runtime/entry.ts'],bundle:true,write:false,platform:'browser',format:'iife',target:'es2020',minify:true,nodePaths:[path.resolve(deps)],alias:Object.fromEntries(Object.entries(parser.exports).filter(([,v])=>v?.import).map(([k,v])=>['@hyperframes/parsers'+(k==='.'?'':k.slice(1)),path.resolve(root+'/packages/parsers',v.import)])),plugins:[plugin]}).then(result=>{
 const bytes=result.outputFiles[0].contents;
 const added=Object.values(patches).flatMap(p=>p.replacements).filter(r=>r.text.includes('mediaResolver')||r.text==='Promise.resolve(false)');
 if(added.length!==2)throw Error('Expected exactly two media-profile adaptations');
 const receipt={patchToolSha256:hash(fs.readFileSync(__filename)),sourceClosureSha256:pin.sourceClosureSha256,esbuild:pin.esbuild,originalReceiptSha256:hash(fs.readFileSync(path.join(__dirname,'provenance.json'))),visualReceiptSha256:hash(fs.readFileSync(path.join(__dirname,'patched-provenance.json'))),profile:'static-local-tree-v1',predecessorReceiptSha256:hash(fs.readFileSync(path.join(__dirname,'tree-provenance-993a.json'))),originalEngineSha256:pin.engineSha256,visualEngineSha256:patchedPin.engineSha256,engineSha256:hash(bytes),engineBytes:bytes.length,typescript:patchedPin.typescript,patches:Object.fromEntries(Object.entries(patches).sort())};
 const loader=patches['packages/core/src/runtime/compositionLoader.ts'];if(!loader||loader.replacements.filter(r=>r.text.includes('mountedHosts')||r.text.includes('treeGuard')).length!==5)throw Error('Expected five exact static tree loader adaptations');
 if(patches['packages/core/src/runtime/init.ts'].replacements.filter(r=>r.text.includes('treeNormalize(')).length!==2)throw Error('Expected two exact sanitizer lifecycle adaptations');
 if(recordReceipt==='--record-receipt')fs.writeFileSync(mediaReceiptPath,JSON.stringify(receipt,null,2)+'\n');
 else if(JSON.stringify(receipt)!==JSON.stringify(mediaPin))throw Error('Pinned tree artifact/patch receipt mismatch');fs.writeFileSync(output,bytes);process.stdout.write(JSON.stringify({ok:true,sha256:hash(bytes),bytes:bytes.length,patchedFiles:Object.keys(patches).length})+'\n');
});
