import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { inspectAsset } from "../src/lib/assets/inspect";
import { encodeLosslessWebp } from "../src/lib/icon-resources/webp";
import { spawnSync } from "node:child_process";
import { IconResources } from "../src/lib/icon-resources/service";
import { localCatalogue, localSvg } from "../src/lib/icon-resources/providers";
import { IconHttp, trustedUrl } from "../src/lib/icon-resources/http";
import { validateSvg, styleSvg } from "../src/lib/icon-resources/svg";
import { readProfile, setProfile, scoped, iconFile, readManifest } from "../src/lib/icon-resources/storage";
import { captureIconResources, iconRights } from "../src/lib/icon-resources/usage";
import { CliErrorObject } from "../src/lib/cli";
import { COMMANDS } from "../src/mcp/catalog";
import { prepareCommand, invokeCommand } from "../src/mcp/bridge";

async function fixtureRasteriser(input: string, output: string, _format: string) {
  const size = Number(/width="(\d+)"/.exec(readFileSync(input, "utf8"))![1]);
  if (_format === "webp") {
    const bytes = new Uint8ClampedArray(size * size * 4).fill(128);
    writeFileSync(output, await encodeLosslessWebp(bytes, size, size));
    return;
  }
  const run = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", `color=red@0.5:s=${size}x${size},format=rgba`, "-frames:v", "1", output],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
}
function setup(t: test.TestContext, bespoke = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "icons-space-Привет-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(
    path.join(project, bespoke ? "pipeline/brief.json" : "project.json"),
    bespoke ? ' {"renderMode":"bespoke"}' : "{}",
  );
  return { root, project, service: new IconResources(root, "demo", undefined, fixtureRasteriser) };
}
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="a"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><path fill="url(#a)" d="M0 0H24V24H0Z"/></svg>';
test("all installed collections expose real variants and passive SVGs", () => {
  for (const provider of ["phosphor", "lucide", "tabler", "simple-icons"] as const) {
    const rows = localCatalogue(provider);
    assert.ok(rows.length > 100);
    const item = rows.find((c) => c.name === "shield") ?? rows[0];
    for (const variant of item.variants) assert.ok(validateSvg(localSvg(item, variant)));
    assert.ok(item.rights.notice.length > 100);
  }
});
test("safe gradients preserve paint, dangerous XML and references fail", async () => {
  validateSvg(svg);
  assert.ok(styleSvg(svg, { size: 64, padding: 4, background: "transparent" }).includes("url(#a)"));
  for (const bad of [
    "<!DOCTYPE svg><svg/>",
    '<svg xmlns="http://www.w3.org/2000/svg" onload="x"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://evil.test)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a" href="#a"/></defs></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path /></svg><svg/>',
  ])
    assert.throws(() => validateSvg(bad));
});
test("offline Russian search, profile lock and revision conflict", async (t) => {
  const { root, service } = setup(t);
  setProfile(root, "demo", { provider: "phosphor", variant: "duotone" });
  const search = await service.search({ query: "защита персональных данных", offline: true });
  assert.ok(search.results.some((c) => c.name.includes("shield")));
  assert.equal(search.results[0].provider, "phosphor");
  assert.ok(search.statuses.some((s) => s.status === "offline"));
  assert.throws(() => setProfile(root, "demo", { provider: "lucide", variant: "outline" }), /expected-revision/);
  await assert.rejects(() => service.acquire("lucide:shield"), /profile/);
  const a = await service.acquire("phosphor:shield", { offline: true });
  assert.equal(a.variant, "duotone");
  assert.equal((await service.acquire("phosphor:shield", { offline: true })).id, a.id);
  assert.equal(readManifest(root, "demo").acquisitions.length, 1);
  setProfile(root, "demo", { provider: "lucide", variant: "outline" }, readProfile(root, "demo")!.revision);
  assert.equal(readProfile(root, "demo")!.provider, "lucide");
  await assert.rejects(() => service.export(a.id), /profile/);
});
test("bespoke acquisition, inspected SVG PNG WebP, identity and tamper detection", async (t) => {
  const { root, service } = setup(t, true);
  const a = await service.acquire("phosphor:shield", { offline: true });
  for (const format of ["svg", "png", "webp"] as const) {
    const d = await service.export(a.id, { format, size: 64, padding: 8, colour: "#ff0000" });
    assert.ok(d.absolutePath.startsWith(root));
    assert.equal((await service.export(a.id, { format, size: 64, padding: 8, colour: "#ff0000" })).id, d.id);
    if (format !== "svg") {
      const info = inspectAsset(d.absolutePath);
      assert.equal(info.media.width, 64);
      assert.equal(info.media.hasAlpha, true);
    }
    const captured: string[] = [];
    captureIconResources(root, "demo", d.usage, (file) => captured.push(file));
    assert.ok(captured.includes(d.absolutePath));
    assert.ok(captured.some((f) => f.endsWith(".licence.txt")));
    assert.equal(iconRights(root, "demo", path.relative(root, d.absolutePath), d.hash)?.allowed, true);
    assert.throws(() =>
      captureIconResources(root, "demo", { ...d.usage, src: "projects/demo/incorrect.svg" }, () => {}),
    );
  }
  assert.deepEqual(service.check(), { acquisitions: 1, derivatives: 3 });
  writeFileSync(scoped(root, "demo", a.original), "corrupt");
  assert.throws(() => service.check(), /changed|SVG/);
});
test("project survives relocation without provider/cache; brand rights remain unresolved", async (t) => {
  const { root, service } = setup(t);
  const candidate = localCatalogue("simple-icons")[0];
  const a = await service.acquire(candidate.id, { offline: true });
  const d = await service.export(a.id, { size: 32 });
  assert.equal(iconRights(root, "demo", path.relative(root, d.absolutePath), d.hash)?.allowed, false);
  await assert.rejects(() => service.export(a.id, { colour: "#ffffff" }), /brand/);
  const moved = mkdtempSync(path.join(os.tmpdir(), "icons-moved-"));
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  const { cpSync } = await import("node:fs");
  cpSync(path.join(root, "public"), path.join(moved, "public"), { recursive: true });
  const offline = new IconResources(
    moved,
    "demo",
    new IconHttp(async () => {
      throw Error("network forbidden");
    }),
    fixtureRasteriser,
  );
  assert.equal((await offline.acquire(candidate.id, { offline: true })).id, a.id);
  assert.equal((await offline.export(a.id, { size: 32 })).hash, d.hash);
});
test("scope rejects traversal, foreign symlinks and non-project inputs", (t) => {
  const { root, project } = setup(t);
  assert.throws(() => new IconResources(root, "../escape"));
  assert.throws(() => scoped(root, "demo", "projects/other/a.svg"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "icons-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(project, "resources"));
  assert.throws(() => iconFile(root, "demo", "manifest.json"), /symlink/);
  for (const url of [
    "http://api.svgl.app",
    "https://evil.test/a.svg",
    "https://svgl.app/../../secrets",
    "https://api.iconify.design:44/x",
  ])
    assert.throws(() => trustedUrl(url));
});
test("bounded GET retries 429 once, refuses client errors and redirects", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http = new IconHttp(
    async () => {
      calls++;
      return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response("ok");
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  assert.equal((await http.get("https://api.iconify.design/x.svg")).toString(), "ok");
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
  for (const status of [400, 401, 403, 404]) {
    let count = 0;
    await assert.rejects(() =>
      new IconHttp(async () => {
        count++;
        return new Response("", { status });
      }).get("https://api.iconify.design/x.svg"),
    );
    assert.equal(count, 1);
  }
  await assert.rejects(() =>
    new IconHttp(async () => new Response("too large")).get("https://api.iconify.design/x.svg", 2),
  );
});
test("partial discovery is explicit; all failed sources error, offline missing original does not fetch", async (t) => {
  const { root } = setup(t);
  const service = new IconResources(root, "demo", new IconHttp(async () => new Response("bad", { status: 403 })));
  const partial = await service.search({ query: "shield", providers: ["phosphor", "iconify"] });
  assert.equal(partial.partial, true);
  assert.ok(partial.results.length);
  await assert.rejects(() => service.search({ query: "x", providers: ["svgl"] }), /All icon sources/);
  await assert.rejects(() => service.acquire("svgl:16", { offline: true }), /offline/);
});
test("MCP has strict read/write separation, scopes projects and runs from external workspace", async (t) => {
  const { root } = setup(t);
  const options = { root, codeRoot: process.cwd(), allowPaid: false, projectScope: "demo" };
  const read = COMMANDS.find((c) => c.name === "icon_resources_read")!,
    write = COMMANDS.find((c) => c.name === "icon_resources")!;
  assert.equal(read.readOnly, true);
  assert.equal(write.readOnly, false);
  assert.throws(() => prepareCommand(read, { project: "other" }, options));
  assert.throws(() => prepareCommand(read, { project: "demo", action: "acquire", id: "phosphor:shield" }, options));
  assert.throws(() =>
    prepareCommand(write, { project: "demo", action: "acquire", id: "phosphor:shield", output: "/tmp/a" }, options),
  );
  const result = await invokeCommand(
    write,
    { project: "demo", action: "acquire", id: "phosphor:shield", offline: true },
    options,
  );
  assert.equal(result.ok, true);
  const listed = await invokeCommand(read, { project: "demo", action: "list", offline: true }, options);
  assert.equal(listed.ok, true);
});

test("exact imported alias is verified and captured, and brand mono recolouring includes implicit fill", async (t) => {
  const { root, service } = setup(t);
  const a = await service.acquire("phosphor:shield", { offline: true }),
    d = await service.export(a.id, { size: 32 });
  const alias = `projects/demo/assets/imported/${d.hash}.png`,
    files: string[] = [];
  captureIconResources(root, "demo", alias, (file) => files.push(file));
  assert.ok(files.includes(scoped(root, "demo", alias)));
  assert.equal(iconRights(root, "demo", `public/${alias}`, d.hash)?.allowed, true);
  writeFileSync(scoped(root, "demo", alias), "changed");
  assert.throws(() => captureIconResources(root, "demo", alias, () => {}), /copy changed/);
  const brand = localCatalogue("simple-icons").find((c) => c.name === "google")!;
  assert.notEqual(localSvg(brand, "original"), localSvg(brand, "mono"));
  assert.ok(
    styleSvg(localSvg(brand, "mono"), { size: 32, padding: 0, background: "transparent", colour: "#ff0000" }).includes(
      'fill="#ff0000"',
    ),
  );
});
test("cached remote logos obey offline query and explicit Iconify collection is retained", async (t) => {
  const { root } = setup(t);
  let calls = 0;
  const api = new IconHttp(async (input) => {
    calls++;
    const url = String(input);
    if (url.includes("api.svgl.app"))
      return Response.json([
        {
          id: 7,
          title: "Google",
          category: "Search",
          route: "https://svgl.app/library/google.svg",
          url: "https://google.com",
        },
      ]);
    if (url.endsWith(".svg")) return new Response(svg);
    if (url.includes("/search")) return Response.json({ icons: ["ph:shield"] });
    throw Error("Unexpected request");
  });
  const service = new IconResources(root, "demo", api);
  const result = await service.search({ query: "shield", providers: ["iconify"], collection: "ph" });
  assert.equal(result.results[0].id, "iconify:ph:shield");
  await service.acquire("svgl:7");
  const old = calls;
  const cached = await service.search({ query: "stripe", providers: ["svgl"], kind: "brand", offline: true });
  assert.equal(cached.results.length, 0);
  assert.equal(calls, old);
  const google = await service.search({ query: "google", providers: ["svgl"], kind: "brand", offline: true });
  assert.equal(google.results[0].title, "Google");
});

test("bespoke identity preserves unrelated resources with and without an icon manifest", async (t) => {
  const { root, project, service } = setup(t, true);
  const { captureBespokeIdentity } = await import("../src/lib/delivery/bespoke");
  writeFileSync(path.join(project, "pipeline/build.json"), JSON.stringify({ composition: "Demo" }));
  writeFileSync(
    path.join(project, "pipeline/motion-plan.json"),
    JSON.stringify({ fps: 30, shots: [{ startFrame: 0, durationFrames: 30 }] }),
  );
  mkdirSync(path.join(project, "resources"), { recursive: true });
  const manual = path.join(project, "resources/manual.txt");
  writeFileSync(manual, "first");
  const before = captureBespokeIdentity("demo", "square", { rootDir: root });
  assert.ok(before.sources.some((s) => s.path.endsWith("resources/manual.txt")));
  writeFileSync(manual, "second");
  const after = captureBespokeIdentity("demo", "square", { rootDir: root });
  assert.notEqual(before.sourceSnapshotHash, after.sourceSnapshotHash);
  await service.acquire("phosphor:shield", { offline: true });
  const acquired = captureBespokeIdentity("demo", "square", { rootDir: root });
  assert.ok(acquired.sources.some((s) => s.path.endsWith("resources/manual.txt")));
  assert.ok(!acquired.sources.some((s) => s.role === "asset" && s.path.endsWith(".svg")));
});

test(
  "slow browser launch cancellation kills detached descendants and preserves unrelated processes",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root } = setup(t),
      file = path.join(root, "descendant.pid");
    const { runIconWorker } = await import("../src/lib/icon-resources/worker");
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(file)},String(child.pid));setInterval(()=>{},1000);`;
    await assert.rejects(() => runIconWorker(["-e", code], 1500), /timed out/);
    const pid = Number(readFileSync(file, "utf8"));
    const check = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    assert.ok(check.status !== 0 || check.stdout.trim().startsWith("Z"), `descendant ${pid} must not remain live`);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  },
);

test("ownership inventory failure still terminates the authenticated direct worker", async () => {
  const { runIconWorker } = await import("../src/lib/icon-resources/worker");
  let pid = 0;
  await assert.rejects(
    () =>
      runIconWorker(["-e", "setInterval(()=>{},1000)"], 3000, () => ({
        register(child: number) {
          pid = child;
          throw Error("Inventory unavailable");
        },
        capture() {},
        kill() {},
      })),
    /Inventory unavailable/,
  );
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0));
});
