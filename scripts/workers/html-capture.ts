import {assertCompositionProfile,isInstanceExecutionProfile,resolveInstancesPin,verifyInstanceExecutionProfile} from '../../src/lib/backends/native-composition-instances-profile';
import {preflightCompositionInstances,extractInstanceDocument,validateInstanceViewport,type InstanceGraph} from '../../src/lib/backends/native-composition-instances-extract';
import {HYPERFRAMES_TREE_PIN,type StaticTreeGraph} from '../../src/lib/backends/native-composition-tree-prelude';
import {preflightStaticCompositionTree,extractStaticTreeDocument,STATIC_TREE_LIMITS} from '../../src/lib/backends/native-composition-tree';
import {digest} from '../../src/lib/jobs/model-artifacts';
import {isNativeTransportCancellation} from '../../src/lib/backends/native-request-cancellation';
import {runBoundedRenderWorker} from '../../src/lib/longform/bounded-worker';
import {verifyNativeNormalizationReceipt,verifyNativePreparedMedia} from '../../src/lib/backends/native-media-preparation';
import {nativeDecodedFrameAt} from '../../src/lib/backends/native-media-normalization';
import {readNativeJson,nativeFilePin} from '../../src/lib/backends/native-media-files';
import {fileURLToPath} from 'node:url';
import {HYPERFRAMES_MEDIA_PIN,type NativeMediaDescriptor} from '../../src/lib/backends/hyperframes-player-media';
import {probeNativeMedia} from '../../src/lib/backends/hyperframes-media-probe';
/** Trusted isolated worker. Composition JavaScript runs only in Chromium. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import childProcess, { execFileSync, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { openBrowser, ensureBrowser } from "@remotion/renderer";
import {fullPlayerPrelude,HYPERFRAMES_PLAYER_PIN} from "../../src/lib/backends/hyperframes-player";
import { flattenHtmlTiming } from "../../src/lib/backends/html-timing";
import { mixHtmlAudio,mixNativeAudio } from "../../src/lib/backends/html-audio";
import { mediaProbe } from "../../src/lib/audio/analysis";
import type { HtmlWorkerRequest, HtmlFrameAdapter } from "../../src/lib/backends/html-types";
async function main() {
  const request: HtmlWorkerRequest = JSON.parse(
    readFileSync(process.argv[2], "utf8"),
  );
  assertCompositionProfile(request.playerRuntime?.compositionProfile);
  const instanceProfile=isInstanceExecutionProfile(request.playerRuntime?.compositionProfile)?request.playerRuntime!.compositionProfile:undefined;
  if(instanceProfile)verifyInstanceExecutionProfile(instanceProfile);
  const instancePin=instanceProfile?resolveInstancesPin(instanceProfile):undefined;
  let nativeSources:ReturnType<typeof probeNativeMedia>|undefined;let nativeNormalizationReceipt:ReturnType<typeof nativeFilePin>|undefined;
  const nativeAudioDescriptors:NativeMediaDescriptor[]=[];let nativeSignature:string|undefined;
  const nativeRequestCancellations:{path:string;reason:string}[]=[];
  const owned = new Set<ChildProcess>();
  const ownership = (type: string, pid: number) => {
    if (process.connected) process.send?.({type, pid, owner: process.pid, token: request.ownershipToken});
  };
  const killChromeGroup = (child: ChildProcess) => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {timeout: 2000, stdio: "ignore"});
      } catch {}
  };
  const preparationAbort = new AbortController();
  let preparation:Promise<void>|undefined, stopping=false;
  const stopOwned = () => {
    if(stopping)return;
    stopping=true;
    preparationAbort.abort();
    for (const child of owned) killChromeGroup(child);
    // Keep the owner alive until its bounded runner reaps a pre-ACK child.
    void (async()=>{try{await preparation;}catch{}process.exit(143);})();
  };
  // Install before Chrome starts, including the launch/readiness race window.
  process.on("SIGTERM", stopOwned);
  process.on("disconnect", stopOwned);
  if(request.playerRuntime?.normalization){
    if(process.platform!=='darwin')throw Error('Native normalization OS deny-network unavailable');
    const onRegisteredRoot=async(pid:number)=>{
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{process.off('message',ack);reject(Error('Capture parent preparation registration timeout'));},5000);
        const ack=(raw:any)=>{if(raw?.type==='html-native-preparation-registered'&&raw.token===request.ownershipToken&&raw.pid===pid){clearTimeout(timer);process.off('message',ack);resolve();}};
        process.on('message',ack);if(!process.send){clearTimeout(timer);process.off('message',ack);reject(Error('Authenticated capture parent required'));return;}ownership('html-native-preparation-owned',pid);
      });
    };
    preparation = runBoundedRenderWorker(process.execPath,['--import',fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./native-media-preparation.ts',import.meta.url)),process.argv[2]],request.directory,{timeoutMs:30000,stallTimeoutMs:30000,onRegisteredRoot,signal:preparationAbort.signal});
    await preparation;
    if(stopping)throw Error('Native preparation cancelled');
    const receipt=path.join(request.directory,'native-preparation/receipt.json');nativeNormalizationReceipt=nativeFilePin(receipt,request.directory,256*1024);
    nativeSources=verifyNativePreparedMedia(readNativeJson(receipt,request.directory),request.directory);
  }else nativeSources=request.playerRuntime?.mediaProfile?probeNativeMedia(request.assetMap):undefined;
  const installed = await ensureBrowser({logLevel:'error', onBrowserDownload:()=>{throw new Error('Installed Chromium required; offline capture never downloads a browser');}});
  if (!('path' in installed)) throw new Error('Installed Chromium required');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = originalSpawn(...args);
    // During openBrowser this trusted spawn hook records the detached runner.
    // Do not parse browser/user data, accept project-supplied PIDs or kill by name.
    if (child.pid) {
      owned.add(child);
      ownership("html-browser-owned", child.pid);
      child.once("exit", () => {
        killChromeGroup(child); // Reap any remaining helpers before releasing ownership.
        owned.delete(child);
        ownership("html-browser-exited", child.pid!);
      });
    }
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  let browser: Awaited<ReturnType<typeof openBrowser>>;
  try {
    browser = await openBrowser("chrome", {logLevel: "error", browserExecutable: installed.path});
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  try {
    const timing = request.timing ? flattenHtmlTiming(request.timing, request.fps) : [];
    const mediaEvidence: unknown[] = [];
    const adapterEvidence: unknown[] = [];
    let staticTree:StaticTreeGraph|undefined,instances:InstanceGraph|undefined;
    let capturedBytes = 0,servedNativeBytes=0;
    for (const frame of request.frames) {
      const page = await browser.newPage({
        context: () => null,
        logLevel: "error",
        indent: false,
        pageIndex: 0,
        onBrowserLog: null,
        onLog: () => {},
      });
      let settleRequests:()=>Promise<void>=async()=>{};
      try {
        await page.setViewport({
          width: request.width,
          height: request.height,
          deviceScaleFactor: 1,
        });
        type CDP = {
          send: (
            method: string,
            params?: Record<string, unknown>,
          ) => Promise<{ value: Record<string, unknown> }>;
          on: (
            name: string,
            callback: (event: {
              requestId: string;
              networkId?: string;
              canceled?: boolean;
              errorText?: string;
              request: { url: string };
            }) => void,
          ) => void;
        };
        const cdp = page._client() as unknown as CDP;
        const blocked: string[] = [];
        const pendingRequests=new Set<Promise<void>>();
        settleRequests=async()=>{
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{await Promise.race([(async()=>{while(pendingRequests.size)await Promise.all([...pendingRequests]);})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Capture request settlement timeout')),2000);})]);}finally{clearTimeout(timer);}
          if(blocked.length)throw Error('Blocked capture request: '+blocked.join(','));
        };
        const canceledRequests = new Map<string,{id:string;canceled:true;error:string}>();
        cdp.on("Network.loadingFailed",event=>{if(canceledRequests.size<128&&event.canceled===true)canceledRequests.set(event.requestId,{id:event.requestId,canceled:true,error:event.errorText??"cancelled"});});
        await cdp.send("Network.enable");
        const generated: Record<string, Buffer> = {};let nativeRequests=0;
        cdp.on("Fetch.requestPaused", (event) => {
          let registeredAsset:string|undefined;
          const resourcePath=(()=>{try{return new URL(event.request.url).pathname;}catch{return '<invalid-url>';}})();
          const task=(async () => {
            const url = new URL(event.request.url);
            let body: Buffer | undefined,
              mime = "text/html";
            if (
              url.origin === "https://avc.invalid" &&
              url.pathname === "/index.html"
            )
              body = Buffer.from(request.html);
            else if (url.origin === "https://avc.invalid") {
              if(request.playerRuntime && [request.playerRuntime.runtimeAsset,request.playerRuntime.gsapAsset].includes(decodeURIComponent(url.pathname.slice(1))))throw Error("Injected full player runtime must not be reloaded by authored HTML");
              let name: string;
              try {
                name = decodeURIComponent(url.pathname.slice(1));
              } catch {
                name = "";
              }
              const asset = url.pathname.startsWith("/.avc-generated/") ? undefined : request.assetMap[name];
              if (asset) {
                body = readFileSync(asset.path);
                mime = asset.mime;
                if(nativeSources&&Object.hasOwn(nativeSources,name)&&/^(audio|video)\//.test(mime))registeredAsset=name;
              } else if (url.pathname.startsWith("/.avc-generated/") && generated[name]) {
                body = generated[name];
                mime = "image/png";
              }
            }
            if(nativeSources&&(++nativeRequests>128||body&&(servedNativeBytes+=body.length)>256*1024*1024))throw Error('Native media resource request/byte bound');
            if (!body) {
              blocked.push(event.request.url);
              await cdp.send("Fetch.failRequest", {
                requestId: event.requestId,
                errorReason: "BlockedByClient",
              });
              return;
            }
            await cdp.send("Fetch.fulfillRequest", {
              requestId: event.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: "Content-Type", value: mime },
                {
                  name: "Content-Security-Policy",
                  value:
                    "sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'unsafe-inline' " + (["hyperframes-frame-adapter","hyperframes-player"].includes(request.protocol) ? "https://avc.invalid" : "") + "; style-src 'unsafe-inline' https://avc.invalid; img-src https://avc.invalid data:; media-src https://avc.invalid; font-src https://avc.invalid; connect-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'",
                },
              ],
              body: body.toString("base64"),
            });
          })().catch((error) => {
            const cancellation=event.networkId?canceledRequests.get(event.networkId):undefined;
            if(isNativeTransportCancellation({mediaProfile:nativeSources?request.playerRuntime?.mediaProfile:undefined,registeredAsset,requestUrl:event.request.url,networkId:event.networkId,canceledNetworkId:cancellation?.id,canceled:cancellation?.canceled,cancellation:cancellation?.error,error})){
              if(nativeRequestCancellations.length>=128){blocked.push('Native cancellation receipt bound');return;}
              nativeRequestCancellations.push({path:resourcePath,reason:cancellation!.error});
            }else blocked.push(`${String(error)}; resource=${resourcePath}; cancellation=${cancellation?.error}`);
          });
          pendingRequests.add(task);
          void task.then(()=>pendingRequests.delete(task),()=>pendingRequests.delete(task));
        });
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        await page.evaluateOnNewDocument(`(() => {
 const state={violations:[]};Object.defineProperty(window,'__avcGuard',{value:state});
 const forbid=name=>()=>{state.violations.push(name);throw new Error('Unsupported capture clock/network: '+name);};
 for(const name of ['setTimeout','setInterval',${request.protocol === 'hyperframes-frame-adapter' ? '' : "'requestAnimationFrame',"}'fetch','XMLHttpRequest','WebSocket','Worker','SharedWorker','EventSource','RTCPeerConnection','webkitRTCPeerConnection','WebTransport','AudioContext','webkitAudioContext','open'])Object.defineProperty(window,name,{value:forbid(name),writable:false,configurable:false});
 Object.defineProperty(navigator,'sendBeacon',{value:forbid('sendBeacon')});
 ${request.protocol === 'hyperframes-frame-adapter' ? `let rafId=0; const dormant=new Set();Object.defineProperty(window,'requestAnimationFrame',{value:()=>{if(++rafId>1024)throw new Error('FrameAdapter RAF registration limit');dormant.add(rafId);return rafId;},writable:false,configurable:false});Object.defineProperty(window,'cancelAnimationFrame',{value:id=>dormant.delete(id),writable:false,configurable:false});` : ''}
 let seed=${['hyperframes-frame-adapter','hyperframes-player'].includes(request.protocol) ? 1 : frame + 1};Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 Date.now=()=>${request.protocol === "hyperframes-player" ? 0 : Math.round((frame / request.fps) * 1000)};Object.defineProperty(performance,'now',{value:()=>${request.protocol === "hyperframes-player" ? 0 : (frame / request.fps) * 1000}});
 document.addEventListener('securitypolicyviolation',()=>state.violations.push('CSP violation'));
 })()`);
        if(request.protocol === "hyperframes-player") {
          const runtime=request.assetMap[request.playerRuntime!.runtimeAsset],gsap=request.assetMap[request.playerRuntime!.gsapAsset];
          if(runtime.sha256!==(instancePin ? instancePin.runtimeSha256 : request.playerRuntime?.compositionProfile === "static-local-tree-v1" ? HYPERFRAMES_TREE_PIN.runtimeSha256 : nativeSources ? HYPERFRAMES_MEDIA_PIN.runtimeSha256 : HYPERFRAMES_PLAYER_PIN.runtimeSha256) || gsap.sha256!==HYPERFRAMES_PLAYER_PIN.gsapSha256)throw Error("Full player worker pin mismatch");
          const children:Record<string,string>={};let treeSnapshotBytes=Buffer.byteLength(request.html);
          for(const[name,asset]of Object.entries(request.assetMap).filter(([,a])=>a.mime==="text/html")){
            if(request.playerRuntime?.compositionProfile){const pin=nativeFilePin(asset.path,request.directory,STATIC_TREE_LIMITS.childBytes,true);if(pin.sha256!==asset.sha256)throw Error('Static tree child snapshot changed');const html=pin.data!.toString('utf8');if(digest(html)!==pin.sha256)throw Error('Static tree child UTF-8 source differs');treeSnapshotBytes+=pin.bytes;if(treeSnapshotBytes>STATIC_TREE_LIMITS.totalBytes)throw Error('Static tree snapshot aggregate byte bound');children[name]=html;}
            else children[name]=readFileSync(asset.path,'utf8');
          }
          if(request.playerRuntime?.compositionProfile === "static-local-tree-v1"){
            const graph=await preflightStaticCompositionTree(request.html,children,(html,sha256,bytes)=>page.evaluate((input:{extract:string;html:string;sha256:string;bytes:number;assets:string[]})=>{
              const extract=new Function('__name','return ('+input.extract+')')((fn:unknown)=>fn);
              return extract(new DOMParser().parseFromString(input.html,'text/html'),input.sha256,input.bytes,input.assets);
            },{extract:extractStaticTreeDocument.toString(),html,sha256,bytes,assets:Object.keys(request.assetMap)}));
            if(!graph.rootAttributes||graph.nodes.some(node=>!node.authored))throw Error('Static tree inert metadata missing');
            if(graph.rootAttributes['data-start']!==null&&Number(graph.rootAttributes['data-start'])!==0||graph.rootAttributes['data-media-start']!==null&&Number(graph.rootAttributes['data-media-start'])!==0)throw Error('Static tree root shifted origin unsupported');
            if(staticTree&&staticTree.graphSha256!==graph.graphSha256)throw Error('Static tree changed between frames');staticTree=graph;
          }
          if(instanceProfile){
            const graph=await preflightCompositionInstances(request.html,children,Object.keys(request.assetMap),(html,name,assets)=>page.evaluate((input:{extract:string;html:string;name:string;assets:string[]})=>{
              const extract=new Function('__name','return ('+input.extract+')')((fn:unknown)=>fn);
              return extract(new DOMParser().parseFromString(input.html,'text/html'),input.name,input.assets);
            },{extract:extractInstanceDocument.toString(),html,name,assets}));
            validateInstanceViewport(graph,request);
            if(instances&&instances.graphSha256!==graph.graphSha256)throw Error('Composition instances changed between frames');instances=graph;
          }
          await page.evaluateOnNewDocument(fullPlayerPrelude(readFileSync(runtime.path,"utf8"),readFileSync(gsap.path,"utf8"),children,request.fps,request.width,request.height,nativeSources,staticTree,instances));
        }
        await page.goto({
          url: "https://avc.invalid/index.html",
          timeout: 10000,
        });
        const ready = await page.evaluate(async (protocol: string) => {
          const w = window as unknown as {
            AGENTBROS_CAPTURE?: {
              version: number;
              ready?: Promise<void>;
              seek?: unknown;
            };
            __hf?: { duration: number; seek?: unknown };
          };
          if (["hyperframes-player","hyperframes-player-media"].includes(protocol)) {
            // The explicit pinned worker bootstrap validates readiness and seeks below.
          } else if (protocol === "hyperframes-frame-adapter") {
            const native = window as unknown as { AGENTBROS_FRAME_ADAPTER?: HtmlFrameAdapter; __player?: unknown };
            if (native.__player) throw new Error("Full Hyperframes __player runtime unsupported: use explicit paused FrameAdapter bridge");
            const adapter = native.AGENTBROS_FRAME_ADAPTER;
            if (
              !adapter || typeof adapter.id !== "string" || !adapter.id || adapter.id.length > 100 ||
              typeof adapter.getDurationFrames !== "function" || typeof adapter.seekFrame !== "function" ||
              (adapter.init !== undefined && typeof adapter.init !== "function") ||
              (adapter.destroy !== undefined && typeof adapter.destroy !== "function")
            ) throw new Error("Missing explicit AGENTBROS_FRAME_ADAPTER lifecycle contract");
          } else if (protocol === "avc-frame") {
            if (
              w.AGENTBROS_CAPTURE?.version !== 1 ||
              typeof w.AGENTBROS_CAPTURE.seek !== "function"
            )
              throw new Error("Missing AGENTBROS_CAPTURE v1 seek contract");
            await w.AGENTBROS_CAPTURE.ready;
          } else if (
            !w.__hf ||
            !Number.isFinite(w.__hf.duration) ||
            w.__hf.duration <= 0 ||
            typeof w.__hf.seek !== "function"
          )
            throw new Error("Missing Hyperframes duration/seek contract");
          await document.fonts.ready;
          if ([...document.fonts].some((face) => face.status === "error"))
            throw new Error("Font failed to load");
          if (
            document.querySelector(protocol === "hyperframes-player-media" ? "iframe,object,embed,animate,animateTransform,animateMotion,set" : "audio,iframe,object,embed,animate,animateTransform,animateMotion,set")
          )
            throw new Error("Audio/nested documents unsupported");
          return true;
        }, nativeSources ? "hyperframes-player-media" : request.protocol);
        if (!ready) throw new Error("HTML not ready");
        if(request.protocol === "hyperframes-player") {
          let ready=false;
          for(let i=0;i<32;i++){ready=await page.evaluate(async()=>{await Promise.resolve();return Boolean(await (window as any).__avcFullPlayer.flush());});if(ready)break;}
          if(!ready)throw Error("Full player bounded bootstrap did not become ready");
          if(nativeSources){
            const descriptors=await page.evaluate((t:number)=>(window as any).__avcFullPlayer.media(t),frame/request.fps) as NativeMediaDescriptor[];
            const signature=JSON.stringify(descriptors.map(({timeSec,active,...d})=>d));
            if(nativeSignature!==undefined&&signature!==nativeSignature)throw Error('Native media descriptors changed between frames');
            if(nativeSignature===undefined){nativeSignature=signature;nativeAudioDescriptors.push(...descriptors.filter(d=>d.kind==='audio'||nativeSources?.[d.asset]?.normalization?.audio));}
            for(const d of descriptors.filter(d=>d.kind==='video')){
              if(!d.active)continue;const asset=request.assetMap[d.asset],source=nativeSources[d.asset];
              const frameNumber=source.normalization?.video?nativeDecodedFrameAt(source.normalization.video.clock,d.timeSec):Math.floor(d.timeSec*source.sourceFps!+1e-8),decodePath=source.normalization?.video?path.join(request.directory,source.normalization.video.proxy.path):asset.path,file=path.join(request.directory,`native-${frame}-${d.index}.png`),name=`.avc-generated/native-${frame}-${d.index}.png`;
              execFileSync('ffmpeg',['-v','error','-protocol_whitelist','file,pipe','-i',decodePath,'-vf',`select=eq(n\\,${frameNumber})`,'-frames:v','1','-y',file],{timeout:10000,maxBuffer:1024*1024});generated[name]=readFileSync(file);
              await page.evaluate(async(index:number,src:string)=>{const el=document.querySelector<HTMLVideoElement>(`video[data-avc-native-index="${index}"]`)!;const img=el.nextElementSibling as HTMLImageElement;img.src=src;await img.decode();},d.index,'https://avc.invalid/'+name);
              mediaEvidence.push({...d,frame,sourceFrame:frameNumber,profile:'native-local-media-v1'});
            }
          }
          adapterEvidence.push(await page.evaluate(async(f:number)=>await (window as any).__avcFullPlayer.seek(f),frame));
          if(nativeSources){
            const after=await page.evaluate((t:number)=>(window as any).__avcFullPlayer.media(t),frame/request.fps) as NativeMediaDescriptor[];
            if(JSON.stringify(after.map(({timeSec,active,...d})=>d))!==nativeSignature)throw Error('Native media descriptors changed during seek');
            await page.evaluate((serialized:string)=>{const clips=JSON.parse(serialized) as NativeMediaDescriptor[];for(const d of clips.filter(c=>c.active)){const el=document.querySelector<HTMLMediaElement>(`[data-avc-native-index="${d.index}"]`)!;if(Math.abs(el.volume-d.nativeVolume)>1e-8)throw Error('Native media dynamic volume unsupported');}},JSON.stringify(after));
          }
        }
        if(nativeSources){
          await page.evaluate(()=>{for(const el of document.querySelectorAll<HTMLVideoElement>('video')){const img=el.nextElementSibling as HTMLImageElement,style=getComputedStyle(el);for(const key of [...style])img.style.setProperty(key,style.getPropertyValue(key));el.style.visibility='hidden';}for(const el of document.querySelectorAll<HTMLMediaElement>('video,audio')){el.pause();el.muted=true;}});
        }
        if (request.protocol === "hyperframes-frame-adapter") {
          const evidence = await page.evaluate(async (f: number, fps: number, width: number, height: number) => {
            const w = window as unknown as { AGENTBROS_FRAME_ADAPTER: HtmlFrameAdapter; gsap?: { ticker?: { sleep: () => void } } };
            const adapter = w.AGENTBROS_FRAME_ADAPTER;
            await adapter.init?.({compositionId: "avc-capture", fps, width, height, rootElement: document.body});
            w.gsap?.ticker?.sleep();
            const durationFrames = adapter.getDurationFrames();
            if (!Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames > 36001 || f >= durationFrames)
              throw new Error("Frame outside FrameAdapter duration");
            await adapter.seekFrame(f);
            w.gsap?.ticker?.sleep();
            if (adapter.getDurationFrames() !== durationFrames) throw new Error("FrameAdapter duration changed after seek");
            return {frame: f, id: adapter.id, durationFrames, lifecycle: "init/await-seek/destroy", clock: "dormant-RAF/no-timers"};
          }, frame, request.fps, request.width, request.height);
          adapterEvidence.push(evidence);
        }
        const media = await page.evaluate(
          (
            f: number,
            fps: number,
            width: number,
            height: number,
            protocol: string,
            nodes: typeof timing,
          ) => {
            type Seek = (...args: unknown[]) => unknown;
            const w = window as unknown as {
              AGENTBROS_CAPTURE: { seek: Seek };
              __hf: { duration: number; seek: Seek };
            };
            if (protocol === "hyperframes-seek" && f / fps >= w.__hf.duration)
              throw new Error("Frame outside Hyperframes duration");
            if(protocol === "hyperframes-player-media")return [];
            const result =
              ["hyperframes-frame-adapter","hyperframes-player"].includes(protocol) ? undefined : protocol === "avc-frame"
                ? w.AGENTBROS_CAPTURE.seek(f, {
                    fps,
                    width,
                    height,
                    timeSec: f / fps,
                  })
                : w.__hf.seek(f / fps);
            if (
              result &&
              typeof (result as { then?: unknown }).then === "function"
            )
              throw new Error("seek must be synchronous");
            if (
              document.querySelector(
                "audio,iframe,object,embed,animate,animateTransform,animateMotion,set",
              )
            )
              throw new Error(
                "Audio/nested documents/SMIL unsupported after seek",
              );
            if (document.getAnimations().length)
              throw new Error("Uncontrolled CSS/WAAPI animations unsupported");
            for (const node of nodes) {
              if (!node.selector) continue;
              const element = document.querySelector<HTMLElement>(node.selector);
              if (!element) throw new Error("Missing timed element: " + node.selector);
              const active = f / fps >= node.startSec && f / fps < node.endSec;
              if (!active) element.style.visibility = "hidden";
              if (element instanceof HTMLVideoElement) {
                element.dataset.avcStartFrame = String(node.startSec * fps);
                element.dataset.avcSourceStartSec = String(node.sourceStartSec);
                element.dataset.avcRate = String(node.rate);
              }
            }
            return [...document.querySelectorAll("video")].map(
              (video, index) => {
                video.dataset.avcCaptureIndex = String(index);
                if (
                  [
                    "data-start",
                    "data-duration",
                    "data-media-start",
                    "data-playback-rate",
                  ].some((name) => video.hasAttribute(name))
                )
                  throw new Error(
                    "Native Hyperframes media timing is unsupported; use explicit AVC media timing",
                  );
                video.pause();
                video.muted = true;
                const start = Number(video.dataset.avcStartFrame ?? 0),
                  source = Number(video.dataset.avcSourceStartSec ?? 0),
                  rate = Number(video.dataset.avcRate ?? 1);
                if (
                  ![start, source, rate].every(Number.isFinite) ||
                  start < 0 ||
                  source < 0 ||
                  rate <= 0 ||
                  rate > 8
                )
                  throw new Error("Invalid media timing");
                return {
                  index,
                  src: video.currentSrc || video.src,
                  timeSec: source + Math.max(0, (f - start) / fps) * rate,
                  visible: f >= start && getComputedStyle(video).visibility !== "hidden",
                };
              },
            );
          },
          frame,
          request.fps,
          request.width,
          request.height,
          nativeSources ? "hyperframes-player-media" : request.protocol,
          timing,
        );
        for (const video of media) {
          if (!video.visible) { await page.evaluate((index: number) => {document.querySelector<HTMLElement>(`video[data-avc-capture-index="${index}"]`)!.style.visibility="hidden";}, video.index); continue; }
          const url = new URL(video.src);
          const name = decodeURIComponent(url.pathname.slice(1));
          const asset = request.assetMap[name];
          if (
            url.origin !== "https://avc.invalid" ||
            !asset ||
            !asset.mime.startsWith("video/")
          )
            throw new Error("Media must be a snapshotted local video");
          const sourceFrame = path.join(
            request.directory,
            `media-${frame}-${video.index}.png`,
          );
          execFileSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-protocol_whitelist",
              "file,pipe",
              "-i",
              asset.path,
              "-vf",
              `select=gte(t\\,${video.timeSec})`,
              "-frames:v",
              "1",
              "-y",
              sourceFrame,
            ],
            { timeout: 10000, maxBuffer: 1024 * 1024 },
          );
          const generatedName = `.avc-generated/frame-${frame}-${video.index}.png`;
          generated[generatedName] = readFileSync(sourceFrame);
          await page.evaluate(
            (index: number, src: string, visible: boolean) => {
              const original = document.querySelector(
                  `video[data-avc-capture-index="${index}"]`,
                )!,
                image = document.createElement("img"),
                style = getComputedStyle(original);
              for (const key of [...style])
                image.style.setProperty(key, style.getPropertyValue(key));
              image.style.display = visible ? style.display : "none";
              image.src = src;
              original.replaceWith(image);
            },
            video.index,
            "https://avc.invalid/" + generatedName,
            video.visible,
          );
          mediaEvidence.push({
            frame,
            index: video.index,
            asset: name,
            timeSec: video.timeSec,
          });
        }
        await page.evaluate(async (native:boolean) => {
          await Promise.all(
            [...document.images].map((image) => image.decode()),
          );
          await document.fonts.ready;
          if (
            document.querySelector(
              native ? "iframe,object,embed,animate,animateTransform,animateMotion,set" : "audio,iframe,object,embed,animate,animateTransform,animateMotion,set",
            ) ||
            document.getAnimations().length
          )
            throw new Error(
              "Unsupported dynamic elements/animations before screenshot",
            );
          const violations = (
            window as unknown as { __avcGuard: { violations: string[] } }
          ).__avcGuard.violations;
          if (violations.length)
            throw new Error("Capture violation: " + violations.join(","));
          document.body.getBoundingClientRect();
        },Boolean(nativeSources));
        await settleRequests();
        const screenshot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
          clip: {
            x: 0,
            y: 0,
            width: request.width,
            height: request.height,
            scale: 1,
          },
        });
        const bytes = Buffer.from(screenshot.value.data as string, "base64");
        capturedBytes += bytes.length;
        if (
          bytes.length > 16 * 1024 * 1024 ||
          capturedBytes > 128 * 1024 * 1024
        )
          throw new Error("Captured frame exceeds size limit");
        writeFileSync(
          path.join(request.directory, `frame-${frame}.png`),
          bytes,
        );
      } finally {
        if(request.protocol === "hyperframes-player")await page.evaluate(()=>{(window as any).__avcFullPlayer?.dispose();});
        if (request.protocol === "hyperframes-frame-adapter") {
          await page.evaluate(async () => {
            const w = window as unknown as { AGENTBROS_FRAME_ADAPTER?: HtmlFrameAdapter; gsap?: { ticker?: { sleep: () => void } } };
            await w.AGENTBROS_FRAME_ADAPTER?.destroy?.();
            w.gsap?.ticker?.sleep();
          });
        }
        await page.close();
        await settleRequests();
      }
    }
    let video: Record<string, unknown> | undefined;
    let audio: Record<string, unknown> | undefined;
    if (request.encode === "mp4") {
      const output = path.join(request.directory, "video.mp4");
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-framerate",
          String(request.fps),
          "-i",
          path.join(request.directory, "frame-%d.png"),
          "-frames:v",
          String(request.frames.length),
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-y",
          output,
        ],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      if (timing.some(n => n.audioAsset)) audio = mixHtmlAudio(request, timing, output);
      if(nativeAudioDescriptors.length)audio=mixNativeAudio(request,nativeAudioDescriptors,output,nativeSources);
      const probe = mediaProbe(output),
        stream = probe.streams.find((s) => s.codec_type === "video");
      const [numerator, denominator] = (stream?.avg_frame_rate ?? "0/0")
        .split("/")
        .map(Number);
      const encodedFps = numerator / denominator;
      if (
        !stream ||
        stream.width !== request.width ||
        stream.height !== request.height ||
        !Number.isFinite(encodedFps) ||
        Math.abs(encodedFps - request.fps) > 1e-6 ||
        probe.streams.some((s) => s.codec_type === "audio") !== Boolean(audio) ||
        Math.abs(
          Number(probe.format.duration) - request.frames.length / request.fps,
        ) > 0.02
      )
        throw new Error("Encoded video validation failed");
      video = {
        width: stream.width,
        height: stream.height,
        fps: encodedFps,
        durationSec: Number(probe.format.duration),
        audio: Boolean(audio),
      };
    }
    if(request.playerRuntime?.normalization)verifyNativeNormalizationReceipt(nativeSources,request.directory,nativeNormalizationReceipt);
    if(instanceProfile)verifyInstanceExecutionProfile(instanceProfile);
    writeFileSync(
      path.join(request.directory, "worker.json"),
      JSON.stringify({
        protocol: request.protocol,
        ...(instancePin?{nativeInstancesPin:instancePin}:{}),
        ...(staticTree?{staticCompositionTree:staticTree}:{}),...(instances?{staticCompositionInstances:instances}:{}),
        media: mediaEvidence,
        ...(nativeSources?{nativeAudioDescriptors,nativeMediaSources:nativeSources,nativeRequestCancellations}:{}),...(nativeNormalizationReceipt?{nativeNormalizationReceipt}:{}),
        ...(["hyperframes-frame-adapter","hyperframes-player"].includes(request.protocol) ? {frameAdapters: adapterEvidence} : {}),
        audio,
        video,
      }),
    );
  } finally {
    await browser.close({ silent: true });
    process.removeListener("SIGTERM", stopOwned);
    process.removeListener("disconnect", stopOwned);
    process.disconnect?.();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
