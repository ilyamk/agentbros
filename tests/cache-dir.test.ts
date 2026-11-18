import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localRoot } from "../src/lib/apple/runtime";
import { cacheRoot } from "../src/lib/cache-dir";
import { toolRoot } from "../src/lib/hyperframes/render";
import { defaultEngineDirectory } from "../src/lib/local-engines/prepare";
import { modelRoot } from "../src/lib/multicam/models";
import { modelCacheRoot } from "../src/lib/shared-assets";
import { speechCacheDirectory } from "../src/lib/speech/local";

function fixture(t: test.TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), "cache-dir-"));
  const saved = {
    HOME: process.env.HOME,
    AGENTBROS_MODEL_CACHE: process.env.AGENTBROS_MODEL_CACHE,
    AI_VIDEO_CREATOR_MODEL_CACHE: process.env.AI_VIDEO_CREATOR_MODEL_CACHE,
    SPEECH_LOCAL_CACHE: process.env.SPEECH_LOCAL_CACHE,
  };
  process.env.HOME = home;
  delete process.env.AGENTBROS_MODEL_CACHE;
  delete process.env.AI_VIDEO_CREATOR_MODEL_CACHE;
  delete process.env.SPEECH_LOCAL_CACHE;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, legacy: path.join(home, ".cache/ai-video-creator"), directory: path.join(home, ".cache/agentbros") };
}

test("the default cache needs no directory creation", (t) => {
  const { directory } = fixture(t);
  const rename = t.mock.method(fs, "renameSync", () => {
    throw new Error("must not rename a missing cache");
  });
  const warning = t.mock.method(console, "warn", () => {});
  assert.equal(cacheRoot(), directory);
  assert.equal(existsSync(directory), false);
  assert.equal(rename.mock.callCount(), 0);
  assert.equal(warning.mock.callCount(), 0);
});

test("the legacy cache is moved once, preserving its files", (t) => {
  const { legacy, directory } = fixture(t);
  mkdirSync(path.join(legacy, "speech"), { recursive: true });
  const file = path.join(legacy, "speech/weights");
  writeFileSync(file, "cached model");
  const inode = statSync(file).ino;
  assert.equal(cacheRoot(), directory);
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(path.join(directory, "speech/weights"), "utf8"), "cached model");
  assert.equal(statSync(path.join(directory, "speech/weights")).ino, inode);
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, "later"), "leave this alone");
  assert.equal(cacheRoot(), directory);
  assert.equal(readFileSync(path.join(legacy, "later"), "utf8"), "leave this alone");
});

test("an existing new cache leaves both directories unchanged", (t) => {
  const { legacy, directory } = fixture(t);
  mkdirSync(legacy, { recursive: true });
  mkdirSync(directory);
  writeFileSync(path.join(legacy, "weights"), "old");
  writeFileSync(path.join(directory, "weights"), "new");
  assert.equal(cacheRoot(), directory);
  assert.equal(readFileSync(path.join(legacy, "weights"), "utf8"), "old");
  assert.equal(readFileSync(path.join(directory, "weights"), "utf8"), "new");
});

test("the shared cache override is respected without migrating or creating caches", (t) => {
  const { home, legacy, directory } = fixture(t);
  mkdirSync(legacy, { recursive: true });
  const override = path.join(home, "custom");
  process.env.AGENTBROS_MODEL_CACHE = override;
  assert.equal(cacheRoot(), override);
  assert.equal(modelRoot(), override);
  assert.equal(modelCacheRoot(), override);
  assert.equal(localRoot(), path.join(override, "local-engines/apple"));
  assert.equal(defaultEngineDirectory(), path.join(override, "local-engines"));
  assert.equal(toolRoot(home), path.join(override, "hyperframes"));
  assert.equal(speechCacheDirectory(), path.join(override, "speech"));
  assert.equal(existsSync(legacy), true);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(override), false);
});

test("the deprecated cache override is still read, and the current name wins", (t) => {
  const { home, directory } = fixture(t);
  const legacyOverride = path.join(home, "legacy-override");
  process.env.AI_VIDEO_CREATOR_MODEL_CACHE = legacyOverride;
  assert.equal(cacheRoot(), legacyOverride);
  assert.equal(localRoot(), path.join(legacyOverride, "local-engines/apple"));
  const current = path.join(home, "current-override");
  process.env.AGENTBROS_MODEL_CACHE = current;
  assert.equal(cacheRoot(), current);
  assert.equal(existsSync(directory), false);
});

