import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
  readdirSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runLocalWorker, probeLocalWorker } from "../src/lib/ingest/local-worker";
import {
  readRejectedObservation,
  rejectedObservationFor,
  rejectedObservationCodePins,
  retainRejectedObservation,
  type RejectedObserverOptions,
} from "../src/lib/ingest/rejected-observation";
import { boundedEvidenceHash } from "../src/lib/ingest/bounded-evidence";
import { stableHash } from "../src/lib/longform/plans";
import { writeTone } from "./helpers/review-audio";
import { sourceWordProposal } from "../src/lib/ingest/word-proposal";
import { readSourceIndex } from "../src/lib/ingest/index";
function fixture(t: test.TestContext, mode = "clock", native = true) {
  const prior = process.cwd(),
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "rejected-asr-"))),
    workerFile = path.resolve("tests/fixtures/rejected-observation-worker.mjs");
  mkdirSync(path.join(root, "public/projects/demo"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/demo/project.json"), "{}");
  const source = path.join(root, "source.wav");
  writeTone(source, 440, 2);
  const inputSha256 = boundedEvidenceHash(source),
    modelPath = path.join(root, "model.json"),
    engine = path.join(root, "engine");
  writeFileSync(modelPath, JSON.stringify({ type: mode }));
  writeFileSync(engine, "fixed fixture engine");
  const manifestFile = path.join(root, "manifest.json"),
    corpusKey = "1".repeat(64);
  writeFileSync(
    manifestFile,
    JSON.stringify({
      version: 1,
      key: corpusKey,
      entries: [
        { id: "sample", original: { sha256: inputSha256 }, input: { path: "source.wav", sha256: inputSha256 } },
      ],
    }),
  );
  const binding = {
      manifestFile,
      manifestSha256: boundedEvidenceHash(manifestFile),
      corpusKey,
      entryId: "sample",
      originalSha256: inputSha256,
      inputSha256,
    },
    observer: RejectedObserverOptions = { method: "quarantined-worker-output-v1", binding };
  const config = {
    executable: realpathSync(process.execPath),
    workerFile,
    modelPath,
    model: "protocol-fixture",
    revision: "1",
    engine: "whisper.cpp" as const,
    engineExecutable: engine,
    language: "en",
    threads: 2,
    timeoutMs: 5000,
    ...(native ? { wordTimingMethod: "native-word-segments-v1" as const } : {}),
  };
  const payload = { operation: "asr" as const, sourceFile: source, sourceHash: inputSha256, durationSec: 2 };
  process.chdir(root);
  t.after(() => {
    process.chdir(prior);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    config,
    payload,
    observer,
    rejectedRoot: path.resolve("public/projects/demo/pipeline/rejected-analysis"),
  };
}
async function refused(f: ReturnType<typeof fixture>, observer = true) {
  let error: Error | undefined;
  try {
    await runLocalWorker(f.config, f.payload, "demo", observer ? f.observer : undefined);
  } catch (e) {
    error = e as Error;
  }
  assert.ok(error, "Original strict refusal required");
  return error;
}
test("fresh native/paragraph clock errors retain raw bytes but still refuse accepted cache/index/word export", async (t) => {
  const f = fixture(t),
    error = await refused(f),
    descriptor = rejectedObservationFor(error);
  assert.match(error.message, /Native word rows overlap/);
  assert.equal(descriptor?.state, "quarantined");
  if (descriptor?.state !== "quarantined") return;
  const observation = readRejectedObservation("demo", descriptor.file, descriptor.sha256, f.observer.binding);
  assert.equal(observation.lexicalHypothesis, "Keep not");
  assert.equal(observation.accepted, false);
  assert.equal(observation.timingUse, "forbidden");
  assert.equal(observation.receipt.commercialAllowed, "unknown");
  assert.equal(observation.receipt.identityHash, probeLocalWorker(f.config).identityHash);
  assert.equal(readdirSync(path.resolve("public/projects/demo/pipeline/local-analysis")).length, 0);
  assert.throws(() => readSourceIndex("demo", descriptor.file, { boundedEvidence: true }));
  assert.throws(() => sourceWordProposal("demo", descriptor.file));
  const second = await refused(f);
  assert.deepEqual(rejectedObservationFor(second), descriptor);
  assert.equal(readdirSync(f.rejectedRoot).length, 1);
  const paragraph = { ...f, config: { ...f.config, wordTimingMethod: undefined } };
  const aggregate = await refused(paragraph);
  assert.equal(aggregate.message, "ASR spans overlap or exceed original source clock");
  const a = rejectedObservationFor(aggregate);
  assert.equal(a?.state, "quarantined");
  if (a?.state === "quarantined") {
    const read = readRejectedObservation("demo", a.file, a.sha256, f.observer.binding);
    assert.equal(read.lexicalHypothesis, "Keep not.");
    assert.notEqual(read.receipt.identityHash, observation.receipt.identityHash);
  }
});
test("default refusal publishes nothing; valid output/identity/cache stay byte-identical with opt-in", async (t) => {
  const f = fixture(t);
  const defaultError = await refused(f, false);
  assert.equal(rejectedObservationFor(defaultError), undefined);
  assert.equal(existsSync(f.rejectedRoot), false);
  writeFileSync(f.config.modelPath, JSON.stringify({ type: "valid" }));
  const original = await runLocalWorker(f.config, f.payload, "demo"),
    bytes = readFileSync(original.file);
  rmSync(original.file);
  const observed = await runLocalWorker(f.config, f.payload, "demo", f.observer);
  assert.equal(observed.cacheHit, false);
  assert.equal(observed.key, original.key);
  assert.deepEqual(readFileSync(original.file), bytes);
  assert.equal(existsSync(f.rejectedRoot), false);
  assert.equal((await runLocalWorker(f.config, f.payload, "demo", f.observer)).cacheHit, true);
  const cache = JSON.parse(bytes.toString());
  cache.output.wordTimings.rawRows[1].offsets.from = 400;
  cache.outputHash = stableHash(cache.output);
  writeFileSync(original.file, JSON.stringify(cache));
  const cachedError = await refused(f);
  assert.match(cachedError.message, /Native word rows overlap/);
  assert.equal(rejectedObservationFor(cachedError), undefined);
  assert.equal(existsSync(f.rejectedRoot), false);
});
for (const mode of ["key", "offline", "json", "lines", "exit", "oversize", "structural", "timeout"])
  test(`no observation for ${mode} failure`, async (t) => {
    const f = fixture(t, mode);
    if (mode === "timeout") f.config.timeoutMs = 100;
    const error = await refused(f);
    assert.equal(rejectedObservationFor(error), undefined);
    assert.equal(existsSync(f.rejectedRoot), false);
  });
for (const target of ["source", "model", "engine"])
  test(`post-error ${target} mutation refuses observation`, async (t) => {
    const f = fixture(t);
    writeFileSync(
      f.config.modelPath,
      JSON.stringify({
        type: "clock",
        mutate: target === "source" ? f.source : target === "model" ? f.config.modelPath : f.config.engineExecutable,
      }),
    );
    const error = await refused(f);
    assert.match(error.message, /Native word rows overlap/);
    const info = rejectedObservationFor(error);
    assert.equal(info?.state, "unavailable");
    assert.equal(existsSync(f.rejectedRoot), false);
  });
test("external receipt SHA, manifest/source binding, raw/request corruption and forbidden paths fail closed", async (t) => {
  const f = fixture(t),
    error = await refused(f),
    d = rejectedObservationFor(error);
  assert.equal(d?.state, "quarantined");
  if (d?.state !== "quarantined") return;
  assert.throws(() => readRejectedObservation("demo", d.file, "0".repeat(64), f.observer.binding), /checksum/);
  assert.throws(
    () => readRejectedObservation("demo", d.file, d.sha256, { ...f.observer.binding, entryId: "other" }),
    /binding/,
  );
  for (const name of ["raw.json", "request.json"]) {
    const file = path.join(path.dirname(d.file), name),
      bytes = readFileSync(file);
    writeFileSync(file, "{}");
    assert.throws(() => readRejectedObservation("demo", d.file, d.sha256, f.observer.binding));
    writeFileSync(file, bytes);
    const link = file + ".link";
    symlinkSync(file, link);
    assert.throws(() => readRejectedObservation("demo", link, d.sha256, f.observer.binding));
  }
  const manifestBytes = readFileSync(f.observer.binding.manifestFile);
  writeFileSync(f.observer.binding.manifestFile, "{}");
  assert.throws(() => readRejectedObservation("demo", d.file, d.sha256, f.observer.binding), /manifest checksum/);
  writeFileSync(f.observer.binding.manifestFile, manifestBytes);
  const raw = path.join(path.dirname(d.file), "raw.json"),
    bytes = readFileSync(raw);
  rmSync(raw);
  execFileSync("mkfifo", [raw]);
  const entry = path.resolve(priorReader);
  execFileSync(
    process.execPath,
    [
      "--import",
      loaderPath,
      "-e",
      `import(${JSON.stringify(entry)}).then(m=>{try{m.readRejectedObservation('demo',${JSON.stringify(d.file)},${JSON.stringify(d.sha256)},${JSON.stringify(f.observer.binding)});process.exit(3)}catch{}})`,
    ],
    { cwd: f.root, timeout: 3000 },
  );
  rmSync(raw);
  writeFileSync(raw, bytes);
  truncateSync(raw, 16 * 1024 * 1024 + 1);
  assert.throws(() => readRejectedObservation("demo", d.file, d.sha256, f.observer.binding), /bounded/);
});
const priorReader = path.resolve("src/lib/ingest/rejected-observation.ts"),
  loaderPath = path.resolve("node_modules/tsx/dist/loader.mjs");
test("observer/runner initial source pins and interrupted publication cannot falsely attribute new bytes", async (t) => {
  const f = fixture(t),
    runner = path.join(f.root, "runner.ts");
  writeFileSync(runner, "initial");
  const codePins = rejectedObservationCodePins(runner),
    capability = probeLocalWorker(f.config);
  assert.equal(capability.available, true);
  if (!capability.available) return;
  const key = stableHash({ version: 1, identity: capability.identityHash, payload: f.payload }),
    serializedRequest = JSON.stringify({ version: 1, key, offline: true, config: f.config, payload: f.payload }),
    stdout = Buffer.from(
      JSON.stringify({
        version: 1,
        key,
        offline: true,
        output: { segments: [{ text: "Keep not", startSec: 0, endSec: 2.02 }] },
      }) + "\n",
    ),
    error = new Error("ASR spans overlap or exceed original source clock");
  const request = {
    projectId: "demo",
    options: f.observer,
    payload: f.payload,
    workerKey: key,
    identityHash: capability.identityHash,
    identity: capability.identity,
    serializedRequest,
    stdout,
    error,
    runnerFile: runner,
    codePins,
  };
  const wrongConfig = JSON.stringify({
    version: 1,
    key,
    offline: true,
    config: { ...f.config, language: "ru" },
    payload: f.payload,
  });
  assert.throws(() => retainRejectedObservation({ ...request, serializedRequest: wrongConfig }), /config identity/);
  assert.equal(existsSync(f.rejectedRoot), false);
  writeFileSync(runner, "changed");
  assert.throws(() => retainRejectedObservation(request), /source changed/);
  assert.equal(existsSync(f.rejectedRoot), false);
  writeFileSync(runner, "initial");
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file).endsWith("receipt.json")) throw Error("Controlled interrupted publication");
    return (write as Function)(file, ...args);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => retainRejectedObservation(request), /interrupted/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(f.rejectedRoot), []);
  assert.equal(rejectedObservationFor(error), undefined);
});

