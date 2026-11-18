import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ingestMedia, readSourceIndex } from "../src/lib/ingest";
import { ingestLocalOcr } from "../src/lib/ingest/local-ocr";
import { ingestLocalVisual } from "../src/lib/ingest/local-visual";
import { importAsset, hashFile } from "../src/lib/assets/registry";
import { boundedEvidenceHash, boundedEvidenceJson } from "../src/lib/ingest/bounded-evidence";
import { sourceWordProposal } from "../src/lib/ingest/word-proposal";
// Include TS loader startup under the full parallel suite; the finite child deadline still catches blocked FIFO reads.
const CLI_DEADLINE_MS = SPAWN_TIMEOUT_MS;
async function fixture(t: test.TestContext) {
  const prior = process.cwd(),
    cli = path.resolve("node_modules/tsx/dist/loader.mjs"),
    script = path.resolve("scripts/media-words.ts"),
    ocrWorker = path.resolve("tests/fixtures/ocr-worker.mjs"),
    visualWorker = path.resolve("tests/fixtures/visual-worker.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "word-canonical-"))),
    project = path.join(root, "public/projects/demo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "project.json"), "{}");
  const source = path.join(root, "source.mp4"),
    frame = path.join(root, "query.png");
  for (const args of [
    ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=64x64:r=30:d=2", "-c:v", "libx264", "-threads", "1", source],
    ["-v", "error", "-i", source, "-frames:v", "1", frame],
  ]) {
    const result = spawnSync("ffmpeg", args);
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  const transcript = path.join(root, "words.json");
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      segments: [
        { text: "One", startSec: 0, endSec: 0.5 },
        { text: "word.", startSec: 0.5, endSec: 1 },
      ],
      wordTimings: {
        version: 1,
        method: "native-word-segments-v1",
        status: "available",
        estimated: true,
        reviewRequired: true,
        rawRows: [
          { text: " One", offsets: { from: 0, to: 500 } },
          { text: " word.", offsets: { from: 500, to: 1000 } },
        ],
      },
    }),
  );
  process.chdir(root);
  t.after(() => {
    process.chdir(prior);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = ingestMedia({
    projectId: "demo",
    sourceFile: source,
    transcriptFile: transcript,
    options: { thumbnailEverySec: 1 },
    localAnalysis: {
      engine: "whisper.cpp",
      identityHash: "1".repeat(64),
      cacheKey: "2".repeat(64),
      model: "injected-protocol-only",
      revision: "fixture",
      modelHash: "3".repeat(64),
      reviewRequired: true,
      segmentation: "sentence-boundaries-v1",
      wordTimingMethod: "native-word-segments-v1",
    },
  });
  const mode = path.join(root, "mode");
  fs.writeFileSync(mode, "ok");
  // Fixture workers expect their mode at argv[2]; wrappers use a literal child argv.
  const make = (name: string, worker: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(
      file,
      "#!" +
        process.execPath +
        '\nconst {spawnSync}=require("node:child_process");const r=spawnSync(' +
        JSON.stringify(process.execPath) +
        ",[" +
        JSON.stringify(worker) +
        "," +
        JSON.stringify(mode) +
        '],{stdio:"inherit"});process.exit(r.status??1);',
      { mode: 0o700 },
    );
    return file;
  };
  const oe = make("ocr-engine", ocrWorker),
    ve = make("visual-engine", visualWorker);
  const ocr = await ingestLocalOcr({
    projectId: "demo",
    indexFile: base.file,
    config: {
      engine: "apple-vision",
      executable: oe,
      executableHash: hashFile(oe),
      workerSource: ocrWorker,
      workerSourceHash: hashFile(ocrWorker),
      revision: 3,
      languages: ["en-US", "ru-RU"],
      maxFrames: 2,
      timeoutMs: 10000,
    },
  });
  const query = importAsset({ projectId: "demo", sourceFile: frame, provenance: { origin: "manual" } }).asset;
  const visual = await ingestLocalVisual({
    projectId: "demo",
    indexFile: ocr.file,
    queryAssetId: query.id,
    config: {
      engine: "apple-vision-feature-print",
      executable: ve,
      executableHash: hashFile(ve),
      workerSource: visualWorker,
      workerSourceHash: hashFile(visualWorker),
      revision: 2,
      maxFrames: 2,
      timeoutMs: 10000,
    },
  });
  return { root, project, cli, script, base, ocr, visual, query };
}
test(
  "bounded canonical reconstruction preserves combined native/OCR/visual pins and old index bytes",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const f = await fixture(t),
      before = fs.readFileSync(f.visual.file);
    assert.deepEqual(
      readSourceIndex("demo", f.visual.file, { boundedEvidence: true }),
      readSourceIndex("demo", f.visual.file),
    );
    assert.equal(sourceWordProposal("demo", f.visual.file).words.length, 2);
    assert.deepEqual(fs.readFileSync(f.visual.file), before);
  },
);
test(
  "actual CLI canonical-index-read races refuse original and every derived evidence FIFO/symlink without output or hanging",
  { skip: process.platform !== "darwin", timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      index = f.visual.index,
      guard = path.join(f.root, "race.cjs"),
      out = path.join(f.project, "proposal.json");
    const targets = [
      index.source.path,
      index.proxy!.path,
      index.thumbnails[0].path,
      index.transcript!.path,
      index.ocrAnalysis!.receipt.path,
      f.base.file,
      f.visual.receiptFile,
      f.ocr.file,
      f.query.files.original,
      path.join(f.project, "pipeline/asset-registry.json"),
    ].map((ref) => (path.isAbsolute(ref) ? ref : path.resolve("public", ref)));
    const indexBefore = fs.readFileSync(f.visual.file);
    for (const target of [...new Set(targets)])
      for (const kind of ["fifo", "symlink"]) {
        const original = fs.readFileSync(target),
          external = path.join(f.root, "external");
        fs.writeFileSync(external, original);
        const code = `const fs=require('node:fs'),cp=require('node:child_process'),m=require('node:module');const open=fs.openSync,read=fs.readSync,fds=new Map();let count=0,fired=false;process.on('exit',()=>process.stderr.write('racecount='+count+' fired='+fired+'\\n'));fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(String(file)===${JSON.stringify(f.visual.file)}){count++;fds.set(fd,count);}return fd;};fs.readSync=function(fd,...args){if(fds.get(fd)===3&&!fired){fired=true;fs.unlinkSync(${JSON.stringify(target)});${kind === "fifo" ? `cp.execFileSync('mkfifo',[${JSON.stringify(target)}]);` : `fs.symlinkSync(${JSON.stringify(external)},${JSON.stringify(target)});`}}return read.call(this,fd,...args);};m.syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('Forbidden network')};for(const id of ['node:http','node:https']){const v=require(id);v.get=v.request=()=>{throw Error('Forbidden network')};}require('node:net').Socket.prototype.connect=()=>{throw Error('Forbidden network')};`;
        fs.writeFileSync(guard, code);
        try {
          const child = spawnSync(
            process.execPath,
            [
              "--require",
              guard,
              "--import",
              f.cli,
              f.script,
              "--project",
              "demo",
              "--index",
              f.visual.file,
              "--output",
              out,
            ],
            { env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH }, encoding: "utf8", timeout: CLI_DEADLINE_MS },
          );
          assert.equal(child.error, undefined, kind + " " + target);
          assert.equal(child.status, 1, child.stdout + child.stderr + " " + target);
          assert.match(child.stderr, /racecount=3 fired=true/);
          assert.equal(child.stdout.trim().split("\n").length, 1);
          assert.equal(JSON.parse(child.stdout).ok, false);
          assert.equal(fs.existsSync(out), false);
          assert.deepEqual(fs.readFileSync(f.visual.file), indexBefore);
        } finally {
          fs.rmSync(target, { force: true });
          fs.writeFileSync(target, original);
        }
      }
  },
);
test("bounded JSON/hash captures initial bytes only and refuses growth/path replacement/corruption", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "canonical-growth-")),
    file = path.join(root, "source");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, "1234567");
  const read = fs.readSync,
    requests: number[] = [];
  try {
    t.mock.method(fs, "readSync", (fd: number, b: Buffer, o: number, n: number, p: number | null) => {
      requests.push(n);
      fs.appendFileSync(file, Buffer.alloc(65536));
      return read(fd, b, o, n, p);
    });
    syncBuiltinESMExports();
    assert.throws(() => boundedEvidenceHash(file), /changed/);
    assert.deepEqual(requests, [7, 1]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  fs.writeFileSync(file, '{"a":1}');
  assert.equal(boundedEvidenceJson(file).hash, hashFile(file));
  assert.deepEqual(boundedEvidenceJson(file).value, { a: 1 });
  let swapped = false;
  try {
    t.mock.method(fs, "readSync", (fd: number, b: Buffer, o: number, n: number, p: number | null) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(file, file + ".old");
        fs.writeFileSync(file, '{"a":1}');
      }
      return read(fd, b, o, n, p);
    });
    syncBuiltinESMExports();
    assert.throws(() => boundedEvidenceJson(file), /changed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  fs.writeFileSync(file, "not JSON");
  assert.throws(() => boundedEvidenceJson(file));
});