test("a home cache permission failure only warns and continues using the old cache", (t) => {
  const { legacy, directory } = fixture(t);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "weights"), "cached model");
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("rename refused"), { code: "EPERM" });
  });
  const warning = t.mock.method(console, "warn", () => {});
  assert.equal(cacheRoot(), legacy);
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(path.join(legacy, "weights"), "utf8"), "cached model");
  assert.equal(warning.mock.callCount(), 1);
  assert.match(String(warning.mock.calls[0]!.arguments[0]), /continuing to use .*rename refused/);
});

test("a legacy cache removed during migration is silent and non-fatal", (t) => {
  const { legacy, directory } = fixture(t);
  mkdirSync(legacy, { recursive: true });
  t.mock.method(fs, "renameSync", () => {
    rmSync(legacy, { recursive: true });
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  });
  const warning = t.mock.method(console, "warn", () => {});
  assert.equal(cacheRoot(), directory);
  assert.equal(warning.mock.callCount(), 0);
});

test("all TypeScript cache consumers share the migrated root and speech keeps its override", (t) => {
  const { home, legacy, directory } = fixture(t);
  mkdirSync(legacy, { recursive: true });
  assert.equal(defaultEngineDirectory(), path.join(directory, "local-engines"));
  assert.equal(toolRoot(home), path.join(directory, "hyperframes"));
  assert.equal(modelRoot(), directory);
  assert.equal(modelCacheRoot(), directory);
  assert.equal(speechCacheDirectory(), path.join(directory, "speech"));
  process.env.SPEECH_LOCAL_CACHE = path.join(home, "speech-override");
  assert.equal(speechCacheDirectory(), path.join(home, "speech-override"));
});

test("prepared engine configurations keep working paths and checksum pins after migration", (t) => {
  const { home, legacy, directory } = fixture(t);
  const oldRoot = path.join(legacy, "local-engines");
  const root = path.join(directory, "local-engines");
  const external = path.join(home, "external-source.swift");
  const hash = "a".repeat(64);
  const configs = {
    asr: {
      executable: path.join(oldRoot, "asr/python/bin/python3"),
      workerFile: path.join(oldRoot, "asr/workers/local-analysis.py"),
      engineExecutable: path.join(oldRoot, "asr/bin/whisper-cli"),
      modelPath: path.join(oldRoot, "asr/models/ggml-small.bin"),
      model: "whisper-multilingual-small",
    },
    ocr: {
      executable: path.join(oldRoot, "ocr/bin/frame-ocr"),
      workerSource: external,
      executableHash: hash,
      workerSourceHash: hash,
    },
    matte: {
      executable: path.join(oldRoot, "matte/bin/frame-matte"),
      workerSource: external,
      executableHash: hash,
      workerSourceHash: hash,
    },
  };
  for (const [engine, config] of Object.entries(configs)) {
    mkdirSync(path.join(oldRoot, engine), { recursive: true });
    writeFileSync(path.join(oldRoot, engine, "config.json"), JSON.stringify(config));
  }
  const manifest = JSON.stringify({ asr: { pins: { modelHash: hash, engineHash: hash } } });
  writeFileSync(path.join(oldRoot, "manifest.json"), manifest);
  // Any cache consumer may move the directory before a local-engine command starts.
  assert.equal(modelRoot(), directory);
  assert.equal(defaultEngineDirectory(), root);
  for (const [engine, config] of Object.entries(configs)) {
    const expected = Object.fromEntries(
      Object.entries(config).map(([key, value]) => [
        key,
        value.startsWith(`${oldRoot}${path.sep}`) ? path.join(root, path.relative(oldRoot, value)) : value,
      ]),
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, engine, "config.json"), "utf8")), expected);
  }
  assert.equal(readFileSync(path.join(root, "manifest.json"), "utf8"), manifest);
  const configFile = path.join(root, "asr/config.json");
  const changed = statSync(configFile).mtimeMs;
  assert.equal(defaultEngineDirectory(), root);
  assert.equal(statSync(configFile).mtimeMs, changed);
});