test("publication failure keeps original clock refusal and explicit unavailable diagnostic", async (t) => {
  const f = fixture(t),
    write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file).endsWith("receipt.json")) throw Error("Controlled publication failure");
    return (write as Function)(file, ...args);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  let error: Error;
  try {
    error = await refused(f);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(error.message, "Native word rows overlap, reverse or exceed original clock");
  assert.deepEqual(rejectedObservationFor(error), { state: "unavailable", reason: "Controlled publication failure" });
  assert.deepEqual(readdirSync(f.rejectedRoot), []);
  assert.deepEqual(readdirSync(path.resolve("public/projects/demo/pipeline/local-analysis")), []);
});
test("observation request/key uses normalized strict-clock duration; observer option never enters config identity", async (t) => {
  const f = fixture(t),
    error = await refused({ ...f, payload: { ...f.payload, durationSec: 2.0015 } }),
    descriptor = rejectedObservationFor(error);
  assert.equal(descriptor?.state, "quarantined");
  if (descriptor?.state !== "quarantined") return;
  const observation = readRejectedObservation("demo", descriptor.file, descriptor.sha256, f.observer.binding);
  assert.equal(observation.receipt.payload.durationSec, 2);
  assert.equal(
    observation.receipt.workerKey,
    stableHash({ version: 1, identity: observation.receipt.identityHash, payload: f.payload }),
  );
  assert.equal("retention" in observation.receipt.identity, false);
  assert.equal("rejectedObserver" in observation.receipt.identity, false);
});
