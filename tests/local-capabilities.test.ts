import { decodedDimensions } from "../src/lib/apple/detections";
import { spawnSync } from "node:child_process";
import { importAsset } from "../src/lib/assets/registry";
import { assertImportedLocalAssets, receiptForLocalAsset } from "../src/lib/apple/provenance";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectCapabilities,
  resolveLocalTask,
  languageEquivalent,
  readLocalPolicy,
  writeLocalPolicy,
} from "../src/lib/local-capabilities";
import {
  atomicJson,
  boundedFile,
  decodeNativeReply,
  fileHash,
  NativeUnavailable,
  objectHash,
} from "../src/lib/apple/runtime";
import { assertNoDraftLocalAssets, runAppleTask, publishResult, installedVoice } from "../src/lib/apple/tasks";
import { speechMetrics, referenceDistance, qualityReference } from "../src/lib/apple/verify";
import {
  LocalPolicySchema,
  LocalQualificationSchema,
  LocalResultReceiptSchema,
  LocalTextRequestSchema,
  type NativeProbe,
} from "../src/types/local-capabilities";
const temporary = (fn: (root: string) => void | Promise<void>) => async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-capabilities-")));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const runtime: NativeProbe = {
  operations: [
    "speech.transcribe",
    "speech.synthesise",
    "text.analyse",
    "text.translate",
    "vision.faces",
    "text.assist",
  ],
  languages: ["en-US", "ru-RU"],
  installedLanguages: ["en-US"],
  voices: [
    { id: "voice-us", name: "US", language: "en-US" },
    { id: "voice-gb", name: "GB", language: "en-GB" },
  ],
  details: { schemes: { en: ["Lemma", "NameType"], ru: ["Lemma", "NameType"], xx: ["Language"] } },
};
const probe = async () => ({ probe: runtime, identity: "a".repeat(64) });
test(
  "non-macOS never invokes a native probe",
  temporary(async (root) => {
    const result = await inspectCapabilities([{ task: "speech.transcribe", language: "en" }], {
      root,
      platform: "linux",
      probe: async () => {
        throw new Error("must not run");
      },
    });
    assert.equal(result[0]!.state, "unsupported");
    assert.equal(existsSync(path.join(root, "status")), false);
  }),
);
test(
  "supported but missing model produces one preparation, no runnable command",
  temporary(async (root) => {
    const result = await resolveLocalTask(
      { task: "speech.transcribe", language: "ru" },
      { root, platform: "darwin", probe },
    );
    assert.equal(result.ready.length, 0);
    assert.deepEqual(result.preparation?.argv, [
      "pnpm",
      "media:prepare",
      "--engines",
      "apple-speech",
      "--language",
      "ru",
    ]);
  }),
);
test(
  "unsupported language is hidden without an installation suggestion",
  temporary(async (root) => {
    const result = await resolveLocalTask({ task: "text.assist", language: "ja" }, { root, platform: "darwin", probe });
    assert.equal(result.ready.length, 0);
    assert.equal(result.preparation, undefined);
  }),
);
test(
  "native settings action remains data for the orchestrator",
  temporary(async (root) => {
    const result = await resolveLocalTask(
      { task: "text.assist", language: "en" },
      {
        root,
        platform: "darwin",
        probe: async () => {
          throw new NativeUnavailable({
            state: "needs_user_action",
            code: "DISABLED",
            message: "Off",
            userAction: "Enable it in Settings",
          });
        },
      },
    );
    assert.equal(result.userAction, "Enable it in Settings");
    assert.equal(result.ready.length, 0);
  }),
);
test(
  "probe timeout is temporary, never unsupported",
  temporary(async (root) => {
    const [state] = await inspectCapabilities([{ task: "text.assist" }], {
      root,
      platform: "darwin",
      probe: async () => {
        throw new NativeUnavailable({ state: "temporarily_unavailable", code: "TIMEOUT", message: "Timed out" });
      },
    });
    assert.equal(state!.state, "temporarily_unavailable");
  }),
);
test("locale equivalence preserves script and explicit region", () => {
  assert.equal(languageEquivalent("en", "en_US"), true);
  assert.equal(languageEquivalent("en-US", "en_GB"), false);
  assert.equal(languageEquivalent("zh-Hant", "zh-CN"), false);
  assert.equal(languageEquivalent("ru-RU", "ru_RU"), true);
  assert.equal(languageEquivalent("???", "en"), false);
});
test(
  "Natural Language availability checks required operations",
  temporary(async (root) => {
    const injected = async () => ({ probe: { ...runtime, languages: ["xx"] }, identity: "a".repeat(64) });
    assert.equal(
      (
        await inspectCapabilities([{ task: "text.analyse", language: "xx" }], {
          root,
          platform: "darwin",
          probe: injected,
        })
      )[0]!.state,
      "unsupported",
    );
    assert.equal(
      (
        await inspectCapabilities([{ task: "text.analyse", language: "xx", operations: ["language"] }], {
          root,
          platform: "darwin",
          probe: injected,
        })
      )[0]!.state,
      "ready",
    );
  }),
);
test(
  "fixed voice is not silently replaced",
  temporary(async (root) => {
    const [state] = await inspectCapabilities([{ task: "speech.synthesise", language: "en-US", voice: "voice-gb" }], {
      root,
      platform: "darwin",
      probe,
    });
    assert.equal(state!.state, "needs_user_action");
  }),
);
test(
  "verbatim and speaker semantics prevent advertising an incomplete ASR",
  temporary(async (root) => {
    for (const requirements of [{ verbatim: true }, { speakers: true }])
      assert.equal(
        (
          await inspectCapabilities([{ task: "speech.transcribe", language: "en", requirements }], {
            root,
            platform: "darwin",
            probe,
          })
        )[0]!.state,
        "unsupported",
      );
  }),
);
test(
  "unverified available runtime is draft-only",
  temporary(async (root) => {
    assert.equal(
      (
        await inspectCapabilities([{ task: "speech.transcribe", language: "en", purpose: "draft" }], {
          root,
          platform: "darwin",
          probe,
        })
      )[0]!.state,
      "ready",
    );
    assert.equal(
      (
        await inspectCapabilities([{ task: "speech.transcribe", language: "en", purpose: "production" }], {
          root,
          platform: "darwin",
          probe,
        })
      )[0]!.state,
      "unknown",
    );
  }),
);
test(
  "qualification expires and is scoped to the exact voice",
  temporary(async (root) => {
    const now = Date.now(),
      first = (
        await inspectCapabilities([{ task: "speech.synthesise", language: "en-US", voice: "voice-us" }], {
          root,
          platform: "darwin",
          probe,
        })
      )[0]!;
    const evidenceFile = path.join(root, "evidence.json");
    writeFileSync(evidenceFile, "verified fixture");
    const row = LocalQualificationSchema.parse({
      version: 1,
      task: first.task,
      language: "en-US",
      identity: first.identity,
      checkedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1000).toISOString(),
      suite: "quality",
      passed: true,
      metrics: { distance: 0 },
      evidenceHash: fileHash(evidenceFile),
      evidenceFile: "evidence.json",
    });
    atomicJson(
      path.join(
        root,
        "verification",
        objectHash({ task: row.task, language: row.language, identity: row.identity }) + ".json",
      ),
      row,
    );
    assert.equal(
      (
        await inspectCapabilities(
          [{ task: row.task, language: row.language, voice: "voice-us", purpose: "production" }],
          { root, platform: "darwin", probe, now: () => now },
        )
      )[0]!.state,
      "ready",
    );
    assert.notEqual(
      (
        await inspectCapabilities([{ task: row.task, language: "en", voice: "voice-gb", purpose: "production" }], {
          root,
          platform: "darwin",
          probe,
          now: () => now,
        })
      )[0]!.state,
      "ready",
    );
    assert.equal(
      (
        await inspectCapabilities(
          [{ task: row.task, language: row.language, voice: "voice-us", purpose: "production" }],
          { root, platform: "darwin", probe, now: () => now + 2000 },
        )
      )[0]!.state,
      "unknown",
    );
  }),
);
test(
  "repeated operation probes share a bounded runtime result",
  temporary(async (root) => {
    let calls = 0;
    await inspectCapabilities([{ task: "vision.faces" }, { task: "vision.pose" }, { task: "vision.saliency" }], {
      root,
      platform: "darwin",
      probe: async () => {
        calls++;
        return {
          probe: { ...runtime, operations: ["vision.faces", "vision.pose", "vision.saliency"] },
          identity: "a".repeat(64),
        };
      },
    });
    assert.equal(calls, 1);
  }),
);
test(
  "policy round trips without writing a repository file",
  temporary((root) => {
    assert.equal(readLocalPolicy(root).downloads, "task");
    assert.deepEqual(
      writeLocalPolicy({ version: 1, mode: "autonomous", downloads: "never" }, root),
      readLocalPolicy(root),
    );
    assert.equal(LocalPolicySchema.safeParse({ version: 1, mode: "headless", downloads: "free" }).success, false);
  }),
);
test("text requests reject duplicate IDs and invented cue ends", () => {
  const request = {
    version: 1,
    sourceLanguage: "en",
    units: [
      { id: "a", text: "A" },
      { id: "a", text: "B" },
    ],
  };
  assert.equal(LocalTextRequestSchema.safeParse(request).success, false);
  assert.equal(
    LocalTextRequestSchema.safeParse({ ...request, units: [{ id: "a", text: "A", endMs: 1 }] }).success,
    false,
  );
});
test(
  "bounded files reject aliases, excessive size and directories",
  temporary((root) => {
    const file = path.join(root, "source");
    writeFileSync(file, "original");
    symlinkSync(file, file + ".alias");
    assert.throws(() => boundedFile(file, 1));
    assert.throws(() => boundedFile(root));
    assert.throws(() => boundedFile(file + ".alias"));
    assert.throws(() => fileHash(file + ".alias"));
    assert.match(fileHash(file), /^[a-f0-9]{64}$/u);
  }),
);
test(
  "force cannot replace an immutable input",
  temporary(async (root) => {
    const file = path.join(root, "source.txt");
    writeFileSync(file, "Keep me");
    await assert.rejects(runAppleTask({ task: "text.analyse", input: file, output: file, force: true }), /immutable/u);
    assert.equal(readFileSync(file, "utf8"), "Keep me");
  }),
);
function receipt(root: string, purpose: "draft" | "production") {
  const file = path.join(root, "result.json.assets", "op", "scene.mp3");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "audio");
  const value = LocalResultReceiptSchema.parse({
    version: 1,
    task: "speech.synthesise",
    backend: "apple-tts",
    operationId: "a".repeat(64),
    createdAt: new Date().toISOString(),
    identity: "b".repeat(64),
    systemModelsHashPinned: false,
    requestHash: "c".repeat(64),
    inputs: [],
    outputs: [{ file, sha256: fileHash(file) }],
    purpose,
    checks: [],
    warnings: [],
  });
  atomicJson(path.join(root, "result.json.receipt.json"), value);
  return { file, value };
}
test(
  "delivery refuses draft or missing local provenance, validates approved candidate bytes",
  temporary((root) => {
    const { file } = receipt(root, "draft");
    assert.throws(() => assertNoDraftLocalAssets([file]), /Draft/u);
    receipt(root, "production");
    assert.doesNotThrow(() => assertNoDraftLocalAssets([file]));
    writeFileSync(file, "changed");
    assert.throws(() => assertNoDraftLocalAssets([file]), /changed/u);
  }),
);
test(
  "staging failure preserves previous result and receipt",
  temporary((root) => {
    const { value } = receipt(root, "production"),
      output = path.join(root, "old.json");
    writeFileSync(output, "valid old result");
    const blocked = path.join(root, "not-a-directory");
    writeFileSync(blocked, "existing");
    assert.throws(() => publishResult(output, "new result", path.join(blocked, "receipt"), value));
    assert.equal(readFileSync(output, "utf8"), "valid old result");
    assert.equal(readFileSync(blocked, "utf8"), "existing");
  }),
);
test("speech quality reports word errors and aligned onset errors", () => {
  const reference = {
    words: [
      { text: "Hello", startSec: 0 },
      { text: "world", startSec: 1 },
    ],
  };
  assert.deepEqual(speechMetrics(reference, reference), { wer: 0, startP95Sec: 0 });
  const changed = {
    words: [
      { text: "Hello!", startSec: 0.1 },
      { text: "there", startSec: 1 },
    ],
  };
  assert.equal(speechMetrics(changed, reference).wer, 0.5);
  assert.equal(speechMetrics(changed, reference).startP95Sec, 0.1);
  assert.throws(() => speechMetrics({ words: [] }, { words: [] }));
});
test("reference metrics count mismatches without model self-approval", () => {
  assert.equal(referenceDistance({ id: "a", value: 2 }, { id: "a", value: 2 }), 0);
  assert.equal(referenceDistance({ id: "invented" }, { id: "a" }), 1);
});

