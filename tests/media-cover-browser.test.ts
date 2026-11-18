import { offlineSmokeFontAliases, blockGoogleFontRequests, measureSmokeStep } from "./helpers/offline-smoke-fonts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { openBrowser, selectComposition, renderStill } from "@remotion/renderer";

// Solid source colours expose contain-letterboxing unambiguously at panel edges.
// The finite budget includes 32 stills and local video decoding on a shared host.
test(
  "production media cover all five Video paths across three formats and preserve presenter crop",
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 240000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "media-cover-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, "public"));
    for (const [name, size] of [
      ["portrait", "90x160"],
      ["landscape", "160x90"],
    ])
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=red:s=${size}:r=30:d=2`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(root, "public", name + ".mp4"),
      ]);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=90x160:r=30:d=2",
      "-vf",
      "drawbox=x=0:y=0:w=90:h=30:color=red:t=fill",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(root, "public", "head.mp4"),
    ]);
    const entry = path.join(root, "entry.tsx");
    writeFileSync(
      entry,
      `import React from "react";import {registerRoot,Composition,AbsoluteFill,staticFile} from "remotion";
 import {TalkingHeadVideo} from ${JSON.stringify(path.resolve("src/templates/talkinghead/TalkingHeadVideo"))};
 import {ArchivalVideoPanel} from ${JSON.stringify(path.resolve("src/templates/leftpanel/ArchivalVideoPanel"))};
 import {TimelineComposition} from ${JSON.stringify(path.resolve("src/components/TimelineComposition"))};
 import {adaptLegacyProject} from ${JSON.stringify(path.resolve("src/lib/timeline-ir/legacy"))};
 import {ProjectConfigSchema} from ${JSON.stringify(path.resolve("src/types/video"))};
 import {projectToVideoProps} from ${JSON.stringify(path.resolve("src/lib/project-props"))};
 import {StockVideoScene} from ${JSON.stringify(path.resolve("src/components/StockVideoScene"))};
 const T=({kind,source,format})=>{const project={name:"fit",productName:"fit",formats:[format],colors:{},musicVolume:0,scenes:[{id:"a",text:"",headline:"",visualType:"title",durationInFrames:60}]}; const props=projectToVideoProps(ProjectConfigSchema.parse(project),"fit",format,false),timeline=adaptLegacyProject(project,"fit");timeline.tracks=timeline.tracks.slice(0,1);timeline.tracks[0].clips[0].assetId="source"; if(kind==="timelinepresenter")timeline.tracks[0].kind="presenter";return <TimelineComposition {...props} timeline={timeline} timelineAssets={{source:{source:source+".mp4",kind:"video"}}}/>;};
 const Head=({position})=><TalkingHeadVideo src={staticFile("head.mp4")} objectPosition={position}/>;
 const C=({kind,source,format})=><AbsoluteFill style={{background:"lime"}}>{kind.startsWith("timeline")?<T kind={kind} source={source} format={format}/>:kind==="presenter"?<TalkingHeadVideo src={staticFile(source+".mp4")}/>:kind==="archival"?<ArchivalVideoPanel kind="archival" videoUrl={source+".mp4"} startFrom={0} entrance="fade"/>:<StockVideoScene headline="" accentColor="white" textColor="white" videoUrl={source+".mp4"}/>}</AbsoluteFill>;
 registerRoot(()=> <><Composition id="HeadBiased" component={Head} width={90} height={90} fps={30} durationInFrames={60}/><Composition id="HeadCentered" component={Head} width={90} height={90} fps={30} durationInFrames={60} defaultProps={{position:"50% 50%"}}/>{[ ["vertical",180,320],["square",240,240],["landscape",320,180]].flatMap(([format,width,height])=>["presenter","archival","stock","timelinevisual","timelinepresenter"].flatMap(kind=>["portrait","landscape"].map(source=><Composition key={format+kind+source} id={format+kind+source} component={C} width={width} height={height} fps={30} durationInFrames={60} defaultProps={{kind,source,format}}/>)))}</>);`,
    );
    const serveUrl = await measureSmokeStep("bundle", () =>
      bundle({
        entryPoint: entry,
        publicDir: path.join(root, "public"),
        webpackOverride: (config) => ({
          ...config,
          resolve: {
            ...config.resolve,
            modules: [path.resolve("node_modules"), "node_modules"],
            alias: {
              ...config.resolve?.alias,
              ...offlineSmokeFontAliases(path.resolve(".")),
            },
          },
        }),
      }),
    );
    const browser = await openBrowser("chrome");
    const googleFontRequests = blockGoogleFontRequests(browser);
    try {
      const headSamples: number[][] = [];
      for (const id of ["HeadBiased", "HeadCentered"]) {
        const composition = await measureSmokeStep(`select:${id}`, () =>
          selectComposition({ serveUrl, id, puppeteerInstance: browser }),
        );
        const output = path.join(root, id + ".png");
        await measureSmokeStep(`render:${id}`, () =>
          renderStill({
            serveUrl,
            puppeteerInstance: browser,
            composition,
            output,
            imageFormat: "png",
            frame: 25,
          }),
        );
        const pixels = await measureSmokeStep(`decode:${id}`, () =>
          execFileSync("ffmpeg", ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]),
        );
        console.error(JSON.stringify({ mediaCase: id, googleFontRequests: googleFontRequests.length }));
        const offset = (3 * 90 + 45) * 3;
        headSamples.push([...pixels.subarray(offset, offset + 3)]);
      }
      assert.ok(headSamples[0][0] > headSamples[0][2] * 2, "30% crop preserves the upper red head marker");
      assert.ok(headSamples[1][2] > headSamples[1][0] * 2, "Explicit centered crop removes that marker");
      for (const [format, width, height] of [
        ["vertical", 180, 320],
        ["square", 240, 240],
        ["landscape", 320, 180],
      ] as const)
        for (const kind of ["presenter", "archival", "stock", "timelinevisual", "timelinepresenter"])
          for (const source of ["portrait", "landscape"]) {
            const id = format + kind + source,
              composition = await measureSmokeStep(`select:${id}`, () =>
                selectComposition({ serveUrl, id, puppeteerInstance: browser }),
              );
            const output = path.join(root, id + ".png");
            await measureSmokeStep(`render:${id}`, () =>
              renderStill({
                serveUrl,
                puppeteerInstance: browser,
                composition,
                output,
                imageFormat: "png",
                frame: 25,
              }),
            );
            const pixels = await measureSmokeStep(`decode:${id}`, () =>
              execFileSync("ffmpeg", ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
                maxBuffer: width * height * 4,
              }),
            );
            console.error(JSON.stringify({ mediaCase: id, googleFontRequests: googleFontRequests.length }));
            for (const [x, y] of [
              [Math.floor(width / 2), 3],
              [Math.floor(width / 2), height - 4],
              [3, Math.floor(height / 2)],
              [width - 4, Math.floor(height / 2)],
            ]) {
              const offset = (y * width + x) * 3;
              assert.ok(
                pixels[offset] > 20 &&
                  pixels[offset] > pixels[offset + 1] * 2 &&
                  pixels[offset] > pixels[offset + 2] * 2,
                `${id} edge (${x},${y}) must contain source red rather than a letterbox/background`,
              );
            }
          }
      assert.deepEqual(googleFontRequests, [], "Media crop smoke must not request Google fonts");
    } finally {
      await browser.close({ silent: true });
    }
  },
);
