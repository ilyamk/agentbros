import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ChapterInspectionInputs } from "../src/lib/longform/inspection-inputs";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { adaptLegacyProject } from "../src/lib/timeline-ir/legacy";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { EditCommandSchema } from "../src/types/timeline";
import { ReviewService } from "../src/lib/review-ui/service";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { assertProjectCopyEdits } from "../src/lib/review-ui/copy-validation";
import { startReviewServer } from "../src/lib/review-ui/server";
import { planProjectRender } from "../src/lib/render-plan";
const command = {
  type: "authored-copy" as const,
  trackId: "visual",
  clipId: "hook",
  target: "legacy" as const,
  headline: "Новая\nидея 🎬",
  subtext: null,
};
function fixture(t: { after: (f: () => void) => void }, hook = false) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/copy-edit-")),
    project = path.join(root, "public/projects/demo");
  fs.mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const raw = {
    name: "Demo",
    productName: "Demo",
    formats: ["landscape"],
    colors: {},
    musicVolume: 0,
    voiceoverEnabled: false,
    scenes: [
      {
        id: "hook",
        text: "Original spoken claim",
        headline: "Old headline",
        subtext: "Keep speech",
        visualType: "title",
        durationInFrames: 90,
        custom: { preserve: true },
        ...(hook
          ? {
              template: {
                id: "scene.hook",
                version: 1,
                props: { headline: "Visible hook", subtext: "Visible subtext" },
              },
            }
          : {}),
      },
    ],
  };
  fs.writeFileSync(path.join(project, "project.json"), JSON.stringify(raw));
  const ir = adaptLegacyProject(raw, "demo"),
    service = new ReviewService("demo", root);
  service.store.initialize(ir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project, raw, ir, service, store: service.store };
}
test("literal EN/RU/LF/emoji fields only, protected extension/speech/source/timing/captions exact, hook consumes nested props", (t) => {
  for (const hook of [false, true]) {
    const f = fixture(t, hook),
      cmd = { ...command, target: hook ? ("scene.hook" as const) : ("legacy" as const) },
      before = structuredClone(f.ir),
      after = applyEdit(f.ir, cmd),
      expected = structuredClone(before),
      scene = expected.tracks[0].clips[0].payload!.scene as any,
      target = hook ? scene.template.props : scene;
    target.headline = cmd.headline;
    delete target.subtext;
    assert.deepEqual(after, expected);
    assert.deepEqual(f.ir, before);
    assert.deepEqual(compileTimelineIR(after).duration, compileTimelineIR(before).duration);
  }
});
test("strict fields, target, nonblank headline and drafting/control/line bounds fail without mutation", (t) => {
  const f = fixture(t);
  for (const patch of [
    { headline: null },
    { headline: " " },
    { headline: "x".repeat(81) },
    { subtext: "x".repeat(161) },
    { headline: "a\nb\nc\nd" },
    { subtext: "a\nb\nc\nd\ne" },
    { headline: "x\t" },
    { headline: "x\r" },
    { headline: "x\u202e" },
    { text: "new speech" },
    { style: {} },
    { target: "scene.metric" },
  ])
    assert.throws(() => applyEdit(f.ir, { ...command, ...patch }));
  assert.throws(() =>
    EditCommandSchema.parse({ type: "authored-copy", trackId: "visual", clipId: "hook", target: "legacy" }),
  );
  assert.doesNotThrow(() => applyEdit(f.ir, { ...command, headline: "  literal spaces  ", subtext: "a\nb\nc\nd" }));
});
test("wrong tracks, binding, media, presenter, testimonial and proof/caption templates refuse; extensions untouched", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (ir: any) => (ir.tracks[0].kind = "voiceover"),
    (ir: any) => (ir.tracks[0].clips[0].assetId = "scene:other"),
    (ir: any) => (ir.tracks[0].clips[0].payload.scene.imageUrl = "image.png"),
    (ir: any) => (ir.tracks[0].clips[0].payload.scene.visualType = "testimonial"),
    (ir: any) => (ir.tracks[0].clips[0].payload.scene.leftPanel = { kind: "text", text: "Proof" }),
    (ir: any) => (ir.tracks[0].clips[0].payload.scene.factualClaims = ["Claim"]),
    (ir: any) => (ir.legacyProject.talkingHead = { enabled: true }),
    (ir: any) =>
      (ir.tracks[0].clips[0].payload.scene.template = { id: "text.word-reveal", version: 1, props: { text: "Proof" } }),
  ]) {
    const ir = structuredClone(f.ir);
    mutate(ir);
    const original = structuredClone(ir);
    assert.throws(() => applyEdit(ir, command));
    assert.deepEqual(ir, original);
  }
});
test("readonly preparation/current render payload + stale CAS/one history/UndoRedo and nested batch rollback", (t) => {
  const f = fixture(t),
    bytes = fs.readFileSync(f.store.file),
    originalIdentity = captureRenderIdentity("demo", "landscape", { rootDir: f.root, timeline: true }),
    originalProps = planProjectRender("demo", "landscape", f.root, { timeline: true }).jobs[0].props,
    proposal = f.service.authoredCopyProposal({
      trackId: command.trackId,
      clipId: command.clipId,
      target: command.target,
      headline: command.headline,
      subtext: command.subtext,
      expectedRevision: 0,
    });
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  f.service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command });
  assert.equal(f.store.read().undo.length, 1);
  const props = planProjectRender("demo", "landscape", f.root, { timeline: true }).jobs[0].props;
  assert.notDeepEqual(props.timeline, originalProps.timeline);
  const identity = captureRenderIdentity("demo", "landscape", { rootDir: f.root, timeline: true });
  assert.notEqual(identity.propsHash, originalIdentity.propsHash);
  assert.notEqual(identity.storyHash, originalIdentity.storyHash);
  assert.notEqual(identity.sourceSnapshotHash, originalIdentity.sourceSnapshotHash);
  assert.deepEqual(props.scenes, originalProps.scenes);
  assert.throws(() => f.service.mutate({ action: "edit", expectedRevision: 0, command }), /conflict/);
  f.store.undo(1);
  assert.deepEqual(f.store.read().timeline, f.ir);
  f.store.redo(2);
  assert.equal(
    f.store.read().timeline.tracks[0].clips[0].payload!.scene &&
      (f.store.read().timeline.tracks[0].clips[0].payload!.scene as any).headline,
    command.headline,
  );
  const before = fs.readFileSync(f.store.file);
  assert.throws(() => f.store.apply({ type: "batch", commands: [command, { ...command, clipId: "missing" }] }, 3));
  assert.deepEqual(fs.readFileSync(f.store.file), before);
});
test("source-owned artifact presence including broken alias/FIFO blocks prepare/apply/undo/redo, old commands unchanged", (t) => {
  const f = fixture(t),
    protectedFile = path.join(f.project, "pipeline/workflow-render.json");
  for (const kind of ["regular", "alias", "fifo"]) {
    if (kind === "regular") fs.writeFileSync(protectedFile, "not parsed");
    else if (kind === "alias") fs.symlinkSync(path.join(f.root, "missing"), protectedFile);
    else execFileSync("mkfifo", [protectedFile]);
    const bytes = fs.readFileSync(f.store.file);
    assert.throws(
      () => f.service.dryRun({ expectedRevision: 0, command: { type: "batch", commands: [command] } }),
      /unsupported/,
    );
    assert.throws(() => f.store.apply(command, 0), /unsupported/);
    assert.deepEqual(fs.readFileSync(f.store.file), bytes);
    assert.doesNotThrow(() =>
      assertProjectCopyEdits(
        f.ir,
        { type: "move", trackId: "visual", clipId: "hook", start: { num: 0, den: 1 } },
        "demo",
        f.root,
      ),
    );
    fs.unlinkSync(protectedFile);
  }
  f.store.apply(command, 0);
  fs.writeFileSync(protectedFile, "{}");
  assert.throws(() => f.store.undo(1), /unsupported/);
  fs.unlinkSync(protectedFile);
  f.store.undo(1);
  fs.writeFileSync(protectedFile, "{}");
  assert.throws(() => f.store.redo(2), /unsupported/);
});
test("proposal schema excludes selectors, scoped HTTP auth and parallel CAS one commit", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const { type, ...request } = command,
    body = { ...request, expectedRevision: 0 },
    headers = { origin: app.origin, "x-review-token": app.token, "content-type": "application/json" },
    post = (route: string, data: unknown, h = headers) =>
      fetch(app.origin + route, { method: "POST", headers: h, body: JSON.stringify(data) });
  assert.equal((await post("/api/authored-copy-proposal", body, { ...headers, "x-review-token": "" })).status, 403);
  assert.equal(
    (await post("/api/authored-copy-proposal", body, { ...headers, origin: "http://wrong.invalid" })).status,
    403,
  );
  assert.equal((await post("/api/authored-copy-proposal", { ...body, path: "anything" })).status, 400);
  const p = await post("/api/authored-copy-proposal", body);
  assert.equal(p.status, 200);
  const result = await p.json();
  const responses = await Promise.all([
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: result.command }),
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: result.command }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
});
test("CLI existing single JSON dryrun/apply/undo preserves canonical bytes", (t) => {
  const f = fixture(t),
    canonical = fs.readFileSync(path.join(f.project, "project.json")),
    run = (args: string[]) => {
      const p = spawnSync(
        process.execPath,
        [
          "--import",
          path.resolve("node_modules/tsx/dist/loader.mjs"),
          path.resolve("scripts/timeline-edit.ts"),
          "--project",
          "demo",
          ...args,
        ],
        {
          cwd: f.root,
          env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(p.status, 0, p.stderr);
      assert.equal(p.stdout.trim().split("\n").length, 1);
      assert.equal(JSON.parse(p.stdout).ok, true);
    };
  run(["--revision", "0", "--command", JSON.stringify(command), "--dry-run"]);
  run(["--revision", "0", "--command", JSON.stringify(command)]);
  run(["--revision", "1", "--undo"]);
  assert.deepEqual(f.store.read().timeline, f.ir);
  assert.deepEqual(fs.readFileSync(path.join(f.project, "project.json")), canonical);
});
test("declared legacy facts/education/recipe refuse structurally and through current canonical project guard", (t) => {
  for (const key of ["claims", "declaredClaims", "facts", "educational", "recipe"]) {
    const f = fixture(t),
      value = key === "educational" ? true : key === "recipe" ? "education" : ["Claim"];
    const ir = structuredClone(f.ir);
    ir.legacyProject![key] = value;
    assert.throws(() => applyEdit(ir, command), /declared/);
    fs.writeFileSync(path.join(f.project, "project.json"), JSON.stringify({ ...f.raw, [key]: value }));
    assert.throws(() => f.store.apply(command, 0), /declared/);
  }
});
test("Prepare detects late configuration/authority/journal changes and rejects FIFO/alias journal without writes", (t) => {
  for (const kind of ["config", "authority", "journal"]) {
    const f = fixture(t),
      original = ChapterInspectionInputs.prototype.assertUnchanged;
    let triggered = false;
    try {
      ChapterInspectionInputs.prototype.assertUnchanged = function () {
        original.call(this);
        if (!triggered) {
          triggered = true;
          if (kind === "config")
            fs.writeFileSync(path.join(f.project, "project.json"), JSON.stringify({ ...f.raw, name: "Changed" }));
          else if (kind === "authority") fs.writeFileSync(path.join(f.project, "pipeline/education.json"), "{}");
          else {
            const doc = f.store.read();
            doc.revision++;
            fs.writeFileSync(f.store.file, JSON.stringify(doc));
          }
        }
      };
      const { type, ...patch } = command;
      assert.throws(() => f.service.authoredCopyProposal({ ...patch, expectedRevision: 0 }), /changed|unsupported/);
      assert.equal(triggered, true);
    } finally {
      ChapterInspectionInputs.prototype.assertUnchanged = original;
    }
  }
  for (const kind of ["alias", "fifo"]) {
    const f = fixture(t),
      { type, ...patch } = command;
    if (kind === "alias") {
      const other = path.join(f.project, "real-journal.json");
      fs.copyFileSync(f.store.file, other);
      fs.unlinkSync(f.store.file);
      fs.symlinkSync(other, f.store.file);
    } else {
      fs.unlinkSync(f.store.file);
      execFileSync("mkfifo", [f.store.file]);
    }
    assert.throws(() => f.service.authoredCopyProposal({ ...patch, expectedRevision: 0 }), /regular|alias/);
  }
});
test("split clip ID and original scene binding stay valid, unrelated speech/caption track exact and atomic copy batch", (t) => {
  const f = fixture(t),
    ir = applyEdit(f.ir, {
      type: "split",
      trackId: "visual",
      clipId: "hook",
      at: { num: 45, den: 1 },
      newClipId: "second",
    });
  ir.tracks.push({
    id: "captions",
    kind: "captions",
    clips: [
      {
        id: "words",
        assetId: "words",
        start: { num: 0, den: 1 },
        source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
        rate: { num: 1, den: 1 },
        transition: { kind: "cut" },
        captions: [{ id: "one", text: "Original spoken claim", start: { num: 0, den: 1 }, end: { num: 30, den: 1 } }],
      },
    ],
  });
  const original = structuredClone(ir),
    after = applyEdit(ir, {
      type: "batch",
      commands: [
        { ...command, clipId: "second" },
        { ...command, headline: "First updated", subtext: undefined },
      ],
    });
  assert.deepEqual(after.tracks[1], original.tracks[1]);
  assert.deepEqual(
    after.tracks[0].clips.map((c) => ({
      start: c.start,
      source: c.source,
      rate: c.rate,
      transition: c.transition,
      captions: c.captions,
      assetId: c.assetId,
    })),
    original.tracks[0].clips.map((c) => ({
      start: c.start,
      source: c.source,
      rate: c.rate,
      transition: c.transition,
      captions: c.captions,
      assetId: c.assetId,
    })),
  );
});

test("readonly copy never calls raw Store.read/dryRun or readFileSync journal reopen", (t) => {
  const f = fixture(t),
    originalRead = fs.readFileSync,
    before = originalRead(f.store.file);
  let rawReads = 0;
  f.service.dryRun = () => {
    throw Error("Inherited dryRun tripwire");
  };
  f.store.read = () => {
    throw Error("Store.read tripwire");
  };
  try {
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === f.store.file) {
        rawReads++;
        throw Error("Raw journal reopen tripwire");
      }
      return (originalRead as Function)(...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const { type, ...patch } = command;
    const result = f.service.authoredCopyProposal({ ...patch, expectedRevision: 0 });
    assert.equal(result.revision, 0);
    assert.equal(result.snapshot.durationInFrames, 90);
    assert.equal(rawReads, 0);
    assert.deepEqual(originalRead(f.store.file), before);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
});
test("actual child journal swap to FIFO after initial bounded capture refuses promptly without inherited reopen", (t) => {
  const f = fixture(t),
    serviceFile = path.resolve("src/lib/review-ui/service.ts"),
    inputsFile = path.resolve("src/lib/longform/inspection-inputs.ts");
  const source = `import fs from 'node:fs';import {execFileSync} from 'node:child_process';import * as serviceModule from ${JSON.stringify(serviceFile)};const {ReviewService}=serviceModule.default??serviceModule;import * as inputsModule from ${JSON.stringify(inputsFile)};const {ChapterInspectionInputs}=inputsModule.default??inputsModule;const service=new ReviewService('demo',${JSON.stringify(f.root)}),original=ChapterInspectionInputs.prototype.assertUnchanged;let swapped=false;ChapterInspectionInputs.prototype.assertUnchanged=function(){original.call(this);if(!swapped){swapped=true;fs.unlinkSync(service.store.file);execFileSync('mkfifo',[service.store.file]);}};try{service.authoredCopyProposal(${JSON.stringify({ trackId: command.trackId, clipId: command.clipId, target: command.target, headline: command.headline, subtext: command.subtext, expectedRevision: 0 })});throw Error('Unexpected accepted FIFO');}catch(error){if(!swapped||!/regular/.test(error.message))throw error;console.log(JSON.stringify({swapped,rejected:true,error:error.message}));}`;
  const result = spawnSync(
    process.execPath,
    ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-"],
    {
      input: source,
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 65536,
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.stdout).swapped, true);
  assert.equal(JSON.parse(result.stdout).rejected, true);
  assert.equal(fs.lstatSync(f.store.file).isFIFO(), true);
});