test("native protocol rejects malformed, extra, stale and contradictory replies", () => {
  const good = { version: 1, id: "request", ok: true, result: { value: 1 } };
  assert.deepEqual(decodeNativeReply(JSON.stringify(good), 0, "request"), { value: 1 });
  for (const [body, code] of [
    ["broken", 0],
    [JSON.stringify(good) + "\n" + JSON.stringify(good), 0],
    [JSON.stringify({ ...good, id: "other" }), 0],
    [JSON.stringify({ ...good, extra: true }), 0],
    [JSON.stringify(good), 1],
  ] as const)
    assert.throws(() => decodeNativeReply(body, code, "request"));
  const failure = JSON.stringify({
    version: 1,
    id: "request",
    ok: false,
    issue: { state: "needs_user_action", code: "DISABLED", message: "Off" },
  });
  assert.throws(() => decodeNativeReply(failure, 0, "request"), /exit code/u);
  assert.throws(() => decodeNativeReply(failure, 1, "request"), NativeUnavailable);
});

test("sparse metadata cannot qualify a content-producing backend", () => {
  for (const task of [
    "text.analyse",
    "text.translate",
    "speech.synthesise",
    "audio.events",
    "vision.faces",
    "text.assist",
    "image.describe",
  ] as const)
    for (const value of [{}, { advisory: true }]) assert.throws(() => qualityReference(task, value), task);
});

