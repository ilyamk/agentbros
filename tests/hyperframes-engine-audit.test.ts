import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureBrowser, openBrowser } from "@remotion/renderer";
import { HtmlCaptureSchema } from "../src/lib/backends/html";
const root = path.resolve("tests/fixtures/hyperframes-engine");
const pin = JSON.parse(readFileSync(path.join(root, "provenance.json"), "utf8"));
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const patchedPin = JSON.parse(readFileSync(path.join(root, "patched-provenance.json"), "utf8"));
const enabled = process.env.RUN_HYPERFRAMES_ENGINE_AUDIT === "1";
const engineFile = process.env.HYPERFRAMES_ENGINE_FILE,
  gsapFile = process.env.HYPERFRAMES_GSAP_FILE;

test("full-engine audit receipts are distinct from the shipped supported protocols", () => {
  assert.equal(pin.revision, "9e9b613ccf867f98838617f7424967e056e63de2");
  assert.equal(pin.license, "Apache-2.0");
  assert.equal(
    HtmlCaptureSchema.safeParse({
      htmlFile: "index.html",
      assetRoot: ".",
      width: 64,
      height: 64,
      frames: [0],
      protocol: "hyperframes-engine",
    }).success,
    false,
  );
  assert.equal(hash(readFileSync(path.join(root, "prepare-patched.cjs"))), patchedPin.patchToolSha256);
  assert.equal(hash(readFileSync(path.join(root, patchedPin.typescript.notice))), patchedPin.typescript.noticeSha256);
  for (const p of Object.values(pin.packages) as { notice?: string; noticeSha256?: string }[])
    if (p.notice) assert.equal(hash(readFileSync(path.join(root, p.notice))), p.noticeSha256);
});

