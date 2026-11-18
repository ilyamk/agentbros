import { createRequire } from "node:module";
import path from "node:path";
/** Test-only deterministic TSX entry; callers validate before acquiring Chrome. */
export function chartProofEntrySource(codeRoot: string, durationInFrames: number): string {
  if (!Number.isSafeInteger(durationInFrames) || durationInFrames <= 0)
    throw new Error("Positive integer proof duration required");
  return `import React,{useLayoutEffect}from'react';import{registerRoot,Composition,useCurrentFrame,delayRender,continueRender,cancelRender}from'remotion';
import${JSON.stringify(path.join(codeRoot, "src/index.css"))};
import{GenericProject,calculateProjectMetadata}from${JSON.stringify(path.join(codeRoot, "src/components/GenericProject"))};
const Probe=()=>{const frame=useCurrentFrame();useLayoutEffect(()=>{const h=delayRender('Chart DOM proof');document.fonts.ready.then(()=>{const labels=Array.from(document.querySelectorAll('svg text')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON()}));console.log('CHART_PROOF:'+JSON.stringify({frame,labels,fontsReady:document.fonts.status==='loaded'}));continueRender(h)}).catch(cancelRender);return()=>continueRender(h)},[frame]);return null};
const Video=p=><><GenericProject {...p}/><Probe/></>;
registerRoot(()=> <>{[['landscape',1920,1080],['vertical',1080,1920]].map(([format,width,height])=><Composition key={format} id={'Proof'+format} component={Video} fps={30} width={width} height={height} durationInFrames={${durationInFrames}} calculateMetadata={calculateProjectMetadata}/>)}</>);`;
}

/** Reuse the already installed renderer bundler compiler; parse/transform only, no bundle or execution. */
export function assertChartProofEntrySyntax(source: string): void {
  const require = createRequire(import.meta.url);
  const bundlerRequire = createRequire(require.resolve("@remotion/bundler"));
  const compiler = bundlerRequire("esbuild") as {
    transformSync(source: string, options: { loader: "tsx" }): { code: string };
  };
  compiler.transformSync(source, { loader: "tsx" });
}