test(
  "normal import and cross-project reimport preserve native draft provenance",
  temporary((root) => {
    for (const id of ["one", "two"]) {
      const project = path.join(root, "public/projects", id);
      mkdirSync(project, { recursive: true });
      writeFileSync(path.join(project, "project.json"), "{}");
    }
    const file = path.join(root, "voice.json.assets", "generation", "voice.wav");
    mkdirSync(path.dirname(file), { recursive: true });
    assert.equal(
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", file]).status,
      0,
    );
    const value = LocalResultReceiptSchema.parse({
      version: 1,
      task: "speech.synthesise",
      backend: "apple-tts",
      operationId: "a".repeat(64),
      createdAt: new Date().toISOString(),
      identity: "b".repeat(64),
      systemModelsHashPinned: false,
      requestHash: "c".repeat(64),
      inputs: [],
      outputs: [{ file, sha256: fileHash(file) }],
      purpose: "draft",
      checks: [],
      warnings: [],
    });
    atomicJson(path.join(path.dirname(file), "receipt.json"), value);
    const first = importAsset({ rootDir: root, projectId: "one", sourceFile: file, provenance: { origin: "manual" } });
    assert.equal(first.asset.localResult?.receipt.purpose, "draft");
    const original = path.join(root, "public", first.asset.files.original);
    assert.throws(() => assertImportedLocalAssets([original], path.join(root, first.registryPath), root), /draft/u);
    assert.throws(
      () =>
        assertImportedLocalAssets(
          [original],
          path.join(root, "public/projects/two/pipeline/asset-registry.json"),
          root,
        ),
      /draft/u,
    );
    const second = importAsset({
      rootDir: root,
      projectId: "two",
      sourceFile: original,
      provenance: { origin: "manual" },
    });
    assert.equal(second.asset.localResult?.receipt.purpose, "draft");
  }),
);
test(
  "a new generation does not invalidate the previous generation receipt",
  temporary((root) => {
    const { file, value } = receipt(root, "production");
    const immutable = path.join(path.dirname(file), "receipt.json");
    atomicJson(immutable, value);
    atomicJson(path.join(root, "result.json.receipt.json"), { ...value, purpose: "draft", outputs: [] });
    assert.equal(receiptForLocalAsset(file), immutable);
    assert.doesNotThrow(() => assertNoDraftLocalAssets([file]));
  }),
);

