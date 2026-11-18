/** Offline development build; production acceptance binds frozen media-provenance artifact hash. */
const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [source,deps,esbuildModule,typescriptModule,output,recordReceipt]=process.argv.slice(2);
if(!source||!deps||!esbuildModule||!typescriptModule||!output)throw Error('Usage: node prepare-media.cjs SOURCE PRIVATE_DEPS ESBUILD_MODULE TYPESCRIPT_MODULE OUTPUT.js');
const pin=require('./provenance.json'),patchedPin=require('./patched-provenance.json'),mediaReceiptPath=path.join(__dirname,'media-provenance.json'),mediaPin=recordReceipt==='--record-receipt'?null:require(mediaReceiptPath),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
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
const plugin={name:'explicit-private-host-clock',setup(build){
 build.onResolve({filter:/^avc-private-clock$/},()=>({path:'host',namespace:'avc-clock'}));
 build.onLoad({filter:/.*/,namespace:'avc-clock'},()=>({contents:'const clock=window.__avcPrivateEngineClock;delete window.__avcPrivateEngineClock;if(!clock)throw Error("Missing private host clock");export default clock;',loader:'js'}));
 build.onLoad({filter:/\.ts$/},args=>{
  if(!args.path.startsWith(root+'/'))return;
  const text=fs.readFileSync(args.path,'utf8'), ast=ts.createSourceFile(args.path,text,ts.ScriptTarget.Latest,true),replacements=[];
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
 const receipt={patchToolSha256:hash(fs.readFileSync(__filename)),sourceClosureSha256:pin.sourceClosureSha256,esbuild:pin.esbuild,originalReceiptSha256:hash(fs.readFileSync(path.join(__dirname,'provenance.json'))),visualReceiptSha256:hash(fs.readFileSync(path.join(__dirname,'patched-provenance.json'))),profile:'native-local-media-v1',originalEngineSha256:pin.engineSha256,visualEngineSha256:patchedPin.engineSha256,engineSha256:hash(bytes),engineBytes:bytes.length,typescript:patchedPin.typescript,patches:Object.fromEntries(Object.entries(patches).sort())};
 if(recordReceipt==='--record-receipt')fs.writeFileSync(mediaReceiptPath,JSON.stringify(receipt,null,2)+'\n');
 else if(JSON.stringify(receipt)!==JSON.stringify(mediaPin))throw Error('Pinned media artifact/patch receipt mismatch');fs.writeFileSync(output,bytes);process.stdout.write(JSON.stringify({ok:true,sha256:hash(bytes),bytes:bytes.length,patchedFiles:Object.keys(patches).length})+'\n');
});
