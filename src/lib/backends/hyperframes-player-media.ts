/** Genuine source-exact native cache bridge; not authored AVC timing. */
export const HYPERFRAMES_MEDIA_PIN = {
  profile: "native-local-media-v1",
  runtimeSha256: "761ad67f4618f6245ba7a023e88483ab49c7f391e836d5ac46afcd0b20d7bec6",
  visualRuntimeSha256: "b0a6873f44d1070736f847c7950882639321c8993f59dba500c8778b6ced4dd2",
  mapping: "genuine-buildRuntimeMediaCache/sourceTimeAt/isInClipWindow/injected-render-frame",
} as const;
export interface NativeMediaSource {
  durationSec: number;
  sha256: string;
  kind: "video" | "audio";
  sourceFps?: number;
  normalization?: import("./native-media-preparation").NativePreparedSource["normalization"];
}
export interface NativeMediaDescriptor {
  index: number;
  id: string;
  kind: "video" | "audio";
  asset: string;
  sha256: string;
  startSec: number;
  endSec: number;
  originSec: number;
  sourceStartSec: number;
  sourceEndSec: number;
  timeSec: number;
  rate: number;
  volume: number;
  nativeVolume: number;
  authoredMuted: boolean;
  active: boolean;
  sourceDurationSec: number;
}
/** Included only for the explicit media profile, in the private player closure. */
export function nativeMediaPrelude(sources: Record<string, NativeMediaSource>, tree = false, instances = false) {
  return `
 const nativeSources=${JSON.stringify(sources)};let nativeGetter,nativeSourceTime,nativeInWindow;const nativeElements=new Map(),nativeFrames=new WeakMap(),nativeMutes=new WeakMap();
 const nativeName=el=>{const raw=el.getAttribute('src');if(!raw||el.querySelector('source'))return refuse('Native media requires one explicit local src');const url=new URL(raw,location.href),name=decodeURIComponent(url.pathname.slice(1));if(url.origin!=='https://avc.invalid'||url.search||url.hash||!Object.hasOwn(nativeSources,name))return refuse('Native media source outside snapshot allowlist');return name;};
 Object.defineProperty(HTMLMediaElement.prototype,'duration',{get(){return nativeSources[nativeName(this)].durationSec;},configurable:false});
 const nativePrepare=()=>{
  for(const timeline of Object.values(window.__timelines||{}))for(const tween of timeline.getChildren?.(true,true,true)||[])if(tween.targets?.().some(t=>t instanceof HTMLMediaElement)&&['volume','muted','currentTime','playbackRate','src'].some(key=>Object.hasOwn(tween.vars||{},key)))return refuse('Native media authored property animation unsupported');
  const els=[...document.querySelectorAll('video,audio')];if(els.length>8)return refuse('Native media count bound');
  const ids=new Set();for(const[index,el]of els.entries()){
   const name=nativeName(el),source=nativeSources[name],id=el.getAttribute('data-hf-render-id')||el.id;
   if(!id||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)||ids.has(id))return refuse('Native media render id collision/invalid');ids.add(id);
   if(source.kind!==el.tagName.toLowerCase()||el.autoplay||el.loop||el.hasAttribute('data-automation')||el.hasAttribute('data-fade-in')||el.hasAttribute('data-fade-out')||el.hasAttribute('data-audio-fx')||el.hasAttribute('data-fx-chain')||el.closest('hf-audio-group,[data-audio-group],[data-hidden]')||((source.kind==='audio'||source.normalization?.audio)&&el.preservesPitch===false))return refuse('Native media unsupported autoplay/loop/envelope/group');
   const previousMute=nativeMutes.get(el);if(previousMute){if(el.muted!==true||el.defaultMuted!==previousMute.defaultMuted||el.hasAttribute('muted')!==previousMute.attributeMuted)return refuse('Native media authored mute changed after transport suppression');}
   else nativeMutes.set(el,Object.freeze({muted:el.muted,defaultMuted:el.defaultMuted,attributeMuted:el.hasAttribute('muted')}));
   el.pause();el.muted=true;el.dataset.avcNativeIndex=String(index);nativeElements.set(el,index);
   if(source.kind==='video'&&!nativeFrames.has(el)){
    const frameId='__render_frame_'+id+'__';if(document.getElementById(frameId))return refuse('Native render frame namespace collision');
    const img=document.createElement('img');img.id=frameId;img.setAttribute('data-avc-native-frame','');img.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkAAMWCAUAADgABkRoBWYAAAAASUVORK5CYII=';el.after(img);nativeFrames.set(el,img);${instances ? "instanceRegisterFrame(el,img);" : ""}
   }
   if(source.kind==='video'&&(el.nextElementSibling!==nativeFrames.get(el)||document.getElementById('__render_frame_'+id+'__')!==nativeFrames.get(el)))return refuse('Native render frame ownership changed');
  }return els;
 };
 const nativeRegister=(getter,map,inWindow)=>{if(nativeGetter||typeof inWindow!=='function'||typeof getter!=='function'||typeof map!=='function')return refuse('Native cache registration invalid');nativeGetter=getter;nativeSourceTime=map;nativeInWindow=inWindow;};
 const nativeDescriptors=time=>{
  const els=nativePrepare();if(!nativeGetter||!Number.isFinite(time))return refuse('Native cache unavailable');const clips=nativeGetter();if(clips.length!==els.length)return refuse('Native media unmanaged/missing cache');
  return clips.map(clip=>{
   const el=clip.el,index=nativeElements.get(el),asset=nativeName(el),source=nativeSources[asset],origin=clip.origin??clip.start,rate=clip.rate??clip.playbackRate,volume=clip.volume??1;
   if(index===undefined||typeof rate!=='number'||rate<.125||rate>8||clip.loop||clip.volumeKeyframes?.length||clip.fades?.fadeIn||clip.fades?.fadeOut||![clip.start,clip.end,origin,clip.mediaStart,volume,clip.sourceDuration].every(Number.isFinite)||clip.start<0||clip.end>(window.__clipManifest?.durationSeconds??0)+1e-8||clip.end<=clip.start||origin>clip.start||clip.mediaStart<0||volume<0||volume>1||Math.abs(clip.sourceDuration-source.durationSec)>1e-8)return refuse('Native media cache outside supported contract');
   ${tree ? "treeMediaGuard(el,clip.start,clip.end);" : ""}
   const sourceStartSec=clip.mediaStart+nativeSourceTime(rate,clip.start-origin),sourceEndSec=clip.mediaStart+nativeSourceTime(rate,clip.end-origin),timeSec=clip.mediaStart+nativeSourceTime(rate,Math.max(0,Math.min(time,clip.end)-origin));
   if(sourceStartSec<0||sourceEndSec>source.durationSec+1e-8||!Number.isFinite(timeSec))return refuse('Native media source trim outside original duration');
   return {index,id:el.getAttribute('data-hf-render-id')||el.id,kind:source.kind,asset,sha256:source.sha256,startSec:clip.start,endSec:clip.end,originSec:origin,sourceStartSec,sourceEndSec,timeSec,rate,nativeVolume:volume,authoredMuted:nativeMutes.get(el).muted,volume:nativeMutes.get(el).muted?0:volume,active:nativeInWindow(time,clip.start,clip.end),sourceDurationSec:source.durationSec};
  });
 };
 `;
}