test(
  "bounded combined index read refuses corrupted canonical source/receipt/base/query artifacts without changing index",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const f = await fixture(t),
      before = fs.readFileSync(f.visual.file),
      index = f.visual.index;
    const refs = [
      index.source.path,
      index.transcript!.path,
      index.ocrAnalysis!.receipt.path,
      f.base.file,
      f.visual.receiptFile,
      f.ocr.file,
      f.query.files.original,
    ];
    for (const ref of refs) {
      const file = path.isAbsolute(ref) ? ref : path.resolve("public", ref),
        bytes = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from("corrupt")]));
        assert.throws(() => sourceWordProposal("demo", f.visual.file));
        assert.deepEqual(fs.readFileSync(f.visual.file), before);
      } finally {
        fs.writeFileSync(file, bytes);
      }
    }
  },
);

test(
  "word-route sparse oversized index/transcript/registry refuse before their first read and never export",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      index = f.visual.index,
      paths = [
        f.visual.file,
        path.resolve("public", index.transcript!.path),
        path.join(f.project, "pipeline/asset-registry.json"),
      ],
      guard = path.join(f.root, "cap.cjs"),
      out = path.join(f.project, "proposal.json");
    for (const target of paths) {
      const original = fs.readFileSync(target);
      fs.truncateSync(target, 16 * 1024 * 1024 + 1);
      const code = `const fs=require('node:fs'),m=require('node:module');const open=fs.openSync,read=fs.readSync,fds=new Set();let reads=0;fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(String(file)===${JSON.stringify(target)})fds.add(fd);else fds.delete(fd);return fd;};fs.readSync=function(fd,...args){if(fds.has(fd)){reads++;throw Error('Oversize artifact must not be read');}return read.call(this,fd,...args);};m.syncBuiltinESMExports();process.on('exit',()=>process.stderr.write('oversizeReads='+reads+'\\n'));globalThis.fetch=()=>{throw Error('Forbidden network')};for(const id of ['node:http','node:https']){const v=require(id);v.get=v.request=()=>{throw Error('Forbidden network')};}require('node:net').Socket.prototype.connect=()=>{throw Error('Forbidden network')};`;
      fs.writeFileSync(guard, code);
      try {
        const child = spawnSync(
          process.execPath,
          [
            "--require",
            guard,
            "--import",
            f.cli,
            f.script,
            "--project",
            "demo",
            "--index",
            f.visual.file,
            "--output",
            out,
          ],
          { env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH }, encoding: "utf8", timeout: CLI_DEADLINE_MS },
        );
        assert.equal(child.error, undefined);
        assert.equal(child.status, 1, child.stdout);
        assert.equal(child.stdout.trim().split("\n").length, 1);
        const result = JSON.parse(child.stdout);
        assert.equal(result.ok, false);
        assert.match(result.message, /bounded regular/);
        assert.match(child.stderr, /oversizeReads=0/);
        assert.equal(fs.existsSync(out), false);
      } finally {
        fs.writeFileSync(target, original);
      }
    }
    assert.equal(sourceWordProposal("demo", f.visual.file).words.length, 2);
  },
);
