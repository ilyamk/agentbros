import { validateTreeMediaWindow, type validateStaticCompositionTree } from "./native-composition-tree";
export const HYPERFRAMES_TREE_PIN = {
  profile: "static-local-tree-v1",
  runtimeSha256: "88f3e5288737e752468d1bb11ca9afe43a31404fefe5f827b5cac37866e585eb",
  sourceClosureSha256: "3fec9b5beb967a48a2762d66a91daeff40a76b5715934054a648853b00c93408",
} as const;
export type StaticTreeGraph = ReturnType<typeof validateStaticCompositionTree>;
/** Private host capability only; never published as authored APIs or permissive clock. */
export function staticTreePrelude(graph: StaticTreeGraph) {
  return `
 const __name=(fn)=>fn,treeGraph=${JSON.stringify(graph)},treeNodes=new Map(treeGraph.nodes.map(n=>[n.id,n])),treePending=new Set(),treeLoaded=new Set(),treeNormalized=new Set(),treeElements=new Map();let treeTimelines,treeNormalizationPending;
 const checkTreeMedia=(${validateTreeMediaWindow.toString()});
 const treeDOM=complete=>{
  if(document.querySelector('base,meta[http-equiv],template,iframe,object,embed'))return refuse('Static tree changed unsupported DOM');
  const elements=[...document.querySelectorAll('[data-composition-id],[data-composition-src]')],seen=new Set();
  if(elements.length>treeGraph.limits.hosts)return refuse('Static tree DOM host count bound');
  for(const element of elements){
   const id=element.getAttribute('data-composition-id');if(!id||seen.has(id))return refuse('Static tree changed/missing/duplicate host identity');seen.add(id);
   if(element.hasAttribute('data-end')||element.hasAttribute('data-hf-authored-end'))return refuse('Static tree changed end metadata');
   if(treeElements.has(id)&&treeElements.get(id)!==element)return refuse('Static tree changed host node identity');treeElements.set(id,element);
   if(id===treeGraph.rootId){if(element.hasAttribute('data-hf-authored-duration'))return refuse('Static tree changed root private timing');for(const[name,value]of Object.entries(treeGraph.rootAttributes||{}))if(element.getAttribute(name)!==value)return refuse('Static tree changed root metadata');continue;}
   const expected=treeNodes.get(id);if(!expected||element.getAttribute('data-composition-src')!==expected.source)return refuse('Static tree changed/unlisted external host');
   const parent=element.parentElement?.closest('[data-composition-id],[data-composition-src]')?.getAttribute('data-composition-id');if(parent!==expected.parentId)return refuse('Static tree changed host parent');
   if(!expected.authored||element.getAttribute('data-start')!==expected.authored.start||element.getAttribute('data-media-start')!==expected.authored.inPoint)return refuse('Static tree changed timing metadata');
   if(treeNormalized.has(id) ? element.hasAttribute('data-duration')||element.getAttribute('data-hf-authored-duration')!==expected.authored.duration : element.getAttribute('data-duration')!==expected.authored.duration||element.hasAttribute('data-hf-authored-duration'))return refuse('Static tree changed duration lifecycle metadata');
  }
  if(!seen.has(treeGraph.rootId)||complete&&(seen.size!==treeGraph.hostCount||[...treeNodes.keys()].some(id=>!seen.has(id))))return refuse('Static tree incomplete mounted graph');
 };
 const treeGuard=(phase,hosts)=>{
  if(!['before-mount','mounted','scripts-complete','validate'].includes(phase))return refuse('Static tree unknown private phase');
  treeDOM(phase!=='before-mount');
  if(phase==='before-mount'){
   if(treePending.size)return refuse('Static tree unfinished loader batch');
   for(const host of hosts){const id=host.getAttribute('data-composition-id'),node=treeNodes.get(id);if(!node||treeLoaded.has(node.source)||treePending.has(node.source))return refuse('Static tree repeated/unplanned mount');treePending.add(node.source);}
   if(treePending.size>16)return refuse('Static tree pending host count bound');
  }else if(treePending.size||treeLoaded.size!==treeGraph.nodes.length)return refuse('Static tree incomplete source loads');
 };
 const treeNormalize=(phase,nodes)=>{
  if(!['before','after'].includes(phase)||!Array.isArray(nodes)||nodes.length>treeGraph.limits.hosts)return refuse('Static tree malformed normalization hook');
  const current=new Set(document.querySelectorAll('[data-composition-id],[data-composition-src]'));if(nodes.some(node=>!current.has(node)))return refuse('Static tree normalization detached/non-DOM node');
  const seen=new Set();for(const node of nodes){const id=node?.getAttribute?.('data-composition-id');if(!treeNodes.has(id)||seen.has(id)||treeElements.has(id)&&treeElements.get(id)!==node)return refuse('Static tree normalization host identity');seen.add(id);}
  if(phase==='before'){
   if(treeNormalizationPending)return refuse('Static tree repeated pending normalization');treeDOM(false);for(const node of nodes)if(treeElements.get(node.getAttribute('data-composition-id'))!==node)return refuse('Static tree normalization non-DOM identity');treeNormalizationPending=nodes.slice();
  }else{
   if(!treeNormalizationPending||nodes.length!==treeNormalizationPending.length||nodes.some((node,index)=>node!==treeNormalizationPending[index]))return refuse('Static tree changed normalization nodes');
   for(const node of nodes){const id=node.getAttribute('data-composition-id'),expected=treeNodes.get(id);if(node.hasAttribute('data-duration')||node.getAttribute('data-hf-authored-duration')!==expected.authored?.duration||node.hasAttribute('data-end')||node.hasAttribute('data-hf-authored-end'))return refuse('Static tree malformed normalized duration');}
   for(const node of nodes)treeNormalized.add(node.getAttribute('data-composition-id'));treeNormalizationPending=undefined;treeDOM(false);
  }
 };
 const treeFetch=name=>{if(!treePending.has(name)||treeLoaded.has(name))return refuse('Static tree unplanned/repeated source load');treePending.delete(name);treeLoaded.add(name);};
 const treeReady=()=>{
  treeGuard('validate',[]);if(treeNormalizationPending||treeNormalized.size!==treeNodes.size)return refuse('Static tree incomplete authenticated normalization');
  if(window.__clipManifest.durationSeconds!==treeGraph.rootDuration)return refuse('Static tree root manifest duration differs');
  const registry=window.__timelines||{},ids=[treeGraph.rootId,...treeNodes.keys()];if(Object.keys(registry).length!==ids.length)return refuse('Static tree unexpected timeline registry');
  for(const id of ids){const timeline=registry[id];if(typeof timeline?.totalTime!=='function'||typeof timeline?.getChildren!=='function'||typeof timeline?.duration!=='function'||!Number.isFinite(timeline.duration())||timeline.duration()<=0)return refuse('Static tree genuine timeline not registered');}
  if(!treeTimelines)treeTimelines=new Map(ids.map(id=>[id,registry[id]]));else for(const id of ids)if(treeTimelines.get(id)!==registry[id])return refuse('Static tree changed timeline identity');
 };
 const treeMediaGuard=(element,start,end)=>{
  const ancestors=[];for(let node=element.parentElement;node;node=node.parentElement)if(node.hasAttribute('data-composition-id'))ancestors.push(node.getAttribute('data-composition-id'));
  try{checkTreeMedia(treeGraph,ancestors.reverse(),start,end);}catch(error){return refuse(error.message);}
 };
 `;
}
