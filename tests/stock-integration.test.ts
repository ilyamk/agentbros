/**
 * End-to-end stock flow without network: ranked search across providers, acquisition with download reporting,
 * asset registry and receipt, credits on request, the strict delivery rights review, the CLI contract and
 * the asset-plan dispatcher.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResourceService } from "../src/lib/resources/service";
import { resourceCredits } from "../src/lib/resources/credits";
import { reviewRights, type Finding } from "../src/lib/delivery/reviews";
import { DeliveryRequestSchema, type RenderIdentity } from "../src/types/delivery";
import { dispatchAsset } from "../src/lib/asset-dispatcher";
import { PNG, TIME, TIME_MS, pixabayImage, routedFetch, unsplashPhoto, type Call } from "./helpers/stock-fixtures";

const hash = "0".repeat(64);
function project(root: string) {
  const dir = path.join(root, "public/projects/demo");
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({
      name: "Stock fixture",
      formats: ["vertical"],
      productName: "Local",
      colors: {},
      voiceoverEnabled: false,
      musicVolume: 0,
      scenes: [{ id: "hook", text: "Hello", visualType: "title", headline: "Hello", durationInFrames: 30 }],
    }),
  );
  return dir;
}

function stockFetch(calls: Call[]) {
  return routedFetch(
    [
      ["api.unsplash.com/photos/abc123/download", { url: "https://images.unsplash.com/photo-1" }],
      ["api.unsplash.com/search/photos", { results: [unsplashPhoto()] }],
      ["pixabay.com/api/", { hits: [pixabayImage()] }],
      ["images.unsplash.com", PNG],
      ["pixabay.com/get/", Buffer.concat([PNG, Buffer.from([0])])],
    ],
    calls,
  ).fetch;
}

test("search → acquire → credits on request → strict delivery rights review", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "stock-flow-")));
  try {
    project(root);
    const calls: Call[] = [];
    const service = new ResourceService({
      fetch: stockFetch(calls),
      credentials: { unsplash: "u", pixabay: "p" },
      now: () => TIME,
      nowMs: () => TIME_MS,
    });
    const found = await service.stock.search("auto", {
      query: "barista latte",
      kind: "image",
      filters: { format: "vertical" },
    });
    const [unsplash, pixabay] = found.results.map((item) => item.candidate);
    assert.equal(unsplash!.provider, "unsplash");
    assert.equal(pixabay!.provider, "pixabay");
    const credited = await service.acquire(unsplash!, {
      projectId: "demo",
      rootDir: root,
      usage: { commercial: true, credit: true },
      target: { format: "vertical" },
    });
    const silent = await service.acquire(pixabay!, {
      projectId: "demo",
      rootDir: root,
      usage: { commercial: true },
      target: { format: "vertical" },
    });
    assert.equal(calls.filter((call) => call.url.includes("/download")).length, 1, "only Unsplash reports downloads");
    assert.match(credited.asset.rights.attribution!, /Photo by Jane Doe/);
    assert.equal(silent.asset.rights.attribution, undefined);

    const requested = resourceCredits("demo", { rootDir: root });
    assert.deepEqual(
      requested.credits.map((credit) => [credit.provider, credit.requested, credit.required]),
      [["unsplash", true, false]],
    );
    assert.deepEqual(requested.lines, ["Jane Doe on Unsplash"]);
    assert.equal(resourceCredits("demo", { rootDir: root, all: true }).credits.length, 2);
    assert.throws(() => resourceCredits("../escape", { rootDir: root }), /Invalid project id/);
    assert.throws(() => resourceCredits("missing", { rootDir: root }), /Project not found/);

    const identity: RenderIdentity = {
      version: 1,
      projectId: "demo",
      format: "vertical",
      captions: "on",
      compositionId: "demo-vertical",
      durationInFrames: 30,
      propsHash: hash,
      sourceSnapshotHash: hash,
      storyHash: hash,
      editRevision: null,
      sources: [
        { path: `public/${credited.asset.files.original}`, sha256: credited.asset.hash, role: "asset" },
        { path: `public/${silent.asset.files.original}`, sha256: silent.asset.hash, role: "asset" },
      ],
    };
    const request = DeliveryRequestSchema.parse({
      version: 1,
      projectId: "demo",
      formats: ["vertical"],
      variants: ["captioned"],
      placements: ["youtube"],
      approvalMode: "manual",
      commercial: true,
      loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
    });
    const findings: Finding[] = [];
    const records = reviewRights(root, request, [identity], findings) as {
      sha256: string;
      allowed: boolean;
      attribution: string;
      evidence: string;
    }[];
    assert.deepEqual(findings, []);
    const bySha = (sha: string) => records.find((record) => record.sha256 === sha)!;
    assert.equal(bySha(credited.asset.hash).allowed, true);
    assert.equal(bySha(credited.asset.hash).evidence, "original-resource-record");
    assert.match(bySha(credited.asset.hash).attribution, /Jane Doe/, "requested credit reaches credits.md");
    assert.equal(bySha(silent.asset.hash).allowed, true);
    assert.equal(bySha(silent.asset.hash).attribution, "", "no credit unless asked for");

    request.usage.standaloneResale = true;
    const blocked: Finding[] = [];
    reviewRights(root, request, [identity], blocked);
    assert.ok(
      blocked.some(
        (finding) => finding.code === "RIGHTS_UNCONFIRMED" && /Unsplash licence forbids/.test(finding.message),
      ),
    );
    assert.ok(blocked.some((finding) => /Pixabay licence forbids/.test(finding.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("asset-plan stock items acquire through the service with a receipt", async (t) => {
  const original = process.cwd();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "stock-dispatch-")));
  process.chdir(root);
  t.after(() => {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  });
  const dir = project(root);
  writeFileSync(
    path.join(dir, "pipeline/asset-plan.json"),
    JSON.stringify({
      assets: [
        {
          id: "hero",
          kind: "stock-photo",
          source: "unsplash",
          targetPath: "assets/images/hero.jpg",
          status: "pending",
          query: "barista latte",
          metadata: { format: "vertical", zoom: 1.2, credit: true },
        },
        {
          id: "nothing",
          kind: "stock-photo",
          source: "unsplash",
          targetPath: "assets/images/none.jpg",
          status: "pending",
          query: "tiny",
          metadata: { format: "vertical", zoom: 2 },
        },
      ],
    }),
  );
  const calls: Call[] = [];
  const stock = new ResourceService({
    fetch: routedFetch(
      [
        ["photos/abc123/download", { url: "x" }],
        ["query=tiny", { results: [unsplashPhoto({ width: 600, height: 900 })] }],
        ["search/photos", { results: [unsplashPhoto()] }],
        ["images.unsplash.com", PNG],
      ],
      calls,
    ).fetch,
    credentials: { unsplash: "u" },
    now: () => TIME,
    nowMs: () => TIME_MS,
  });
  const result = await dispatchAsset({ projectId: "demo", assetId: "hero" }, { stock });
  assert.equal(result.ok, true, result.error ?? "");
  assert.deepEqual(readFileSync(path.join(dir, "assets/images/hero.jpg")), PNG);
  assert.equal(result.metadata.source, "unsplash");
  const receipt = JSON.parse(readFileSync(path.join(root, String(result.metadata.receipt)), "utf8"));
  assert.equal(receipt.usage.credit, true);
  assert.equal(receipt.tracking.status, "reported");
  const plan = JSON.parse(readFileSync(path.join(dir, "pipeline/asset-plan.json"), "utf8"));
  assert.equal(plan.assets[0].status, "done");
  const none = await dispatchAsset({ projectId: "demo", assetId: "nothing" }, { stock });
  assert.equal(none.ok, false);
  assert.match(none.error!, /fills the frame/);
});

test("resources CLI: one JSON line, clear key and provider errors, credits action", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "stock-cli-")));
  try {
    project(root);
    const script = path.resolve("scripts/resources.ts");
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_NO_DOTENV: "1" };
    delete env.UNSPLASH_ACCESS_KEY;
    delete env.PIXABAY_API_KEY;
    delete env.PEXELS_API_KEY;
    const invoke = (args: string[], cwd = process.cwd()) =>
      spawnSync(
        process.execPath,
        ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, script, ...args],
        {
          cwd,
          env,
          encoding: "utf8",
          timeout: 60_000,
        },
      );
    const parse = (result: ReturnType<typeof invoke>) => {
      assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
      return JSON.parse(result.stdout);
    };
    const missing = parse(invoke(["--action", "search", "--provider", "unsplash", "--query", "latte"]));
    assert.equal(missing.ok, false);
    assert.match(missing.message ?? missing.error, /UNSPLASH_ACCESS_KEY/);
    const auto = parse(invoke(["--action", "search", "--provider", "auto", "--kind", "video", "--query", "pour"]));
    assert.equal(auto.ok, false);
    assert.match(auto.message ?? auto.error, /PEXELS_API_KEY or PIXABAY_API_KEY/);
    const bogus = invoke(["--action", "search", "--provider", "flickr", "--query", "latte"]);
    assert.notEqual(bogus.status, 0);
    assert.equal(parse(bogus).ok, false);
    const zoom = parse(invoke(["--action", "search", "--provider", "pixabay", "--query", "x", "--zoom", "2"]));
    assert.equal(zoom.ok, false);
    const providers = parse(invoke(["--action", "providers"]));
    const unsplash = providers.metadata.providers.find((item: { id: string }) => item.id === "unsplash");
    assert.equal(unsplash.route, "api");
    const credits = parse(invoke(["--action", "credits", "--project", "demo"], root));
    assert.equal(credits.ok, true);
    assert.deepEqual(credits.metadata.credits, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stock licence names come from the licence field only; Creative Commons terms always win", async () => {
  const { normalizeLicence } = await import("../src/lib/resources/rights");
  const { classifyTrackLicence } = await import("../src/lib/music/licence");
  assert.equal(normalizeLicence("CC BY-NC 4.0", "https://pixabay.com/users/someone").code, "CC BY-NC");
  assert.equal(normalizeLicence("", "https://pixabay.com/photos/x-1/").code, "unknown");
  assert.equal(normalizeLicence("Unsplash", "https://unsplash.com/license").code, "Unsplash");
  assert.equal(normalizeLicence("Pixabay Content License").code, "Pixabay");
  const track = classifyTrackLicence({ licence: "Pixabay", title: "t", sourceUrl: "https://pixabay.com/music/x" });
  assert.equal(track.licence.commercial, "unknown", "an image stock licence is not a music licence");
});
