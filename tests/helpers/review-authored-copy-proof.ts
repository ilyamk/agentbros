import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { adaptLegacyProject } from "../../src/lib/timeline-ir/legacy";
import { ReviewService } from "../../src/lib/review-ui/service";
import { planProjectRender } from "../../src/lib/render-plan";
import { importResource } from "../../src/lib/font-resources/registry";
import { inspectSfnt } from "../../src/lib/font-resources/sfnt";
import { FONT_ROLES, createFontManifest } from "../../src/lib/font-resources/manifest";
import { applyEdit } from "../../src/lib/timeline-ir/commands";
import { displayedFontText, prepareRenderFontContext } from "../../src/lib/font-resources/render-context";
export function rendererSourcePins() {
  const resolve = createRequire(import.meta.url),
    rendererRequire = createRequire(resolve.resolve("@remotion/renderer")),
    bundlerRequire = createRequire(resolve.resolve("@remotion/bundler")),
    remotion = path.join(path.dirname(rendererRequire.resolve("remotion/package.json")), "dist/cjs/portal-node.js"),
    studio = path.join(path.dirname(bundlerRequire.resolve("@remotion/studio/package.json")), "dist/renderEntry.js");
  const rendererRoot = path.dirname(resolve.resolve("@remotion/renderer/package.json"));
  return Object.fromEntries(
    [
      remotion,
      studio,
      ...["dist/render-still.js", "dist/browser/Browser.js", "dist/browser/BrowserPage.js"].map((file) =>
        path.join(rendererRoot, file),
      ),
    ].map((file) => [file, pin(file)]),
  );
}

