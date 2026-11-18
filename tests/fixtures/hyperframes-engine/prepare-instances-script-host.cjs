/** C24 derivative SOURCE-only until a separately allocated --build. Import never builds. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const CONTRACT_SHA='c39c21fadae2f3a5c665212a3d75500f1790a5d2e86acff15c72b21f8866f7b2';
function regular(file,max=1024*1024){
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>max)throw Error('Nonregular/bounded derivative input');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);
 try{const current=fs.fstatSync(fd);if(!current.isFile()||current.dev!==s.dev||current.ino!==s.ino||current.size!==s.size)throw Error('Derivative input changed');const bytes=Buffer.alloc(s.size);let offset=0;while(offset<bytes.length){const read=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!read)throw Error('Derivative input truncated');offset+=read;}const last=fs.fstatSync(fd),lexical=fs.lstatSync(file);if(fs.readSync(fd,Buffer.alloc(1),0,1,null)||last.size!==s.size||last.mtimeMs!==s.mtimeMs||last.ctimeMs!==s.ctimeMs||lexical.dev!==s.dev||lexical.ino!==s.ino||lexical.isSymbolicLink())throw Error('Derivative input changed');return bytes;}finally{fs.closeSync(fd);}
}
function inputs(){
 const bytes=regular(path.join(__dirname,'instances-script-host-contract.json'));if(hash(bytes)!==CONTRACT_SHA)throw Error('Immutable script-host contract mismatch');
 const contract=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 for(const [name,sha]of Object.entries(contract.predecessors))if(hash(regular(path.join(__dirname,name)))!==sha)throw Error('Immutable C23 predecessor mismatch: '+name);
 return {contract,recipe:regular(path.join(__dirname,'prepare-instances-selection.cjs')).toString('utf8'),receipt:JSON.parse(regular(path.join(__dirname,'instances-selection-provenance.json'))),tree:JSON.parse(regular(path.join(__dirname,'tree-provenance.json')))};
}
/** Pure exact whole-source correction; no compiler, DOM or script execution. */
function patchWithContract(text,contract){
 const hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
 if(typeof text!=='string'||Buffer.byteLength(text)>256*1024||hash(text)!==contract.predecessorSourceSha256)throw Error('C23 loader source identity mismatch');
 const start=text.indexOf(contract.original);if(start<0||text.indexOf(contract.original,start+1)>=0)throw Error('Exact private script-host hook count mismatch');
 const output=text.slice(0,start)+contract.replacement+text.slice(start+contract.original.length);
 return {text:output,transform:{source:contract.source,predecessorSourceSha256:hash(text),outputSourceSha256:hash(output),replacement:{start,end:start+contract.original.length,original:contract.original,text:contract.replacement}}};
}
function patchScriptHost(text){return patchWithContract(text,inputs().contract);}
/** Reconstruct recorded C23 text only, preserving original/tree/patch identities. */
function reconstructSource(relative,originalText){
 const {receipt,tree}=inputs();const entry=receipt.patches[relative];if(!entry||hash(originalText)!==entry.originalSha256)throw Error('C23 original source identity mismatch');
 let text=originalText;const prior=tree.patches[relative];if(prior){for(const edit of [...prior.replacements].sort((a,b)=>b.start-a.start)){if(text.slice(edit.start,edit.end)!==edit.original)throw Error('Tree source patch mismatch');text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);}text='import __avcClock from "avc-private-clock";\n'+text;}
 if(hash(text)!==entry.intermediateSha256)throw Error('C23 intermediate source mismatch');
 for(const edit of entry.replacements){if(text.slice(edit.start,edit.end)!==edit.original)throw Error('C23 exact source patch mismatch');text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);}if(entry.addedPrivateClockImport)text='import __avcClock from "avc-private-clock";\n'+text;
 if(hash(text)!==entry.outputSha256)throw Error('C23 output source mismatch');return text;
}
function replaceOnce(text,original,replacement){const start=text.indexOf(original);if(start<0||text.indexOf(original,start+1)>=0)throw Error('Derivative recipe shape/count mismatch');return text.slice(0,start)+replacement+text.slice(start+original.length);}
/** Trusted hash-pinned C23 recipe derivative; actual build remains explicit. */
function deriveBuildRecipe(){
 const {contract,recipe,receipt}=inputs();let text=recipe;
 text=replaceOnce(text,"'instances-selection-provenance.json'),contractPath=", "'instances-script-host-provenance.json'),contractPath=");
 const onLoad='loaded[\'source/\'+relative]=hash(text);const intermediate=applyPredecessor(relative,text),transformed=adapt(relative,intermediate);';
 const corrected=onLoad+'\n  let contents=transformed;if(relative===__bindingContract.source){const result=__bindingPatch(transformed,__bindingContract);contents=result.text;__bindingTransforms[relative]=result.transform;}';
 text=replaceOnce(text,onLoad,corrected);
 text=replaceOnce(text,'if(transformed===text)return;return{contents:transformed,loader:\'ts\'};','if(contents===text)return;return{contents,loader:\'ts\'};');
 text=replaceOnce(text,"const receipt={profile:'static-local-instances-v1'", "const receipt={artifactVersion:__bindingContract.artifactVersion,scriptHostBindingContract:__bindingContract.contract,scriptHostBindingContractSha256:__bindingContractSha,inheritedC23ReceiptSha256:__bindingContract.predecessors['instances-selection-provenance.json'],inheritedC23RecipeSha256:__bindingContract.predecessors['prepare-instances-selection.cjs'],inheritedC23RuntimeSha256:__bindingContract.predecessorRuntimeSha256,finalPrivateHookCount:23,bindingTransforms:__bindingTransforms,profile:'static-local-instances-v1'");
 // Old resolution manifests still pin inputs before any compiler result is published.
 text=replaceOnce(text,"JSON.parse(fs.readFileSync(receiptPath)).resolutionManifests",'__bindingInheritedReceipt.resolutionManifests');
 text=replaceOnce(text,'if(require.main===module)main();','module.exports.run=main;');
 const prefix=`const __bindingContract=${JSON.stringify(contract)},__bindingContractSha=${JSON.stringify(CONTRACT_SHA)},__bindingInheritedReceipt=${JSON.stringify(receipt)},__bindingTransforms={};\nconst __bindingPatch=(${patchWithContract.toString()});\n`;
 return prefix+text;
}
module.exports={patchScriptHost,reconstructSource,deriveBuildRecipe,CONTRACT_SHA};
if(require.main===module){
 if(process.argv[2]!=='--build')throw Error('SOURCE-only private recipe requires explicit --build SOURCE DEPS ESBUILD_MODULE OUTPUT [--record-receipt]');
 const args=process.argv.slice(3);if(args.length<4||args.length>5||args.length===5&&args[4]!=='--record-receipt')throw Error('Closed derivative build argv');
 const {Module}=require('node:module'),compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=module.paths;
 // Only trusted pinned recipe text is compiled here; imports do not execute this path.
 compiled._compile(deriveBuildRecipe(),__filename);const old=process.argv;try{process.argv=[old[0],__filename,...args];compiled.exports.run();}finally{process.argv=old;}
}