// Research fixture, not the product worker. It keeps every clock dormant and
// deliberately observes incompatible cases rather than accepting their output.
async function auditFullPlayer(patched = false) {
  const runtime = patched ? process.env.HYPERFRAMES_PATCHED_ENGINE_FILE : engineFile;
  const activePin = patched ? patchedPin : pin;
  assert.ok(runtime && gsapFile, "Explicit local engine and GSAP artifacts required");
  const engine = readFileSync(runtime),
    gsap = readFileSync(gsapFile);
  assert.equal(hash(engine), activePin.engineSha256);
  assert.equal(engine.length, activePin.engineBytes);
  assert.equal(hash(gsap), pin.gsapSha256);
  const installed = await ensureBrowser({
    logLevel: "error",
    onBrowserDownload: () => {
      throw Error("Installed Chrome only");
    },
  });
  assert.ok("path" in installed);
  const browser = await openBrowser("chrome", { logLevel: "error", browserExecutable: installed.path });
  const deadline = setTimeout(() => {
    void browser.close({ silent: true });
  }, 45000);
  try {
    for (const mode of patched
      ? ["plain", "nested", "recursive", "raf", "timer", "callback", "network"]
      : ["plain", "nested", "recursive", "raf", "network"]) {
      const page = await browser.newPage({
        context: () => null,
        logLevel: "error",
        indent: false,
        pageIndex: 0,
        onBrowserLog: null,
        onLog: () => {},
      });
      try {
        const child = `<!doctype html><style>#childtile{width:32px;height:32px;background:green}</style><div id="childtile"></div>${mode === "recursive" ? '<div data-composition-id="grandchild" data-composition-src="grandchild.html" data-start="0.1" data-duration="0.3"></div>' : ""}<script>window.__timelines.child=gsap.timeline({paused:true}).to('#childtile',{backgroundColor:'yellow',duration:.6,ease:'none'});</script>`;
        const nesting = ["nested", "recursive"].includes(mode)
          ? '<div data-composition-id="child" data-composition-src="child.html" data-start="0.2" data-duration="0.6"></div>'
          : "";
        const authored =
          mode === "timer"
            ? `setTimeout(()=>document.getElementById('counter').textContent='laundered',0);`
            : mode === "callback"
              ? `document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>document.getElementById('counter').textContent='laundered',0));`
              : mode === "raf"
                ? `requestAnimationFrame(()=>document.getElementById('counter').textContent='updated');`
                : mode === "network"
                  ? `fetch('https://denied.invalid/no').catch(()=>{});`
                  : "";
        const html = Buffer.from(
          `<!doctype html><style>html,body{margin:0;overflow:hidden}#tile{width:64px;height:64px;background:red}</style><div data-composition-id="main" data-duration="1" data-width="64" data-height="64">${nesting}<div id="tile"></div><span id="counter">initial</span></div>${patched ? "" : '<script src="gsap.js"></script><script src="engine.js"></script>'}<script>window.__timelines.main=gsap.timeline({paused:true}).to('#tile',{backgroundColor:'blue',duration:1,ease:'none'});${authored}</script>`,
        );
        const assets: Record<string, Buffer> = { "/index.html": html, "/engine.js": engine, "/gsap.js": gsap };
        const blocked: string[] = [];
        const cdp = page._client() as unknown as {
          send: (method: string, params: object) => Promise<{ value: { data: string } }>;
          on: (event: string, handler: (event: { request: { url: string }; requestId: string }) => void) => void;
        };
        cdp.on("Fetch.requestPaused", (event) => {
          const url = new URL(event.request.url),
            body = url.origin === "https://avc.invalid" ? assets[url.pathname] : undefined;
          if (!body) {
            blocked.push(event.request.url);
            void cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
            return;
          }
          void cdp.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: url.pathname.endsWith(".html") ? "text/html" : "text/javascript" },
            ],
            body: body.toString("base64"),
          });
        });
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        await page.evaluateOnNewDocument(`(()=>{
     window.__HF_EXPORT_RENDER_SEEK_CONFIG={fps:10,fpsSource:'render-options'};
     let id=0,executed=0;const timers=new Map(),raf=new Map(),violations=[],loads=[];
     window.__audit={loads,violations,raf,flush(){for(const[k,v]of [...timers])if(v.delay===0){if(++executed>64)throw Error('Bootstrap execution bound');timers.delete(k);v.fn(...v.args);}}};
     const privateRAF=fn=>{if(++id>2048)throw Error('RAF registration bound');raf.set(id,fn);return id;};const privateCancelRAF=k=>raf.delete(k);
     const privateTimeout=(fn,delay=0,...args)=>{if(++id>2048||typeof fn!=='function'||!Number.isFinite(Number(delay))||Number(delay)<0||Number(delay)>10000)throw Error('Timer registration bound');timers.set(id,{fn,delay:Number(delay),args});return id;};const privateClearTimeout=k=>timers.delete(k);
     const privateFetch=async input=>{const url=new URL(String(input),location.href);if(url.href!=='https://avc.invalid/child.html'||loads.length>=2){violations.push(url.href);throw Error('Denied local fetch');}loads.push(url.href);return new Response(${JSON.stringify(child)},{status:200});};
     ${patched ? "for(const k of ['setTimeout','setInterval','requestAnimationFrame','fetch'])Object.defineProperty(window,k,{value:()=>{violations.push(k);throw Error('Authored clock/network forbidden: '+k);},writable:false,configurable:false});" : "requestAnimationFrame=privateRAF;cancelAnimationFrame=privateCancelRAF;setTimeout=privateTimeout;clearTimeout=privateClearTimeout;fetch=privateFetch;setInterval=()=>{throw Error('Intervals forbidden');};"}
     for(const k of ['XMLHttpRequest','WebSocket','Worker','SharedWorker','AudioContext','webkitAudioContext'])window[k]=()=>{violations.push(k);throw Error('Denied '+k);};
     Date.now=()=>0;Object.defineProperty(performance,'now',{value:()=>0});Math.random=()=>.5;
     ${patched ? `const values=new Map();const names=['__player','__playerReady','__renderReady','__clipManifest','__hfWaitForSeekCompletion','__hfRuntimeTeardown'];for(const key of names)Object.defineProperty(window,key,{get:()=>values.get(key),set:()=>{violations.push(key);throw Error('Authored lifecycle shadowing');},configurable:false});window.__avcPrivateEngineClock={publish:(name,value)=>{values.set(name,value);return value;},setTimeout:privateTimeout,clearTimeout:privateClearTimeout,requestAnimationFrame:privateRAF,cancelAnimationFrame:privateCancelRAF,setInterval:privateTimeout,clearInterval:privateClearTimeout,fetch:privateFetch};(function(requestAnimationFrame,cancelAnimationFrame,setTimeout,clearTimeout){${gsap.toString()}}).call(window,privateRAF,privateCancelRAF,privateTimeout,privateClearTimeout);${engine.toString()}` : ""}
    })()`);
        await page.setViewport({ width: 64, height: 64, deviceScaleFactor: 1 });
        await page.goto({ url: "https://avc.invalid/index.html", timeout: 10000 });
        for (let i = 0; i < 10; i++)
          await page.evaluate(async () => {
            await Promise.resolve();
            (window as any).__audit.flush();
          });
        const state = await page.evaluate(() => {
          const w = window as any;
          return {
            ready: w.__renderReady,
            player: w.__playerReady,
            manifest: w.__clipManifest,
            keys: Object.keys(w.__timelines),
            loads: w.__audit.loads,
            violations: w.__audit.violations,
          };
        });
        assert.equal(state.ready, true);
        assert.equal(state.player, true);
        assert.equal(state.manifest.durationInFrames, 10);
        assert.deepEqual(state.manifest.fps, { numerator: 10, denominator: 1 });
        const seeks = [0, 2, 5, 8, 5, 0, 8, 2];
        const pixels = new Map<number, string>();
        for (const frame of seeks) {
          await page.evaluate(async (f: number) => {
            const w = window as any;
            w.__player.pause();
            w.gsap.ticker.sleep();
            w.__player.renderSeek(f / 10, { exact: true, suppressEvents: true });
            await w.__hfWaitForSeekCompletion();
          }, frame);
          const bytes = Buffer.from(
            (await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true })).value.data,
            "base64",
          );
          const sha = hash(bytes);
          if (pixels.has(frame)) assert.equal(sha, pixels.get(frame));
          pixels.set(frame, sha);
        }
        assert.notEqual(pixels.get(0), pixels.get(8));
        if (mode === "nested" || mode === "recursive") {
          assert.deepEqual(state.loads, ["https://avc.invalid/child.html"]);
          assert.ok(state.keys.includes("child"));
        }
        if (mode === "recursive") {
          assert.ok(state.manifest.clips.some((c: { id: string }) => c.id === "grandchild"));
          assert.equal(
            state.keys.includes("grandchild"),
            false,
            "renderReady does not guarantee recursive external timeline readiness",
          );
        }
        if (mode === "raf" || mode === "timer" || mode === "callback")
          assert.equal(
            await page.evaluate(() => document.getElementById("counter")!.textContent),
            "initial",
            "Dormant RAF captures stale authored counter despite renderReady",
          );
        if (mode === "network") assert.ok(state.violations.includes(patched ? "fetch" : "https://denied.invalid/no"));
        else if (patched && mode === "raf") assert.ok(state.violations.includes("requestAnimationFrame"));
        else if (patched && (mode === "timer" || mode === "callback"))
          assert.ok(state.violations.includes("setTimeout"));
        else assert.deepEqual(state.violations, []);
        if (patched)
          assert.equal(
            await page.evaluate(() => Object.hasOwn(window, "__avcPrivateEngineClock")),
            false,
            "Engine consumes and deletes its private clock capability before author scripts",
          );
        assert.deepEqual(blocked, []);
        await page.evaluate(() => {
          const w = window as any;
          w.__hfRuntimeTeardown?.();
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    clearTimeout(deadline);
    await browser.close({ silent: true });
  }
}

test(
  "actual pinned full player: seek pixels, external child readiness gap, RAF gap and denied network",
  { skip: !enabled, timeout: 60000 },
  () => auditFullPlayer(),
);
test(
  "source-exact host-clock patch bootstraps real player while authored globals stay forbidden",
  { skip: !enabled || !process.env.HYPERFRAMES_PATCHED_ENGINE_FILE, timeout: 60000 },
  () => auditFullPlayer(true),
);