export const formats = ["vertical", "square", "landscape"] as const;
export const fontFile = "/System/Library/Fonts/Supplemental/Arial.ttf";
export const fontSha = "525979822591a3447cfc49d943d6f7683508e25543407871c0ed8fed05fd2bd9";
export const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const pin = (file: string) => hash(fs.readFileSync(file));
export const changedCopy = { headline: "Новая идея\nClear focus", subtext: "Полный текст • One useful message" };
export function requirements() {
  const browser = process.env.COPY_BROWSER_EXECUTABLE,
    evidence = process.env.COPY_EVIDENCE_DIR;
  assert.ok(browser && path.isAbsolute(browser), "Explicit installed browser path required");
  assert.ok(evidence && path.isAbsolute(evidence), "Explicit absolute evidence directory required");
  assert.ok(fs.statSync(browser).isFile());
  assert.equal(pin(fontFile), fontSha, "No implicit font substitute");
  fs.mkdirSync(evidence, { recursive: true });
  return { browser, evidence };
}
export function fixture(root: string, hook: boolean) {
  const id = hook ? "copy-hook" : "copy-legacy",
    project = path.join(root, "public/projects", id);
  fs.mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const raw = {
    name: "Copy diagnostic",
    productName: "Copy",
    formats: [...formats],
    colors: { accent: "#6C5CE7", background: "#0F0F0F", text: "#FFFFFF" },
    musicVolume: 0,
    voiceoverEnabled: false,
    scenes: [
      {
        id: "hook",
        text: "Protected spoken words",
        visualType: "title",
        headline: hook ? "UNCONSUMED SHADOW" : "Original idea",
        subtext: "Original message",
        durationInFrames: 90,
        ...(hook
          ? {
              template: {
                id: "scene.hook",
                version: 1,
                props: { headline: "Исходная идея", subtext: "Полный исходный текст" },
              },
            }
          : {}),
      },
    ],
  };
  const canonical = path.join(project, "project.json");
  fs.writeFileSync(canonical, JSON.stringify(raw));
  const ir = adaptLegacyProject(raw, id);
  ir.tracks.push({
    id: "protected-captions",
    kind: "captions",
    clips: [
      {
        id: "words",
        assetId: "words",
        start: { num: 0, den: 1 },
        source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
        rate: { num: 1, den: 1 },
        transition: { kind: "cut" },
        captions: [
          { id: "protected", text: "Protected spoken words", start: { num: 0, den: 1 }, end: { num: 90, den: 1 } },
        ],
      },
    ],
  });
  const service = new ReviewService(id, root);
  service.store.initialize(ir);
  const original = service.store.read();
  const request = {
    trackId: "visual",
    clipId: "hook",
    target: hook ? ("scene.hook" as const) : ("legacy" as const),
    ...changedCopy,
    expectedRevision: 0,
  };
  const props = (format: (typeof formats)[number]) =>
    planProjectRender(id, format, root, { timeline: true, captions: "off" }).jobs[0].props;
  return { id, project, canonical, canonicalSha: pin(canonical), service, original, request, props };
}
export function expectedCopy(props: ReturnType<ReturnType<typeof fixture>["props"]>) {
  const scene = props.timeline!.tracks.find((t) => t.id === "visual")!.clips[0].payload!.scene as {
    headline: string;
    subtext: string;
    template?: { props: { headline: string; subtext: string } };
  };
  return scene.template?.props ?? scene;
}
export function fontContext(f: ReturnType<typeof fixture>, root: string) {
  const { expectedRevision: _, ...patch } = f.request;
  const originalProps = f.props("landscape"),
    mappedProps = {
      ...originalProps,
      timeline: applyEdit(originalProps.timeline!, { type: "authored-copy", ...patch }),
    },
    requiredText = displayedFontText(originalProps, root, f.id) + displayedFontText(mappedProps, root, f.id);
  const inspected = inspectSfnt(fs.readFileSync(fontFile));
  assert.deepEqual(inspected.missing(requiredText), []);
  assert.ok(inspected.style === "normal" || inspected.style === "italic");
  const licenceText =
    "Installed macOS Arial; private local test fixture only. No redistribution or publication permission is asserted.";
  importResource(
    f.id,
    fontFile,
    {
      kind: "font",
      source: "Installed macOS supplemental Arial.ttf",
      licence: "local-test-no-redistribution",
      licenceText,
      licenceEvidence: "Local installed OS font; no redistribution grant",
      attribution: "Arial / installed macOS",
      checkedAt: "2026-10-12T00:00:00.000Z",
      family: inspected.family,
      weight: inspected.weight,
      style: inspected.style,
      subset: "latin-cyrillic-diagnostic",
      requiredText,
    },
    root,
  );
  const roles = Object.fromEntries(
    FONT_ROLES.map((role) => [
      role,
      {
        family: inspected.family,
        style: inspected.style,
        weights: [inspected.weight],
        subset: "latin-cyrillic-diagnostic",
        requiredText,
      },
    ]),
  ) as Parameters<typeof createFontManifest>[1];
  const manifest = createFontManifest(f.id, roles, root),
    file = path.join(f.project, "font-context.json");
  fs.writeFileSync(file, JSON.stringify(manifest));
  return prepareRenderFontContext(f.id, file, f.props("landscape"), root);
}
export function assertProtected(f: ReturnType<typeof fixture>) {
  const current = f.service.store.read();
  assert.deepEqual(current.timeline.tracks.slice(1), f.original.timeline.tracks.slice(1));
  assert.equal(pin(f.canonical), f.canonicalSha);
  assert.equal((current.timeline.tracks[0].clips[0].payload!.scene as { text: string }).text, "Protected spoken words");
}
export function entrySource(codeRoot: string, fontManifest: ReturnType<typeof fontContext>["manifest"]) {
  return `import React,{useLayoutEffect,useRef}from'react';import{registerRoot,Composition,useCurrentFrame,useVideoConfig,delayRender,continueRender,cancelRender}from'remotion';
import${JSON.stringify(path.join(codeRoot, "src/index.css"))};import{GenericProject,calculateProjectMetadata}from${JSON.stringify(path.join(codeRoot, "src/components/GenericProject"))};
import{admitCopyCanvas,copyDiagnosticObservation,copyDiagnosticJson,exactCopyFacesReady,stableCopyObservation}from${JSON.stringify(path.join(codeRoot, "tests/helpers/copy-canvas-geometry"))};
import{observeCopyText,inspectCopyText}from${JSON.stringify(path.join(codeRoot, "tests/helpers/copy-text-geometry"))};
const expectedFaces=${JSON.stringify(fontManifest.faces.map(({ family, weight, style }) => ({ family, weight, style })))};
const Probe=({timeline})=>{const frame=useCurrentFrame(),{width,height}=useVideoConfig(),marker=useRef(null);useLayoutEffect(()=>{const handle=delayRender('Exact-face mounted copy DOM evidence');let active=true,last={frame,expectedWidth:width,expectedHeight:height,expectedFaces};const observe=async()=>{const deadline=Date.now()+5000;const tick=()=>new Promise(resolve=>setTimeout(resolve,10));const faces=()=>Array.from(document.fonts).map(face=>({family:face.family,weight:face.weight,style:face.style,status:face.status}));let canvas;while(active){const candidates=Array.from(document.querySelectorAll('#remotion-canvas')),fontFaces=faces();canvas=candidates[0];last={...last,fontFaces,canvasCandidates:candidates.map(c=>c.getBoundingClientRect().toJSON()),markerConnected:!!marker.current?.isConnected,markerInCanvas:!!canvas?.contains(marker.current)};if(candidates.length>1)throw Error('Ambiguous renderer canvas');if(canvas&&marker.current?.isConnected&&canvas.contains(marker.current)&&exactCopyFacesReady(expectedFaces,fontFaces))break;if(Date.now()>=deadline)throw Error('Owning canvas/exact manifest font faces did not become ready');await tick();}if(!active)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Post-registration fonts-ready deadline')),Math.max(1,deadline-Date.now()));document.fonts.ready.then(()=>{clearTimeout(timer);resolve()},error=>{clearTimeout(timer);reject(error)})});let previous;while(active){if(Date.now()>=deadline)throw Error('Mounted copy layout did not become exactly stable');const candidates=document.querySelectorAll('#remotion-canvas'),fontFaces=faces();last={...last,fontFaces,canvasCandidates:Array.from(candidates).map(c=>c.getBoundingClientRect().toJSON())};if(!exactCopyFacesReady(expectedFaces,fontFaces))throw Error('Registered manifest font face changed');const canvasRect=admitCopyCanvas({expectedWidth:width,expectedHeight:height,canvasCount:candidates.length,markerConnected:marker.current.isConnected,markerInCanvas:canvas.contains(marker.current),canvas:canvas.getBoundingClientRect().toJSON()});const scene=timeline.tracks.find(t=>t.id==='visual').clips[0].payload.scene,copy=scene.template?.props??scene;const texts=['headline','subtext'].map(key=>{const selected=observeCopyText(canvas,copy[key],document,getComputedStyle),e=selected.element,rawRect=e.getBoundingClientRect().toJSON(),s=getComputedStyle(e),criteria=inspectCopyText(canvasRect,rawRect,copy[key],selected.observation);return{key,text:e.textContent,rawRect,fontFamily:s.fontFamily,fontSize:s.fontSize,opacity:s.opacity,whiteSpace:s.whiteSpace,...criteria}});last={...last,canvasRect,texts};const measured=texts.map(row=>{const diagnostic=copyDiagnosticObservation(canvasRect,row.rawRect);return{...row,rawRect:diagnostic.raw,rect:diagnostic.relative,rectangleValidity:diagnostic.rectangleValidity}}),geometry=JSON.parse(copyDiagnosticJson({canvasRect,texts:measured}));last={...last,texts:measured};if(stableCopyObservation(previous,geometry)){console.log('COPY_DIAGNOSTIC:'+copyDiagnosticJson({...last,stable:true}));console.log('COPY_PROOF:'+copyDiagnosticJson({frame,fontsReady:document.fonts.status==='loaded',fontFaces,expectedFaces,stable:true,canvasRect,expectedWidth:width,expectedHeight:height,markerInCanvas:canvas.contains(marker.current),texts:measured,shadowVisible:canvas.textContent.includes('UNCONSUMED SHADOW')}));continueRender(handle);return;}previous=geometry;await tick();} };observe().catch(e=>{if(active){console.log('COPY_DIAGNOSTIC:'+copyDiagnosticJson({...last,error:String(e)}));cancelRender(e)}});return()=>{active=false;continueRender(handle)}},[frame,timeline,width,height]);return <span hidden ref={marker} data-copy-proof-marker/>};
const Video=p=><><GenericProject {...p}/><Probe timeline={p.timeline}/></>;registerRoot(()=> <>{[['vertical',1080,1920],['square',1080,1080],['landscape',1920,1080]].map(([format,width,height])=><Composition key={format} id={'Copy'+format} component={Video} fps={30} width={width} height={height} durationInFrames={90} calculateMetadata={calculateProjectMetadata}/>)}</>);`;
}