test("automatic voice selection respects locale and prefers standard compact voices", () => {
  const voices = [
    { id: "com.apple.eloquence.en-GB.Eddy", language: "en-GB" },
    { id: "com.apple.voice.compact.en-US.Samantha", language: "en-US" },
    { id: "com.apple.eloquence.en-US.Eddy", language: "en-US" },
  ];
  assert.equal(installedVoice("en-US", voices), "com.apple.voice.compact.en-US.Samantha");
  assert.equal(installedVoice("en-GB", voices), "com.apple.eloquence.en-GB.Eddy");
});
test(
  "assistance operations have separate qualification identities",
  temporary(async (root) => {
    const summary = (
      await inspectCapabilities([{ task: "text.assist", language: "en", assistTask: "summarise" }], {
        root,
        platform: "darwin",
        probe,
      })
    )[0]!;
    const tags = (
      await inspectCapabilities([{ task: "text.assist", language: "en", assistTask: "tags" }], {
        root,
        platform: "darwin",
        probe,
      })
    )[0]!;
    assert.notEqual(summary.identity, tags.identity);
  }),
);

test("decoded video dimensions follow the orientation used by ffmpeg", () => {
  assert.deepEqual(decodedDimensions({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(decodedDimensions({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }), {
    width: 1920,
    height: 1080,
  });
  assert.throws(() => decodedDimensions({ width: 1920, height: 1080, side_data_list: [{ rotation: 45 }] }));
});

test(
  "force refuses an immutable input reached through an aliased ancestor",
  temporary(async (root) => {
    const source = path.join(root, "source.json");
    writeFileSync(source, "immutable");
    const alias = path.join(root, "alias");
    symlinkSync(root, alias);
    await assert.rejects(
      runAppleTask({ task: "text.analyse", input: path.join(alias, "source.json"), output: source, force: true }),
      /immutable/u,
    );
    assert.equal(readFileSync(source, "utf8"), "immutable");
  }),
);

test(
  "ready command retains the exact language, voice, operation and feature",
  temporary(async (root) => {
    const voice = (
      await inspectCapabilities([{ task: "speech.synthesise", language: "en-US", voice: "voice-us" }], {
        root,
        platform: "darwin",
        probe,
      })
    )[0]!;
    assert.deepEqual(voice.command, ["pnpm", "voiceover:local", "--language", "en-US", "--voice", "voice-us"]);
    const featureProbe = async () => ({
      probe: { ...runtime, operations: ["vision.saliency"] },
      identity: "a".repeat(64),
    });
    const vision = (
      await inspectCapabilities([{ task: "vision.saliency" }], { root, platform: "darwin", probe: featureProbe })
    )[0]!;
    assert.deepEqual(vision.command, ["pnpm", "media:vision", "--features", "saliency"]);
    const assist = (
      await inspectCapabilities([{ task: "text.assist", language: "en", assistTask: "tags" }], {
        root,
        platform: "darwin",
        probe,
      })
    )[0]!;
    assert.deepEqual(assist.command, ["pnpm", "text:assist", "--language", "en", "--assist-task", "tags"]);
  }),
);
