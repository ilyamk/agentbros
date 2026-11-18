import { instancesPrelude } from "./native-composition-instances-prelude";
import type { InstanceGraph } from "./native-composition-instances-extract";
import { staticTreePrelude, type StaticTreeGraph } from "./native-composition-tree-prelude";
import { nativeMediaPrelude, type NativeMediaSource } from "./hyperframes-player-media";
/** Explicit source-exact offline full-player subset, not general engine compatibility. */
export const HYPERFRAMES_PLAYER_PIN = {
  revision: "9e9b613ccf867f98838617f7424967e056e63de2",
  runtimeSha256: "b0a6873f44d1070736f847c7950882639321c8993f59dba500c8778b6ced4dd2",
  gsapSha256: "01effe0e121c22ba0f885a3f091f3dc6d1f0d445c4fba37dcb298e314eca5cfb",
  sourceClosureSha256: "3fec9b5beb967a48a2762d66a91daeff40a76b5715934054a648853b00c93408",
  clock: "source-exact-private-capability/dormant-RAF/bounded-zero-bootstrap",
} as const;

/** Node produces this prelude from already hash-verified immutable snapshots. */
export function fullPlayerPrelude(
  runtime: string,
  gsap: string,
  htmlAssets: Record<string, string>,
  fps: number,
  width: number,
  height: number,
  mediaSources?: Record<string, NativeMediaSource>,
  tree?: StaticTreeGraph,
  instances?: InstanceGraph,
) {
  return `(()=>{
 const inputs=${JSON.stringify(htmlAssets)},state=window.__avcGuard;
 let id=0,executed=0,loads=0,loadedBytes=0;const timers=new Map(),raf=new Set();
 const refuse=message=>{state.violations.push(message);throw Error(message);};
 const register=(fn,delay=0,...args)=>{if(++id>1024||typeof fn!=='function'||!Number.isFinite(Number(delay))||Number(delay)<0||Number(delay)>30000)return refuse('Full player private timer bound');timers.set(id,{fn,delay:Number(delay),args});return id;};
 const registerRAF=()=>{if(++id>1024)return refuse('Full player dormant RAF bound');raf.add(id);return id;};
 const localFetch=async(input,options)=>{
  if(typeof input!=='string'||options)return refuse('Full player local loader accepts plain GET paths only');
  const url=new URL(input,location.href),name=decodeURIComponent(url.pathname.slice(1));
  if(url.origin!=='https://avc.invalid'||url.search||url.hash||(!Object.hasOwn(inputs,name)||typeof inputs[name]!=='string')||++loads>16)return refuse('Full player denied child source');
  const html=inputs[name],size=new TextEncoder().encode(html).length;if(size>128*1024||(loadedBytes+=size)>2*1024*1024)return refuse('Full player child byte bound');
  const child=new DOMParser().parseFromString(html,'text/html');
  ${tree ? "treeFetch(name);" : ""}
  if(child.querySelector('${tree ? "iframe,object,embed" : "[data-composition-src],iframe,object,embed"}'))return refuse('Recursive external children unsupported');
  return new Response(html,{status:200,headers:{'Content-Type':'text/html'}});
 };
 ${tree ? staticTreePrelude(tree) : instances ? instancesPrelude(instances) : ""}
 ${mediaSources ? nativeMediaPrelude(mediaSources, Boolean(tree || instances), Boolean(instances)) : ""}
 const exports=new Map(),protectedNames=['__player','__playerReady','__renderReady','__clipManifest','__hfWaitForSeekCompletion','__hfRuntimeTeardown'];
 const deepFreeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;};
 for(const name of protectedNames)Object.defineProperty(window,name,{get:()=>exports.get(name),set:()=>refuse('Authored native lifecycle shadowing: '+name),configurable:false});
 const publish=(name,value)=>{if(!protectedNames.includes(name))return refuse('Unknown native lifecycle publication');exports.set(name,['__player','__clipManifest'].includes(name)?deepFreeze(value):value);return value;};
 const cap={publish,${tree ? "treeGuard,treeNormalize," : instances ? "treeGuard,treeNormalize,instanceMode:true,instanceRegisterInertStyle,instanceFetch,instanceSourceRootId,instanceArmScript,instancePrepareMedia,instanceClipId," : ""}${mediaSources ? "mediaResolver:nativeRegister," : ""}setTimeout:register,clearTimeout:k=>timers.delete(k),requestAnimationFrame:registerRAF,cancelAnimationFrame:k=>raf.delete(k),setInterval:(fn,delay)=>Number.isFinite(Number(delay))&&Number(delay)>=1?register(fn,delay):refuse('Full player private interval bound'),clearInterval:k=>timers.delete(k),fetch:localFetch};
 window.__HF_EXPORT_RENDER_SEEK_CONFIG={fps:${fps},fpsSource:'render-options'};
 Object.defineProperty(window,'__avcPrivateEngineClock',{value:cap,writable:false,configurable:true});
 (function(requestAnimationFrame,cancelAnimationFrame,setTimeout,clearTimeout){\n${gsap}\n}).call(window,registerRAF,cap.cancelAnimationFrame,register,cap.clearTimeout);
 window.gsap.ticker.add=()=>refuse('Authored GSAP ticker callbacks unsupported');
 ${runtime}
 const unsupported=()=>{
  if(document.querySelector('${mediaSources ? "" : "video,audio,"}canvas,iframe,object,embed,animate,animateTransform,animateMotion,set,[data-hf-vfx],[data-hf-edit-base-x],[data-hf-edit-base-y]')||document.getAnimations().length)return refuse('Full player media/WAAPI/VFX unsupported');
  ${mediaSources ? "nativePrepare();" : ""}
  const hosts=[...document.querySelectorAll('[data-composition-id]')];
  if(hosts.length>32)return refuse('Full player composition count bound');
  for(const host of hosts){let depth=0;for(let p=host;p;p=p.parentElement)if(p.hasAttribute('data-composition-id')&&++depth>8)return refuse('Full player composition depth bound');if(host.hasAttribute('data-no-timeline'))return refuse('Full player timeline-free composition unsupported');}
  return hosts;
 };
 const waitBuild=async()=>{const registry=window.__hf?.buildReady||{},keys=Object.keys(registry);if(keys.length>32)return refuse('Full player build-ready count bound');try{await Promise.all(keys.map(k=>Promise.resolve(registry[k])));}catch{return refuse('Full player build-ready rejected');}if(JSON.stringify(Object.keys(window.__hf?.buildReady||{}))!==JSON.stringify(keys))return refuse('Full player build-ready registry changed');};
 const validate=()=>{
  if(state.violations.length)throw Error('Full player resource/clock guard violation: '+state.violations.join(','));
  const hosts=unsupported();if(!window.__playerReady||!window.__renderReady)return false;
  const manifest=window.__clipManifest,player=window.__player;
  if(!manifest||manifest.protocolVersion!==1||manifest.fps?.numerator!==${fps}||manifest.fps?.denominator!==1||manifest.compositionWidth!==${width}||manifest.compositionHeight!==${height}||!Number.isSafeInteger(manifest.durationInFrames)||manifest.durationInFrames<1||manifest.durationInFrames>36001||Math.abs(manifest.durationSeconds-manifest.durationInFrames/${fps})>1e-8||manifest.clips.length>64)return refuse('Full player manifest outside supported contract');
  if(typeof player?.renderSeek!=='function'||typeof player?.pause!=='function'||typeof window.__hfWaitForSeekCompletion!=='function'||Math.abs(player.getDuration()-manifest.durationSeconds)>1e-8)return refuse('Full player lifecycle outside supported contract');
  for(const host of hosts){const key=host.getAttribute('data-composition-id');if(!window.__timelines?.[key])return refuse('Full player child timeline not ready: '+key);}
  if(manifest.clips.some(c=>!${mediaSources ? "['element','composition','video','audio','image']" : "['element','composition']"}.includes(c.kind)||!Number.isFinite(c.start)||!Number.isFinite(c.duration)||c.duration<0))return refuse('Full player native clip unsupported');
  if(state.violations.length)return refuse('Full player resource/clock guard violation');
  ${tree || instances ? "treeReady();" : ""}
  return {durationFrames:manifest.durationInFrames,manifest,loads};
 };
 Object.defineProperty(window,'__avcFullPlayer',{value:Object.freeze({
  ${mediaSources ? "media(time){return nativeDescriptors(time);}," : ""}
  async flush(){unsupported();for(const[k,v]of [...timers])if(v.delay===0){if(++executed>64)return refuse('Full player bootstrap execution bound');timers.delete(k);v.fn(...v.args);}window.__hfFlushSync?.();await waitBuild();return validate();},
  async seek(frame){await waitBuild();const before=validate();if(!before||frame>=before.durationFrames)return refuse('Full player frame outside duration');window.__player.pause();window.gsap.ticker.sleep();window.__player.renderSeek(0,{exact:true,suppressEvents:true});await window.__hfWaitForSeekCompletion();window.__player.renderSeek(frame/${fps},{exact:true,suppressEvents:true});await window.__hfWaitForSeekCompletion();window.gsap.ticker.sleep();await waitBuild();const after=validate();if(JSON.stringify(before.manifest)!==JSON.stringify(after.manifest))return refuse('Full player manifest changed during seek');return {frame,id:'hyperframes-patched-player',durationFrames:before.durationFrames,lifecycle:'bootstrap/pause/absolute-await-seek/teardown',clock:${JSON.stringify(HYPERFRAMES_PLAYER_PIN.clock)},nativeManifest:after.manifest,childLoads:loads};},
  dispose(){${instances ? "instanceController.dispose();" : ""}window.__hfRuntimeTeardown?.();window.gsap?.ticker?.sleep();timers.clear();raf.clear();}
 }),writable:false,configurable:false});
 })()`;
}
