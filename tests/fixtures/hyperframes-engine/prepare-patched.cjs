const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [source,deps,esbuildModule,typescriptModule,output]=process.argv.slice(2);
if(!source||!deps||!esbuildModule||!typescriptModule||!output)throw Error('Usage: node prepare-patched.cjs SOURCE PRIVATE_DEPS ESBUILD_MODULE TYPESCRIPT_MODULE OUTPUT.js');
const pin=require('./provenance.json'),patchedPin=require('./patched-provenance.json'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
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
 const bytes=result.outputFiles[0].contents;if(hash(bytes)!==patchedPin.engineSha256)throw Error('Patched artifact mismatch');if(JSON.stringify(Object.entries(patches).sort())!==JSON.stringify(Object.entries(patchedPin.patches).sort()))throw Error('Patch locations differ');fs.writeFileSync(output,bytes);process.stdout.write(JSON.stringify({ok:true,sha256:hash(bytes),bytes:bytes.length,patchedFiles:Object.keys(patches).length})+'\n');
});
