// Offline audit preparation. No fetch, install, provider calls or product protocol.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const [source,deps,esbuildModule,output]=process.argv.slice(2);
if(!source||!deps||!esbuildModule||!output)throw Error('Usage: node build.cjs UPSTREAM_SOURCE PRIVATE_NODE_MODULES ESBUILD_MODULE OUTPUT.js');
const pin=require('./provenance.json'),hash=b=>createHash('sha256').update(b).digest('hex');
for(const [name,sha]of Object.entries(pin.files)){
 const file=name.startsWith('source/')?path.join(source,name.slice(7)):path.join(deps,name.slice(13));
 if(hash(fs.readFileSync(file))!==sha)throw Error('Audit input hash mismatch: '+name);
}
const esbuild=require(path.resolve(esbuildModule));if(esbuild.version!==pin.esbuild)throw Error('Pinned esbuild required');
const parser=JSON.parse(fs.readFileSync(path.join(source,'packages/parsers/package.json')));
const alias=Object.fromEntries(Object.entries(parser.exports).filter(([,v])=>v?.import).map(([key,v])=>['@hyperframes/parsers'+(key==='.'?'':key.slice(1)),path.resolve(source,'packages/parsers',v.import)]));
const result=esbuild.buildSync({entryPoints:[path.join(source,pin.entry)],...pin.buildOptions,write:false,nodePaths:[path.resolve(deps)],alias});
const bytes=result.outputFiles[0].contents;if(hash(bytes)!==pin.engineSha256)throw Error('Compiled artifact differs from audited runtime');
fs.writeFileSync(output,bytes);process.stdout.write(JSON.stringify({ok:true,sha256:pin.engineSha256,bytes:bytes.length})+'\n');
