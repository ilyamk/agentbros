import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { nativeWords, validateNativeWordOutput } from "../src/types/native-word-timing";
import {
  LocalWorkerConfigSchema,
  probeLocalWorker,
  runLocalWorker,
  localWorkerFileHash,
} from "../src/lib/ingest/local-worker";
import { ingestLocalMedia } from "../src/lib/ingest/local-analysis";
import { sourceWordProposal } from "../src/lib/ingest/word-proposal";
import { writeTone } from "./helpers/review-audio";
import { stableHash } from "../src/lib/longform/plans";
import { hashFile } from "../src/lib/assets/registry";
const evidence = () => ({
  version: 1,
  method: "native-word-segments-v1",
  status: "available",
  estimated: true,
  reviewRequired: true,
  rawRows: [
    { text: "", offsets: { from: 0, to: 20 } },
    { text: " Привет,", offsets: { from: 20, to: 600 } },
    { text: " world.", offsets: { from: 600, to: 1800 } },
  ],
});
function fixture(t: test.TestContext) {
  const prior = process.cwd(),
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-words-")));
  mkdirSync(path.join(root, "public/projects/demo"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/demo/project.json"), "{}");
  const modelPath = path.join(root, "model");
  writeFileSync(modelPath, "good");
  const source = path.join(root, "public/projects/demo/source.wav");
  writeTone(source, 440, 2);
  const config = {
    executable: realpathSync(process.execPath),
    workerFile: path.resolve("tests/fixtures/native-word-worker.mjs"),
    modelPath,
    model: "protocol-fixture",
    revision: "1",
    engine: "whisper.cpp" as const,
    engineExecutable: realpathSync(process.execPath),
    language: "en",
    timeoutMs: 10000,
  };
  process.chdir(root);
  t.after(() => {
    process.chdir(prior);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, config };
}
test("native lexical rows retain exact source bounds/raw whitespace and reject collapse/ambiguity/incomplete/native confidence", () => {
  const raw = evidence(),
    result = nativeWords(raw, 2);
  assert.equal(result.words.length, 2);
  assert.equal(result.evidence.rawRows[1].text, " Привет,");
  assert.deepEqual(
    result.words.map((w) => [w.startSec, w.endSec]),
    [
      [0.02, 0.6],
      [0.6, 1.8],
    ],
  );
  for (const edit of [
    (v: ReturnType<typeof evidence>) => (v.rawRows[1].offsets.to = 20),
    (v: ReturnType<typeof evidence>) => (v.rawRows[1].text = " two words"),
    (v: ReturnType<typeof evidence>) => (v.rawRows[2].offsets.from = 1),
    (v: ReturnType<typeof evidence>) => (v.rawRows[2].offsets.to = 2002),
  ]) {
    const bad = evidence();
    edit(bad);
    assert.throws(() => nativeWords(bad, 2));
  }
  assert.throws(() => nativeWords({ ...raw, confidence: 1 }, 2));
  assert.throws(() => validateNativeWordOutput(raw, 2, [{ text: "Changed", startSec: 0.02, endSec: 0.6 }]));
});
test("explicit alignment-unavailable preserves truthful aggregate ASR evidence and refuses word export", () => {
  const raw = evidence();
  raw.rawRows[1].offsets.to = 20;
  const unavailable = { ...raw, status: "unavailable", reason: "Collapsed native word" };
  const segments = [{ text: "Привет, world.", startSec: 0.02, endSec: 1.8 }];
  assert.equal(validateNativeWordOutput(unavailable, 2, segments).words.length, 0);
  assert.throws(() => nativeWords(unavailable, 2), /unavailable/);
  assert.throws(() => validateNativeWordOutput(unavailable, 2, [{ ...segments[0], text: "Dropped caveat" }]));
});
test("unconfigured runtime identity keeps legacy formula while explicit native method changes cache; pinned output corruption refuses", async (t) => {
  const f = fixture(t),
    payload = { operation: "asr" as const, sourceFile: f.source, sourceHash: hashFile(f.source), durationSec: 2 };
  const old = await runLocalWorker(f.config, payload, "demo");
  assert.equal("wordTimingMethod" in old.capability.identity, false);
  assert.equal(old.key, stableHash({ version: 1, identity: old.capability.identityHash, payload }));
  assert.equal("wordTimings" in old.output, false);
  const config = { ...f.config, wordTimingMethod: "native-word-segments-v1" as const };
  const fresh = await runLocalWorker(config, payload, "demo");
  assert.notEqual(fresh.key, old.key);
  assert.equal((await runLocalWorker(config, payload, "demo")).cacheHit, true);
  assert.equal(probeLocalWorker(config).available, true);
  const stored = JSON.parse(readFileSync(fresh.file, "utf8"));
  stored.output.wordTimings.rawRows[1].text = "Changed";
  writeFileSync(fresh.file, JSON.stringify(stored));
  await assert.rejects(() => runLocalWorker(config, payload, "demo"), /checksum/);
  assert.equal(
    LocalWorkerConfigSchema.safeParse({ ...config, engine: "sentence-transformers", dimensions: 2 }).success,
    false,
  );
});
test("opt-in indexes keep words separate from sentence groups; proposal and actual isolated CLI pins survive reread and old indexes refuse word claim", async (t) => {
  const cli = path.resolve("node_modules/tsx/dist/cli.mjs"),
    script = path.resolve("scripts/media-words.ts"),
    f = fixture(t);
  const old = await ingestLocalMedia({ projectId: "demo", sourceFile: f.source, config: f.config });
  assert.throws(() => sourceWordProposal("demo", old.file), /no requested/);
  const fresh = await ingestLocalMedia({
    projectId: "demo",
    sourceFile: f.source,
    config: { ...f.config, wordTimingMethod: "native-word-segments-v1" },
  });
  const proposal = sourceWordProposal("demo", fresh.file);
  assert.equal(proposal.words.length, 2);
  assert.equal(fresh.index!.segments.length, 1);
  assert.equal(proposal.approved, false);
  assert.equal(proposal.reviewRequired, true);
  assert.deepEqual(sourceWordProposal("demo", fresh.file), proposal);
  assert.throws(() => sourceWordProposal("demo", fresh.file, true), /CFR video/);
  const guard = path.join(f.root, "deny.cjs"),
    output = path.join(f.root, "public/projects/demo/words.json");
  writeFileSync(
    guard,
    "globalThis.fetch=()=>{throw Error('Forbidden network')};for(const id of ['node:http','node:https']){const m=require(id);m.get=m.request=()=>{throw Error('Forbidden network')};}require('node:net').Socket.prototype.connect=()=>{throw Error('Forbidden network')};",
  );
  const args = ["--require", guard, cli, script, "--project", "demo", "--index", fresh.file, "--output", output];
  const child = spawnSync(process.execPath, args, {
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), proposal);
  assert.equal(JSON.parse(child.stdout).metadata.approved, false);
  const duplicate = spawnSync(process.execPath, args, {
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(duplicate.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), proposal);
  writeFileSync(path.resolve("public", fresh.index!.source.path), "changed");
  assert.throws(() => sourceWordProposal("demo", fresh.file), /checksum/);
  assert.ok(existsSync(output));
});

test("native unavailable indexes retain segment ASR and explicit status; self-consistent corrupted word evidence refuses", async (t) => {
  const f = fixture(t),
    config = { ...f.config, wordTimingMethod: "native-word-segments-v1" as const };
  writeFileSync(f.config.modelPath, "unavailable");
  const result = await ingestLocalMedia({ projectId: "demo", sourceFile: f.source, config });
  assert.equal(result.wordAlignment!.status, "unavailable");
  assert.equal(result.index!.segments[0].text, "Привет, world.");
  assert.throws(() => sourceWordProposal("demo", result.file), /unavailable/);
  writeFileSync(f.config.modelPath, "bad");
  await assert.rejects(
    () => ingestLocalMedia({ projectId: "demo", sourceFile: f.source, config }),
    /overlap|incomplete/,
  );
});
test("actual CFR frame proposal uses physical clock; stale declared rate and collapsed native word refuse without stretch", async (t) => {
  const f = fixture(t),
    video = path.join(f.root, "public/projects/demo/source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-threads",
    "1",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=64x64:r=30:d=2",
    "-i",
    f.source,
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-shortest",
    video,
  ]);
  const config = { ...f.config, wordTimingMethod: "native-word-segments-v1" as const },
    first = await ingestLocalMedia({ projectId: "demo", sourceFile: video, config, options: { thumbnailEverySec: 5 } });
  const proposal = sourceWordProposal("demo", first.file, true);
  assert.equal(proposal.clock, "source-frames");
  assert.equal(proposal.fps!.num, 30);
  assert.equal("startFrame" in proposal.words[0], true);
  const bytes = readFileSync(first.file),
    index = JSON.parse(bytes.toString());
  index.source.fps.num = 60;
  writeFileSync(first.file, JSON.stringify(index));
  assert.throws(() => sourceWordProposal("demo", first.file, true), /differs from immutable/);
  writeFileSync(first.file, bytes);
  writeFileSync(f.config.modelPath, "short");
  const short = await ingestLocalMedia({
    projectId: "demo",
    sourceFile: video,
    config,
    options: { thumbnailEverySec: 5 },
  });
  assert.equal(sourceWordProposal("demo", short.file).words[1].endSec, 0.61);
  assert.throws(() => sourceWordProposal("demo", short.file, true), /collapses/);
});
test("actual Python worker with missing native CLI flags retains segment ASR and unavailable status without a second inference", async (t) => {
  const workerFile = path.resolve("scripts/workers/local-analysis.py"),
    f = fixture(t),
    engine = path.join(f.root, "ordinary-engine");
  const python = spawnSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", timeout: 5000 });
  if (python.status !== 0) {
    t.skip("Installed Python unavailable; no installation");
    return;
  }
  const executable = realpathSync(python.stdout.trim());
  writeFileSync(
    engine,
    "#!" +
      process.execPath +
      "\nconst fs=require('node:fs');if(process.argv.includes('--help')){console.log('--model --file --output-json');process.exit(0);}fs.appendFileSync(" +
      JSON.stringify(engine + ".calls") +
      ",'1');const prefix=process.argv[process.argv.indexOf('-of')+1];fs.writeFileSync(prefix+'.json',JSON.stringify({transcription:[{text:'One complete statement.',offsets:{from:0,to:1800}}]}));",
    { mode: 0o755 },
  );
  const result = await ingestLocalMedia({
    projectId: "demo",
    sourceFile: f.source,
    config: {
      ...f.config,
      executable,
      workerFile,
      engineExecutable: engine,
      wordTimingMethod: "native-word-segments-v1",
    },
  });
  assert.equal(result.wordAlignment!.status, "unavailable");
  assert.equal(result.index!.segments[0].text, "One complete statement.");
  assert.equal(readFileSync(engine + ".calls", "utf8"), "1");
  assert.throws(() => sourceWordProposal("demo", result.file), /unavailable/);
});

test("native evidence hash is bounded to captured bytes and rejects real growth/final symlink without waiting", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "seven");
  writeFileSync(file, "1234567");
  const read = fs.readSync,
    requests: number[] = [];
  try {
    t.mock.method(
      fs,
      "readSync",
      (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        requests.push(length);
        fs.appendFileSync(file, Buffer.alloc(65536));
        return read(fd, buffer, offset, length, position);
      },
    );
    syncBuiltinESMExports();
    assert.throws(() => localWorkerFileHash(file), /changed/);
    assert.deepEqual(requests, [7, 1]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const link = path.join(f.root, "link");
  fs.symlinkSync(file, link);
  assert.throws(() => localWorkerFileHash(link));
});
