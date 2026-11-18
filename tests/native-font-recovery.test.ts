import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import cp from "node:child_process";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { platformFixture, sha, now } from "./platform-audio-fixtures";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { importResource } from "../src/lib/font-resources/registry";
import { createFontManifest, FONT_ROLES, type FontSelection } from "../src/lib/font-resources/manifest";
import { prepareRenderFontContext } from "../src/lib/font-resources/render-context";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { planProjectRender } from "../src/lib/render-plan";
import {
  captureDeliverySnapshot,
  checkDelivery,
  assertReadonlyNativeFontIdentities,
  serializedNativeProps,
} from "../src/lib/delivery/service";
import { deliveryUseContext } from "../src/lib/delivery/use-context";
import { nativePacket } from "../src/lib/delivery/platform-audio-packet";
import { readHandoffWorkerInputs, checkNativeHandoff } from "../src/lib/delivery/platform-audio-handoff-worker";
import { DeliveryRequestSchema } from "../src/types/delivery";
const font = "/System/Library/Fonts/Supplemental/Arial.ttf";
function tree(root: string) {
  const out: Record<string, unknown> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name),
        s = fs.lstatSync(p);
      out[path.relative(root, p)] = {
        dev: s.dev,
        ino: s.ino,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
        size: s.size,
        ...(s.isFile() ? { sha: sha(fs.readFileSync(p)) } : {}),
      };
      if (s.isDirectory() && !s.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
  return out;
}
function guard<T>(action: () => T) {
  const originals: Record<string, unknown> = {},
    asyncOriginals: Record<string, unknown> = {};
  let writes = 0;
  const forbid = () => {
    writes++;
    throw Error("Recovery filesystem write forbidden");
  };
  for (const name of [
    "writeFileSync",
    "writeSync",
    "mkdirSync",
    "linkSync",
    "renameSync",
    "unlinkSync",
    "rmSync",
    "truncateSync",
    "ftruncateSync",
    "appendFileSync",
    "copyFileSync",
    "symlinkSync",
  ]) {
    originals[name] = (fs as any)[name];
    (fs as any)[name] = forbid;
  }
  for (const name of [
    "writeFile",
    "mkdir",
    "link",
    "rename",
    "unlink",
    "rm",
    "truncate",
    "appendFile",
    "copyFile",
    "symlink",
  ]) {
    asyncOriginals[name] = (fsp as any)[name];
    (fsp as any)[name] = forbid;
  }
  const open = fs.openSync;
  originals.openSync = open;
  fs.openSync = ((file: fs.PathLike, flags: string | number, ...rest: unknown[]) => {
    if (
      typeof flags === "string"
        ? flags !== "r"
        : (flags &
            (fs.constants.O_WRONLY |
              fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_TRUNC |
              fs.constants.O_APPEND)) !==
          0
    )
      return forbid();
    return (open as any)(file, flags, ...rest);
  }) as typeof fs.openSync;
  const asyncOpen = fsp.open;
  asyncOriginals.open = asyncOpen;
  fsp.open = ((file: any, flags: any, ...rest: any[]) => {
    if (
      typeof flags === "string"
        ? flags !== "r"
        : (flags &
            (fs.constants.O_WRONLY |
              fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_TRUNC |
              fs.constants.O_APPEND)) !==
          0
    )
      return forbid();
    return (asyncOpen as any)(file, flags, ...rest);
  }) as typeof fsp.open;
  syncBuiltinESMExports();
  try {
    const result = action();
    assert.equal(writes, 0);
    return result;
  } finally {
    Object.assign(fs, originals);
    Object.assign(fsp, asyncOriginals);
    syncBuiltinESMExports();
  }
}
function fakeMedia<T>(movie: string, action: () => T, original?: string) {
  const spawn = cp.spawnSync,
    exec = cp.execFileSync;
  let probes = 0,
    decodes = 0,
    analyses = 0;
  cp.execFileSync = ((binary: unknown, args: string[]) => {
    assert.equal(binary, "ffprobe");
    assert.ok(args.at(-1) === movie || args.at(-1) === original, "Only frozen movie/source fixture probe");
    assert.deepEqual(args.slice(0, -1), [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
    ]);
    probes++;
    return JSON.stringify({
      streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1" }, { codec_type: "audio" }],
      format: { duration: args.at(-1) === movie ? "3" : "10" },
    });
  }) as unknown as typeof cp.execFileSync;
  cp.spawnSync = ((binary: unknown, args: string[]) => {
    assert.equal(binary, "ffmpeg");
    assert.ok(args.includes(movie));
    if (args.includes("-af")) {
      analyses++;
      return {
        status: 0,
        stderr: '{"input_i":"-16","input_tp":"-2","input_lra":"1","input_thresh":"-26"}',
        stdout: "",
      };
    }
    assert.deepEqual(args, ["-v", "error", "-xerror", "-i", movie, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"]);
    decodes++;
    return { status: 0, stderr: "", stdout: "" };
  }) as unknown as typeof cp.spawnSync;
  syncBuiltinESMExports();
  try {
    return { result: action(), counts: () => ({ probes, decodes, analyses }) };
  } finally {
    cp.spawnSync = spawn;
    cp.execFileSync = exec;
    syncBuiltinESMExports();
  }
}
function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "native-font-recovery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = platformFixture(root);
  fs.writeFileSync(
    f.config,
    JSON.stringify({
      name: "CPU-only recovery",
      productName: "CPU",
      tagline: "",
      formats: ["landscape"],
      colors: {},
      musicVolume: 0,
      voiceoverEnabled: true,
      scenes: [
        { id: "title", text: "Protected speech", headline: "Simple", visualType: "title", durationInFrames: 90 },
      ],
    }),
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/frozen.ts"), "// current code fixture\n");
  const info = inspectSfnt(fs.readFileSync(font));
  const resource = importResource(
    "demo",
    font,
    {
      source: "Installed font DATA only",
      licence: "Local diagnostic only",
      licenceText: "No redistribution",
      licenceEvidence: "System original",
      attribution: "Fixture",
      checkedAt: now,
      kind: "font",
      family: info.family,
      style: info.style as "normal",
      weight: info.weight,
      subset: "local",
      requiredText: "Simple CPU Protected speech",
    },
    root,
  );
  const selection: FontSelection = {
    family: info.family,
    weights: [info.weight],
    style: info.style as "normal",
    subset: "local",
    requiredText: "Simple CPU Protected speech",
  };
  const context = path.join(f.project, "font.json");
  fs.writeFileSync(
    context,
    JSON.stringify(
      createFontManifest(
        "demo",
        Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
          (typeof FONT_ROLES)[number],
          FontSelection
        >,
        root,
      ),
    ),
  );
  f.request.fontContext = context;
  f.request.commercial = false;
  const props = planProjectRender("demo", "landscape", root, { timeline: true, captions: "off" }).jobs[0]!.props,
    cache = prepareRenderFontContext("demo", context, props, root),
    identity = captureRenderIdentity("demo", "landscape", {
      rootDir: root,
      timeline: true,
      captions: "off",
      fontContext: context,
    });
  f.entry.selectionReview.usageContextSha256 = deliveryUseContext(root, f.request, [identity]).contextSha256;
  const captured = captureDeliverySnapshot(f.request, { rootDir: root });
  const movie = path.join(root, "out/demo/landscape-clean.mp4");
  fs.mkdirSync(path.dirname(movie), { recursive: true });
  fs.writeFileSync(movie, "OPAQUE CPU DATA: fake media response only, no decode acceptance");
  const outputSha = sha(fs.readFileSync(movie));
  fs.writeFileSync(
    movie + ".receipt.json",
    JSON.stringify({
      version: 1,
      sourceSnapshotHash: identity.sourceSnapshotHash,
      propsHash: identity.propsHash,
      outputSha256: outputSha,
      format: "landscape",
      captions: "off",
      createdAt: now,
      sources: identity.sources,
      evidence: "renderer",
    }),
  );
  const human = {
    reviewedBy: "CPU fixture",
    reviewedAt: now,
    evidence: "Explicit synthetic declarations; no human/legal/render proof",
  };
  f.request.approvalMode = "manual";
  f.request.manualApproval = { ...human, sourceSnapshotHash: captured.snapshot.id, storyHash: identity.storyHash };
  f.request.visualReview = {
    ...human,
    sourceSnapshotHash: captured.snapshot.id,
    outputHashes: [outputSha],
    approved: true,
  };
  f.request.rightsReviews = identity.sources
    .filter((s) => s.role === "asset")
    .map((s) => ({
      ...human,
      sha256: s.sha256,
      sourceUrl: "manual:CPU",
      licence: "Local diagnostic declared only",
      commercialAllowed: false,
      modifiedAllowed: true,
      placements: ["tiktok"],
      attribution: "CPU",
    }));
  f.plan.outputReviews = [
    {
      ...f.review,
      musicContent: "declared-absent",
      entryId: f.entry.id,
      outputSha256: outputSha,
      sourceSnapshotHash: identity.sourceSnapshotHash,
      propsHash: identity.propsHash,
      selectionHash: f.entry.selectionReview.selectionHash,
    },
  ];
  const request = path.join(f.project, "request.json");
  fs.writeFileSync(request, JSON.stringify(f.request));
  const checked = fakeMedia(
    movie,
    () => checkDelivery(f.request, captured.snapshot, { rootDir: root }),
    f.originalFile,
  ).result;
  assert.deepEqual(checked.blockers, [], "Synthetic current gates must actually pass");
  const published = nativePacket(root, f.request, () => ({
    manifest: checked.manifest,
    report: checked.report,
    subtitles: [],
  }));
  return { ...f, context, cache, identity, captured, movie, requestFile: request, resource, published };
}
const options = { skip: !fs.existsSync(font) };
test(
  "actual worker checker positive font recovery observes existing cache with zero writes and exact historical packet/report",
  options,
  (t) => {
    const f = fixture(t),
      before = tree(f.root),
      originalMarker = fs.readFileSync(f.published.marker);
    const result = fakeMedia(
      f.movie,
      () =>
        guard(() => {
          const input = readHandoffWorkerInputs(f.root, {
            request: f.requestFile,
            snapshot: f.captured.file,
            project: "demo",
            recover: f.published.packetId,
          });
          const checked = checkNativeHandoff(f.root, input);
          assert.equal(checked.report, path.join(f.root, input.recovered!.checkReport.file));
          return nativePacket(f.root, input.request, () => checkNativeHandoff(f.root, input), f.published.packetId);
        }),
      f.originalFile,
    );
    assert.equal(result.result.recovered, true);
    assert.equal(result.result.productionReady, false);
    assert.deepEqual(result.counts(), { probes: 9, decodes: 3, analyses: 3 });
    assert.deepEqual(fs.readFileSync(f.published.marker), originalMarker);
    assert.deepEqual(tree(f.root), before);
  },
);
for (const mode of ["missing", "module", "context", "font", "licence", "alias", "source", "outputs"])
  test(`font recovery ${mode} refuses before tools and never repairs cache`, options, (t) => {
    const f = fixture(t);
    if (mode === "missing") fs.unlinkSync(f.cache.modulePath);
    if (mode === "module") fs.writeFileSync(f.cache.modulePath, "corrupt");
    if (mode === "context") fs.writeFileSync(f.context, "{}");
    if (mode === "font") fs.writeFileSync(path.join(f.root, "public", f.resource.original), "corrupt");
    if (mode === "licence") fs.writeFileSync(path.join(f.root, "public", f.resource.licenceFile), "corrupt");
    if (mode === "alias") {
      fs.renameSync(f.cache.modulePath, f.cache.modulePath + ".old");
      fs.symlinkSync(f.cache.modulePath + ".old", f.cache.modulePath);
    }
    if (mode === "source") fs.appendFileSync(path.join(f.root, "src/frozen.ts"), "// old snapshot now stale\n");
    if (mode === "outputs") {
      const s = JSON.parse(fs.readFileSync(f.captured.file, "utf8"));
      s.identities = [];
      fs.writeFileSync(f.captured.file, JSON.stringify(s));
    }
    const before = tree(f.root),
      spawn = cp.spawnSync,
      exec = cp.execFileSync;
    let tools = 0;
    cp.spawnSync = (() => {
      tools++;
      throw Error("No media tools");
    }) as typeof cp.spawnSync;
    cp.execFileSync = (() => {
      tools++;
      throw Error("No media tools");
    }) as typeof cp.execFileSync;
    syncBuiltinESMExports();
    try {
      guard(() =>
        assert.throws(() =>
          readHandoffWorkerInputs(f.root, {
            request: f.requestFile,
            snapshot: f.captured.file,
            recover: f.published.packetId,
          }),
        ),
      );
      assert.equal(tools, 0);
      assert.deepEqual(tree(f.root), before);
    } finally {
      cp.spawnSync = spawn;
      cp.execFileSync = exec;
      syncBuiltinESMExports();
    }
  });
test(
  "trusted service preflight rejects historical props/source identity and public internal flags remain absent",
  options,
  (t) => {
    const f = fixture(t);
    guard(() => {
      assertReadonlyNativeFontIdentities(f.root, f.request, f.captured.snapshot);
      assert.throws(
        () =>
          assertReadonlyNativeFontIdentities(f.root, f.request, {
            ...f.captured.snapshot,
            identities: [{ ...f.identity, propsHash: "0".repeat(64) }],
          }),
        /source changed/,
      );
    });
    for (const key of ["fontContextMode", "persistReport", "checkBoolean"])
      assert.throws(() => DeliveryRequestSchema.parse({ ...f.request, [key]: "prepare" }), /Unrecognized key/);
  },
);

test(
  "native serialized props reject nonfinite/cycles/functions/sparse/undefined arrays without weakening strict identity hashing",
  options,
  (t) => {
    const f = fixture(t),
      props = planProjectRender("demo", "landscape", f.root, { timeline: true, captions: "off" }).jobs[0]!.props;
    assert.ok(Object.hasOwn(props, "audioMaster"));
    assert.equal(props.audioMaster, undefined);
    assert.deepEqual(serializedNativeProps(props), JSON.parse(JSON.stringify(props)));
    for (const bad of [NaN, Infinity, () => {}, [undefined], Array(1)])
      assert.throws(() => serializedNativeProps({ ...props, talkingHead: bad } as any));
    const cycle: any = {};
    cycle.self = cycle;
    assert.throws(() => serializedNativeProps({ ...props, talkingHead: cycle }));
    assert.throws(() =>
      serializedNativeProps({ ...props, scenes: [{ ...props.scenes[0], unknown: undefined }] } as any),
    );
  },
);

for (const mode of ["marker", "report", "copy"])
  test(`actual worker recovery never rewrites corrupt historical ${mode}`, options, (t) => {
    const f = fixture(t),
      marker = JSON.parse(fs.readFileSync(f.published.marker, "utf8"));
    if (mode === "marker") {
      marker.manifest.costs = { changed: 1 };
      fs.writeFileSync(f.published.marker, JSON.stringify(marker));
    }
    if (mode === "report") fs.writeFileSync(path.join(f.root, marker.checkReport.file), "{}");
    if (mode === "copy")
      fs.writeFileSync(path.join(path.dirname(f.published.marker), "landscape-clean.mp4"), "corrupt");
    const before = tree(f.root);
    fakeMedia(
      f.movie,
      () =>
        guard(() =>
          assert.throws(() => {
            const input = readHandoffWorkerInputs(f.root, {
              request: f.requestFile,
              snapshot: f.captured.file,
              recover: f.published.packetId,
            });
            nativePacket(f.root, input.request, () => checkNativeHandoff(f.root, input), f.published.packetId);
          }),
        ),
      f.originalFile,
    );
    assert.deepEqual(tree(f.root), before);
  });
