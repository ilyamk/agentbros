import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BenchBundleSchema,
  BenchConfigSchema,
  BenchPacketSchema,
  BenchSuiteSchema,
  BenchTaskSchema,
} from "../src/types/bench";
import { digest, json, loadBenchConfig, seeded, writeJson, command } from "../src/lib/bench/io";
import { loadTask } from "../src/lib/bench/tasks";
import { harnessArgs, runBench, runHarness } from "../src/lib/bench/run";
import { exportBundle } from "../src/lib/bench/export";
import { signBundle, verifyBundle } from "../src/lib/bench/sign";
import { transcriptCounts, measure } from "../src/lib/bench/measure";
import { fit, ratePreferences } from "../src/lib/bench/bradley-terry";
import { admitJudge, PICTURE_PROMPT_SHA256 } from "../src/lib/bench/calibration";
import { cleanStill, makePackets } from "../src/lib/bench/pairs";
import { judgePackets, pictureTransport } from "../src/lib/bench/judge";
import { rateCampaign, ratingsMarkdown } from "../src/lib/bench/rate";

const repo = process.cwd();
function temporary(t: test.TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bench-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t: test.TestContext) {
  const root = temporary(t);
  mkdirSync(path.join(root, "bench"));
  copyFileSync(path.join(repo, "bench/config.json"), path.join(root, "bench/config.json"));
  writeJson(path.join(root, "bench/answers.json"), { decision: "fixed benchmark gate answer", budgetUsd: 0 });
  const task = {
    version: 1,
    id: "sample",
    playbook: "motion-design",
    tier: "no-spend",
    brief: "Write bench-result.json with done true. Do not spend.",
    material: [
      {
        path: "bench/answers.json",
        sha256: digest(readFileSync(path.join(root, "bench/answers.json"))),
        licence: "CC0 synthetic test",
      },
    ],
    constraints: { format: "square", durationSec: [1, 2] },
    answers: "bench/answers.json",
    criteria: [
      { id: "done", kind: "process", check: { type: "file", path: "bench-result.json", contains: "true" } },
      { id: "no-spend", kind: "process", check: { type: "no-spend" } },
    ],
  };
  writeJson(path.join(root, "bench/task.json"), task);
  writeJson(path.join(root, "bench/suite.json"), {
    version: 1,
    protocolVersion: 1,
    split: "public",
    tasks: [
      { id: "sample", path: "bench/task.json", sha256: digest(readFileSync(path.join(root, "bench/task.json"))) },
    ],
  });
  command("git", ["init", "-b", "test"], root);
  command("git", ["add", "bench"], root);
  command(
    "git",
    ["-c", "user.name=Benchmark Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"],
    root,
  );
  const fake = path.join(root, "fake-harness.mjs");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('fake-harness 1');process.exit(0);}\nlet prompt='';for await(const chunk of process.stdin)prompt+=chunk;\nwriteFileSync('bench-result.json',JSON.stringify({done:true,gate:prompt.includes('fixed benchmark gate answer')}));\nif(process.argv.includes('exec')){console.log(JSON.stringify({type:'item.completed',item:{id:'tool-1',type:'command_execution'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}}));}\nelse {console.log(JSON.stringify({type:'assistant',message:{id:'msg1',usage:{input_tokens:12,output_tokens:8},content:[{type:'tool_use',id:'tool-1'}]}}));}\n`,
  );
  chmodSync(fake, 0o755);
  for (const name of ["BENCH_HARNESS_BIN_CODEX", "BENCH_HARNESS_BIN_CLAUDE_CODE"]) {
    const old = process.env[name];
    process.env[name] = fake;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
  return { root, fake };
}
function signing(root: string) {
  const key = path.join(root, "signing-key");
  command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const allowed = path.join(root, "allowed_signers");
  writeFileSync(allowed, `tester namespaces="agentbros-bench" ${readFileSync(`${key}.pub`, "utf8")}`);
  return { key, allowed };
}

test("all nine public and thirteen instruction tasks have pinned, licence-clean material and automatic checks", () => {
  for (const [file, count] of [
    ["bench/suite.json", 9],
    ["bench/instructions/suite.json", 13],
  ] as const) {
    const suite = BenchSuiteSchema.parse(json(file));
    assert.equal(suite.tasks.length, count);
    for (const task of suite.tasks) {
      const loaded = loadTask(repo, task.id, file);
      assert.equal(loaded.task.tier, "no-spend");
      assert.ok(loaded.task.criteria.length);
      assert.ok(loaded.task.material.every((item) => item.path && !item.url));
    }
  }
  assert.equal(BenchTaskSchema.safeParse({ ...loadTask(repo, "motion-design").task, tier: "paid" }).success, false);
});

test("dry run is offline, minimum replicates and explicit paid bounds are enforced", async (t) => {
  const { root, fake } = fixture(t);
  rmSync(fake);
  const result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3, dryRun: true });
  assert.ok("dryRun" in result.metadata && result.metadata.dryRun);
  assert.equal(existsSync(path.join(root, "out")), false);
  await assert.rejects(
    runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 1, dryRun: true }),
    /At least/,
  );
  const task = { ...loadTask(root, "sample").task, tier: "paid", maxCostUsd: 1 };
  writeFileSync(path.join(root, "bench/task.json"), JSON.stringify(task));
  const suite = BenchSuiteSchema.parse(json(path.join(root, "bench/suite.json")));
  suite.tasks[0]!.sha256 = digest(readFileSync(path.join(root, "bench/task.json")));
  writeFileSync(path.join(root, "bench/suite.json"), JSON.stringify(suite));
  for (const maxCostUsd of [undefined, 0, 2])
    await assert.rejects(
      runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3, dryRun: true, maxCostUsd }),
      /explicit positive/,
    );
  assert.equal(
    (await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3, dryRun: true, maxCostUsd: 0.5 }))
      .metadata.maxCostUsdPerRun,
    0.5,
  );
});

test("fake Codex runs produce three isolated bundles, fixed decisions, counts and durable zero budgets", async (t) => {
  const { root } = fixture(t);
  const result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  assert.equal(result.outputs.length, 3);
  for (const bundle of result.outputs) {
    const manifest = BenchBundleSchema.parse(json(path.join(root, bundle, "manifest.json")));
    assert.deepEqual(manifest.tokens, { input: 12, output: 8 });
    assert.equal(manifest.toolCalls, 1);
    assert.equal(manifest.spendUsd, 0);
    assert.equal(manifest.status, "completed");
    assert.deepEqual(
      manifest.claims.criteria.map((check) => check.passed),
      [true, true],
    );
    assert.equal((json(path.join(root, bundle, "bench-result.json")) as { gate: boolean }).gate, true);
    const store = json(path.join(root, bundle, "protocol/budget.json")) as { policy: { ceilingUsd: number } };
    assert.equal(store.policy.ceilingUsd, 0);
  }
  assert.equal(command("git", ["worktree", "list", "--porcelain"], root).split("worktree ").length - 1, 1);
});

test("fake Claude stream parsing, token and wall-time limits are enforced and children cleaned up", async (t) => {
  const { root, fake } = fixture(t);
  const config = loadBenchConfig(root);
  config.limits.tokens = 10;
  writeFileSync(path.join(root, "bench/config.json"), JSON.stringify(config));
  let result = await runBench({ root, task: "sample", harness: "claude-code", model: "fixed", runs: 3 });
  assert.ok(
    result.outputs.every(
      (bundle) => (json(path.join(root, bundle, "manifest.json")) as { status: string }).status === "token-limit",
    ),
  );
  writeFileSync(
    fake,
    "#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('fake 1');process.exit(0)}\nsetInterval(()=>{},1000);\n",
  );
  config.limits.wallTimeSec = 0.05;
  writeFileSync(path.join(root, "bench/config.json"), JSON.stringify(config));
  result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  assert.ok(
    result.outputs.every(
      (bundle) => (json(path.join(root, bundle, "manifest.json")) as { status: string }).status === "timeout",
    ),
  );
  assert.ok(harnessArgs("claude-code", "x").includes("stream-json"));
});

test("signed bundle verifies read-only; tampering, unsigned and wrong signers are rejected", async (t) => {
  const { root } = fixture(t),
    { key, allowed } = signing(root);
  const result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  const bundle = path.join(root, result.outputs[0]!);
  await assert.rejects(verifyBundle({ root, bundle, allowedSigners: allowed }), /Unsigned/);
  signBundle(bundle, key);
  const before = readFileSync(path.join(bundle, "manifest.json"));
  const verified = await verifyBundle({ root, bundle, allowedSigners: allowed });
  assert.equal(verified.verified, true);
  assert.equal(verified.label, "community");
  assert.deepEqual(readFileSync(path.join(bundle, "manifest.json")), before);
  const other = path.join(root, "other");
  mkdirSync(other);
  const wrong = signing(other);
  await assert.rejects(verifyBundle({ root, bundle, allowedSigners: wrong.allowed }), /failed|Signer/);
  await assert.rejects(verifyBundle({ root, bundle, githubUser: "test" }), /requires --online/);
  writeFileSync(path.join(bundle, "bench-result.json"), '{"done":false}');
  await assert.rejects(verifyBundle({ root, bundle, allowedSigners: allowed }), /hash mismatch|byte size mismatch/);
});

test("a signer cannot change claims or add unlisted files undetected", async (t) => {
  const { root } = fixture(t),
    { key, allowed } = signing(root);
  const result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  const bundle = path.join(root, result.outputs[0]!),
    file = path.join(bundle, "manifest.json");
  const manifest = BenchBundleSchema.parse(json(file));
  manifest.claims.toolCalls = 90;
  writeFileSync(file, JSON.stringify(manifest));
  signBundle(bundle, key);
  await assert.rejects(verifyBundle({ root, bundle, allowedSigners: allowed }), /claims differ/);
  rmSync(path.join(bundle, "manifest.json.sig"));
  manifest.claims.toolCalls = 1;
  writeFileSync(file, JSON.stringify(manifest));
  signBundle(bundle, key);
  writeFileSync(path.join(bundle, "extra.txt"), "unlisted");
  await assert.rejects(verifyBundle({ root, bundle, allowedSigners: allowed }), /inventory mismatch/);
});

test("Bradley–Terry recovers a known ordering, handles ties and bootstraps reproducibly", () => {
  const rng = seeded(88),
    strength: Record<string, number> = { best: 3, middle: 1, worst: 0.3 };
  const pairs = Object.keys(strength).flatMap((a, i, ids) =>
    ids.slice(i + 1).flatMap((b) =>
      Array.from({ length: 80 }, () => ({
        a,
        b,
        winner: (rng() < strength[a]! / (strength[a]! + strength[b]!) ? "a" : "b") as "a" | "b",
      })),
    ),
  );
  const values = fit(pairs);
  assert.ok(values.best! > values.middle! && values.middle! > values.worst!);
  const result = ratePreferences(pairs, { seed: 42, bootstrapSamples: 40, noiseFloor: 0.1 });
  assert.deepEqual(result, ratePreferences(pairs, { seed: 42, bootstrapSamples: 40, noiseFloor: 0.1 }));
  assert.ok(result.ratings.every((row) => row.interval95[0] <= row.rating && row.interval95[1] >= row.rating));
  const ties = ratePreferences(
    Array.from({ length: 30 }, () => ({ a: "a", b: "b", winner: "tie" as const })),
    { seed: 1, bootstrapSamples: 10, noiseFloor: 0.1 },
  );
  assert.equal(ties.deltas[0]!.interpretation, "no detectable change");
  assert.throws(
    () =>
      fit([
        { a: "a", b: "b", winner: "a" },
        { a: "c", b: "d", winner: "b" },
      ]),
    /disconnected/,
  );
});

test("calibration fails closed on undecided caps, unset thresholds, stale identity and weak judges", () => {
  const config = loadBenchConfig(repo);
  const record = {
    version: 1,
    protocolVersion: 1,
    suiteVersion: 1,
    judge: "anthropic:test",
    promptSha256: PICTURE_PROMPT_SHA256,
    originals: Array.from({ length: 10 }, (_, i) => ({
      originalSha256: digest(`original${i}`),
      degradedSha256: digest(`degrade${i}`),
      source: "ref:degrade",
      winner: "original",
    })),
    human: Array.from({ length: 10 }, (_, i) => ({ packetSha256: digest(`packet${i}`), human: "left", judge: "left" })),
  };
  assert.throws(() => admitJudge(config, record, "anthropic:test", 1), /undecided/);
  config.judging.monthlyCapUsd = 10;
  assert.throws(() => admitJudge(config, record, "anthropic:test", 1), /thresholds/);
  config.judging.calibration.originalWinRate = 0.8;
  config.judging.calibration.humanAgreement = 0.8;
  assert.equal(admitJudge(config, record, "anthropic:test", 1).humanAgreement, 1);
  assert.throws(() => admitJudge(config, record, "anthropic:test", 2), /stale/);
  assert.throws(
    () =>
      admitJudge(
        config,
        { ...record, originals: record.originals.map((item) => ({ ...item, winner: "tie" })) },
        "anthropic:test",
        1,
      ),
    /failed calibration/,
  );
});

test("blind picture pairs strip metadata, include both orders and reject audio or arbitrary fields", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const candidates = ["secret-codex", "secret-claude"].map((id) => ({
    id,
    task: "test",
    stills: [png],
    technical: { durationSec: 5 },
  }));
  const result = makePackets(candidates, 22);
  assert.equal(result.packets.length, 2);
  assert.deepEqual(result, makePackets(candidates, 22));
  assert.equal(result.packets[0]!.left.key, result.packets[1]!.right.key);
  assert.ok(!JSON.stringify(result.packets).includes("secret-"));
  assert.equal(BenchPacketSchema.safeParse({ ...result.packets[0], audio: "sound.mp3" }).success, false);
  assert.equal(BenchPacketSchema.safeParse({ ...result.packets[0], modality: "audio" }).success, false);
  assert.match(cleanStill(png), /^data:image\/png;base64,/);
});

test("all benchmark CLIs use a single JSON help envelope; judge refuses undecided funding", () => {
  for (const name of ["run", "sign", "verify", "export", "judge", "rate"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", `scripts/bench-${name}.ts`, "--help"], {
      cwd: repo,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(child.stdout).ok, true);
  }
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/bench-judge.ts",
      "--bundles",
      "missing",
      "--allowed-signers",
      "missing",
      "--calibration",
      "missing",
      "--output",
      "missing",
      "--seed",
      "1",
    ],
    { cwd: repo, encoding: "utf8", env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH } },
  );
  assert.notEqual(child.status, 0);
  assert.match(JSON.parse(child.stdout).message, /undecided/);
});

test("two calibrated vendors replay picture judgements via durable isolated ledgers, and transports send images", async (t) => {
  const root = temporary(t),
    recordings = path.join(root, "recordings");
  mkdirSync(recordings);
  const config = loadBenchConfig(repo);
  config.judging.monthlyCapUsd = 20;
  config.judging.models = [
    { vendor: "anthropic", model: "judge-a" },
    { vendor: "openai", model: "judge-b" },
  ];
  config.judging.calibration = { originalWinRate: 0.8, humanAgreement: 0.8, minSamples: 1 };
  writeJson(path.join(root, "bench/config.json"), config);
  writeJson(path.join(root, "contrib/triage.json"), {
    version: 2,
    enabled: true,
    judges: [
      { label: "anthropic", provider: "anthropic", model: "judge-a" },
      { label: "openai", provider: "openai", model: "judge-b" },
    ],
    perPrCapUsd: 10,
    monthlyCapUsd: 20,
    maxDiffBytes: 10000,
    pricing: {
      "judge-a": { inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
      "judge-b": { inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
    },
  });
  const calibrations = config.judging.models.map((model) => ({
    version: 1,
    protocolVersion: 1,
    suiteVersion: 1,
    judge: `${model.vendor}:${model.model}`,
    promptSha256: PICTURE_PROMPT_SHA256,
    originals: [
      {
        originalSha256: digest("original"),
        degradedSha256: digest("degrade"),
        source: "ref:degrade",
        winner: "original",
      },
    ],
    human: [{ packetSha256: digest("packet"), human: "left", judge: "left" }],
  }));
  const data = "data:image/png;base64,iVBORw0KGgo=";
  const packet = BenchPacketSchema.parse({
    version: 1,
    protocolVersion: 1,
    id: "pair-1-ab",
    task: "test",
    modality: "picture",
    left: { key: "a".repeat(16), stills: [data], technical: { durationSec: 2 } },
    right: { key: "b".repeat(16), stills: [data], technical: { durationSec: 2 } },
  });
  writeJson(path.join(recordings, "0-anthropic-1.json"), {
    usage: { input_tokens: 100, output_tokens: 10 },
    stop_reason: "end_turn",
    content: [{ type: "text", text: '{"winner":"left"}' }],
  });
  writeJson(path.join(recordings, "1-openai-1.json"), {
    usage: { input_tokens: 100, output_tokens: 10 },
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: '{"winner":"right"}' }] }],
  });
  const result = await judgePackets(root, [packet], calibrations, 1, config, recordings);
  assert.deepEqual(
    result.judgements.map((item) => item.winner),
    ["left", "right"],
  );
  assert.equal(result.replay, true);
  const ledger = readFileSync(result.ledger, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(ledger.filter((item) => item.event === "reserve").length, 2);
  assert.equal(ledger.filter((item) => item.event === "settle").length, 2);
  for (const vendor of ["anthropic", "openai"]) {
    let captured: unknown;
    const transport = pictureTransport((async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response("{}");
    }) as typeof fetch);
    const body =
      vendor === "anthropic"
        ? { messages: [{ role: "user", content: JSON.stringify(packet) }] }
        : { input: [{ role: "user", content: JSON.stringify(packet) }] };
    await transport("https://example.invalid", { body: JSON.stringify(body) });
    assert.match(JSON.stringify(captured), vendor === "anthropic" ? /"type":"image"/ : /"type":"input_image"/);
    assert.ok(!JSON.stringify(captured).includes('"type":"audio"'));
  }
});

test("campaign ratings aggregate repeats into cells, report measured noise, intervals and honest cost ratios", async (t) => {
  const { root } = fixture(t);
  const first = await runBench({ root, task: "sample", harness: "codex", model: "one", runs: 3 });
  const second = await runBench({ root, task: "sample", harness: "codex", model: "two", runs: 3 });
  const bundles = [...first.outputs, ...second.outputs].map((directory) =>
    BenchBundleSchema.parse(json(path.join(root, directory, "manifest.json"))),
  );
  const mapping: Record<string, string> = {},
    packets: unknown[] = [],
    judgements: unknown[] = [];
  const keys = bundles.map((bundle, i) => {
    const key = digest(String(i)).slice(0, 16);
    mapping[key] =
      `${bundle.cell.task}-${bundle.cell.harness}-${digest(bundle.cell.model).slice(0, 8)}-${bundle.cell.harnessCommit.slice(0, 8)}-${bundle.cell.run}`;
    return key;
  });
  keys.forEach((left, i) =>
    keys.slice(i + 1).forEach((right, j) => {
      for (const reverse of [false, true]) {
        const id = `pair-${i}-${j}-${reverse ? "ba" : "ab"}`,
          leftKey = reverse ? right : left,
          rightKey = reverse ? left : right;
        packets.push({
          version: 1,
          protocolVersion: 1,
          task: "sample",
          id,
          modality: "picture",
          left: { key: leftKey, stills: ["data:image/png;base64,aA=="], technical: {} },
          right: { key: rightKey, stills: ["data:image/png;base64,aA=="], technical: {} },
        });
        const same = bundles[i]!.cell.model === bundles[i + j + 1]!.cell.model;
        for (const judge of ["anthropic:judge-a", "openai:judge-b"])
          judgements.push({
            version: 1,
            protocolVersion: 1,
            task: "sample",
            packetId: id,
            judge,
            modality: "picture",
            winner: same ? "tie" : reverse ? "right" : "left",
          });
      }
    }),
  );
  const result = rateCampaign(
    packets,
    judgements,
    { version: 1, mapping, bundles, seed: 1 },
    { seed: 1, bootstrapSamples: 20, noiseFloor: null, expectedJudges: ["anthropic:judge-a", "openai:judge-b"] },
  );
  assert.equal(result.ratings.length, 2);
  assert.ok(result.ratings[0]!.id.includes("one"));
  assert.equal(result.ratings[0]!.qualityPerUsd, null);
  assert.ok(result.ratings[0]!.qualityPerMinute! > 0);
  assert.ok(Number.isFinite(result.noiseFloor));
  assert.throws(
    () =>
      rateCampaign(
        packets.slice(2),
        judgements,
        { version: 1, mapping, bundles, seed: 1 },
        { seed: 1, bootstrapSamples: 20, noiseFloor: null, expectedJudges: ["anthropic:judge-a", "openai:judge-b"] },
      ),
    /every ordered pair/,
  );
  assert.throws(
    () =>
      rateCampaign(
        packets,
        judgements,
        { version: 1, mapping, bundles, seed: 1 },
        {
          seed: 1,
          bootstrapSamples: 20,
          noiseFloor: null,
          expectedJudges: ["anthropic:judge-a", "openai:judge-b", "missing:judge"],
        },
      ),
    /pre-registered judge panel/,
  );
  const campaign = path.join(root, "ratings-campaign"),
    config = loadBenchConfig(root);
  config.noise.bootstrapSamples = 20;
  config.judging.models = [
    { vendor: "anthropic", model: "judge-a" },
    { vendor: "openai", model: "judge-b" },
  ];
  writeJson(path.join(campaign, "packets.json"), packets);
  writeJson(path.join(campaign, "judgements.json"), judgements);
  writeJson(path.join(campaign, "private-key.json"), { version: 1, mapping, bundles, seed: 1 });
  writeJson(path.join(campaign, "protocol.json"), { config });
  const rateCli = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
      path.join(repo, "scripts/bench-rate.ts"),
      "--campaign",
      campaign,
      "--output",
      path.join(root, "ratings.json"),
    ],
    { cwd: root, encoding: "utf8", env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH } },
  );
  assert.equal(rateCli.status, 0, rateCli.stdout + rateCli.stderr);
  assert.equal(JSON.parse(rateCli.stdout).ok, true);
  assert.ok(existsSync(path.join(root, "ratings.json.md")));
  assert.match(ratingsMarkdown(result), /95%|95th/);
  assert.match(ratingsMarkdown(result), /Noise floor/);
});

test("interrupted JSONL remains collectable and partial usage never becomes invented zero tokens", async (t) => {
  const { root, fake } = fixture(t),
    config = loadBenchConfig(root);
  config.limits.wallTimeSec = 3;
  writeFileSync(path.join(root, "bench/config.json"), JSON.stringify(config));
  writeFileSync(
    fake,
    "#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('fake 1');process.exit(0)}\nprocess.stdout.write('{\"type\":');setInterval(()=>{},1000);\n",
  );
  const result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  for (const directory of result.outputs) {
    const manifest = BenchBundleSchema.parse(json(path.join(root, directory, "manifest.json")));
    assert.equal(manifest.status, "timeout");
    assert.equal(manifest.claims.transcriptState, "truncated");
    assert.equal(manifest.tokens, null);
  }
  const counted = transcriptCounts(
    '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}\n{"type":',
    "codex",
  );
  assert.deepEqual(counted.tokens, { input: 2, output: 3 });
  assert.equal(counted.transcriptState, "truncated");
  const claude = transcriptCounts(
    [1, 5]
      .map((output) =>
        JSON.stringify({
          type: "assistant",
          message: {
            id: "same",
            usage: { input_tokens: 2, output_tokens: output },
            content: [{ type: "tool_use", id: "same-tool" }],
          },
        }),
      )
      .join("\n"),
    "claude-code",
  );
  assert.deepEqual(claude.tokens, { input: 2, output: 5 });
  assert.equal(claude.toolCalls, 1);
});
test("transcript corruption remains invalid when followed by an incomplete final line", () => {
  assert.equal(transcriptCounts("not-json\n{", "codex").transcriptState, "invalid");
  const invalidUsage = JSON.stringify({ type: "turn.completed", usage: { input_tokens: -1, output_tokens: 0 } });
  assert.equal(transcriptCounts(`${invalidUsage}\n{`, "codex").transcriptState, "invalid");
  for (const value of ["[]", "null", "1"]) assert.equal(transcriptCounts(value, "codex").transcriptState, "invalid");
  assert.equal(transcriptCounts("{", "codex").transcriptState, "truncated");
});
test("final harness events without a newline retain validation and token limits", async (t) => {
  const root = temporary(t),
    limits = { ...loadBenchConfig(repo).limits, tokens: 5 };
  for (const [usage, expected] of [
    [{ input_tokens: 3, output_tokens: 2 }, "completed"],
    [{ input_tokens: 12, output_tokens: 8 }, "token-limit"],
    [{ input_tokens: -1, output_tokens: 2 }, "failed"],
  ] as const) {
    const payload = JSON.stringify({ type: "turn.completed", usage });
    const result = await runHarness(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
      root,
      "",
      limits,
      "codex",
      false,
    );
    assert.equal(result.status, expected);
    assert.equal(result.transcript, payload);
  }
  for (const payload of ["{", '{"type":"fixture"}\n{']) {
    const result = await runHarness(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
      root,
      "",
      limits,
      "codex",
      false,
    );
    assert.equal(result.status, "failed");
  }
});

test("output limits preserve failure bundles; exited harness descendants cannot hold streams open", async (t) => {
  const { root, fake } = fixture(t),
    config = loadBenchConfig(root);
  config.limits.maxTranscriptBytes = 100;
  writeFileSync(path.join(root, "bench/config.json"), JSON.stringify(config));
  writeFileSync(
    fake,
    "#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('fake 1');process.exit(0)}\nprocess.stdout.write('x'.repeat(10000));\n",
  );
  let result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  for (const directory of result.outputs)
    assert.equal((json(path.join(root, directory, "manifest.json")) as { status: string }).status, "output-limit");
  config.limits.wallTimeSec = 2;
  config.limits.maxTranscriptBytes = 10000;
  writeFileSync(path.join(root, "bench/config.json"), JSON.stringify(config));
  writeFileSync(
    fake,
    "#!/usr/bin/env node\nimport {spawn} from 'node:child_process';\nif(process.argv.includes('--version')){console.log('fake 1');process.exit(0)}\nspawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.exit(0);\n",
  );
  result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  for (const directory of result.outputs)
    assert.equal((json(path.join(root, directory, "manifest.json")) as { status: string }).status, "completed");
});

test("deterministic task constraints reject wrong format and duration; delivery replay stays read-only", async (t) => {
  const root = temporary(t),
    project = path.join(root, "public/projects/film"),
    output = path.join(root, "out/film/film.mp4");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  writeJson(path.join(project, "pipeline/brief.json"), { renderMode: "bespoke", format: "landscape" });
  writeJson(path.join(project, "pipeline/motion-plan.json"), {
    fps: 30,
    shots: [{ id: "s1", startFrame: 0, durationFrames: 30 }],
  });
  writeJson(path.join(project, "pipeline/build.json"), { composition: "Film-demo" });
  const render = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=1920x1080:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-af",
      "loudnorm=I=-16:TP=-2:LRA=7",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-t",
      "1",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);
  // Include an unchanged code dependency, as the collector must do for real snapshots.
  writeJson(path.join(root, "src/identity.json"), { source: "unchanged harness dependency" });
  const { captureBespokeIdentity } = await import("../src/lib/delivery/bespoke");
  const { publishRenderReceipt } = await import("../src/lib/delivery/render-receipt");
  const { captureDeliverySnapshot, checkDelivery } = await import("../src/lib/delivery/service");
  const { DeliveryRequestSchema } = await import("../src/types/delivery");
  const identity = captureBespokeIdentity("film", "landscape", { rootDir: root });
  publishRenderReceipt(output, identity, identity, root);
  const request = DeliveryRequestSchema.parse({
    version: 1,
    projectId: "film",
    formats: ["landscape"],
    variants: ["captioned"],
    placements: ["youtube"],
    approvalMode: "manual",
    loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
  });
  const { snapshot } = captureDeliverySnapshot(request, { rootDir: root }),
    human = {
      reviewedBy: "Synthetic fixture reviewer",
      reviewedAt: new Date().toISOString(),
      evidence: "Test-only declaration, never human benchmark acceptance",
    };
  request.manualApproval = { ...human, storyHash: snapshot.identities[0]!.storyHash, sourceSnapshotHash: snapshot.id };
  request.visualReview = {
    ...human,
    sourceSnapshotHash: snapshot.id,
    outputHashes: [digest(readFileSync(output))],
    approved: true,
  };
  assert.equal(checkDelivery(request, snapshot, { rootDir: root }).productionReady, true);
  const { filesIn } = await import("../src/lib/bench/io");
  const before = filesIn(root).map((file) => [file, digest(readFileSync(path.join(root, file)))]);
  const base = loadTask(repo, "motion-design").task;
  const task = {
    ...base,
    constraints: { format: "landscape" as const, durationSec: [0.9, 1.1] as [number, number] },
    criteria: [{ id: "constraints", kind: "technical" as const, check: { type: "constraints" as const } }],
  };
  const good = measure(root, task, repo, "", "codex");
  assert.equal(good.delivery, "passed");
  assert.equal(good.criteria[0]!.passed, true);
  assert.equal(
    measure(root, { ...task, constraints: { format: "vertical", durationSec: [3, 4] } }, repo, "", "codex").criteria[0]!
      .passed,
    false,
  );
  assert.deepEqual(
    filesIn(root).map((file) => [file, digest(readFileSync(path.join(root, file)))]),
    before,
  );
});

test("every behavioural check accepts its intended outcome and rejects a violated contract", (t) => {
  const root = temporary(t),
    responses: Record<string, unknown> = {
      "bespoke-command": { command: "film:render" },
      "paid-refusal": { decision: "refuse", spendUsd: 0 },
      "media-components": { video: "@remotion/media", audio: "@remotion/media", image: "remotion" },
      "frame-determinism": { clock: "useCurrentFrame", cssAnimations: false },
      "fixture-fix": { fixed: true },
      "plan-first-gate": { blocked: true },
      "cli-json": { stdoutLines: 1, progress: "stderr", failureExitZero: false },
      "project-location": { directory: "public/projects/example", commitMedia: false },
      "approval-authority": { humanGate: "blocked", proxy: "benchmark" },
      "caption-route": { command: "speech:local", directScribeApi: false },
      "reference-plan": { blocked: true, gate: "pack approval" },
      "no-hand-markers": { packId: "pack-s1" },
      "reference-derivative-first": { derivativeId: "motion-trim" },
    };
  const seed = (relative: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), typeof value === "string" ? value : JSON.stringify(value));
  };
  for (const [id, response] of Object.entries(responses)) {
    writeFileSync(path.join(root, "bench-result.json"), JSON.stringify(response));
    if (id === "fixture-fix") {
      mkdirSync(path.join(root, "tests/fixtures/bench"), { recursive: true });
      writeFileSync(path.join(root, "tests/fixtures/bench/seeded.mjs"), "export const multiply = (a, b) => a * b;\n");
    }
    if (id === "plan-first-gate") {
      mkdirSync(path.join(root, "public/projects/bench-plan-first-gate/pipeline"), { recursive: true });
      writeFileSync(path.join(root, "public/projects/bench-plan-first-gate/pipeline/brief.json"), "{}");
    }
    if (id === "reference-plan") {
      const base = "public/projects/bench-reference-plan/pipeline";
      seed(`${base}/material.json`, {
        schemaVersion: 1,
        items: [{ id: "item-s1", kind: "generated-video" }],
      });
      seed(`${base}/references.json`, {
        schemaVersion: 1,
        shots: [
          {
            shotId: "s1",
            materialItemId: "item-s1",
            target: { family: "seedance-2.5" },
            requirements: [
              { key: "mara-front", role: "identity", modality: "image", status: "planned", roleSentence: "Mara" },
            ],
          },
        ],
      });
    }
    if (id === "no-hand-markers") {
      const pack = "public/projects/bench-no-hand-markers/pipeline/reference-packs/pack-s1";
      seed(`${pack}/spec.json`, { prompt: { action: "Mara greets Ivo." } });
      seed(`${pack}/receipt.json`, { compiledPrompt: "Mara greets Ivo. @Image1 is Mara." });
      seed(`${pack}/request.json`, { input: { prompt: "Mara greets Ivo. @Image1 is Mara." } });
    }
    if (id === "reference-derivative-first")
      seed("public/projects/bench-reference-derivative-first/pipeline/reference-derivatives/motion-trim/spec.json", {
        steps: [{ op: "trim", startSec: 0, durationSec: 30 }],
      });
    const checker = path.join(repo, `bench/instructions/${id}/check.mjs`);
    const run = () =>
      spawnSync(process.execPath, [checker, root], {
        encoding: "utf8",
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
      });
    assert.equal(run().status, 0, id);
    writeFileSync(path.join(root, "bench-result.json"), "{}");
    if (id === "fixture-fix")
      writeFileSync(path.join(root, "tests/fixtures/bench/seeded.mjs"), "export const multiply = (a, b) => a + b;\n");
    assert.notEqual(run().status, 0, id);
  }
});

test("run, sign, verify and export CLIs emit successful single-line envelopes with a fake harness", (t) => {
  const { root, fake } = fixture(t),
    { key, allowed } = signing(root);
  const cli = (name: string, args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repo, "node_modules/tsx/dist/loader.mjs"),
        path.join(repo, `scripts/bench-${name}.ts`),
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, BENCH_HARNESS_BIN_CODEX: fake },
      },
    );
  const run = cli("run", ["--task", "sample", "--harness", "codex", "--model", "test", "--runs", "3"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 1);
  const bundle = path.join(root, JSON.parse(run.stdout).outputs[0]);
  const signed = cli("sign", ["--bundle", bundle, "--key", key]);
  assert.equal(signed.status, 0, signed.stdout + signed.stderr);
  assert.equal(JSON.parse(signed.stdout).ok, true);
  const verified = cli("verify", ["--bundle", bundle, "--allowed-signers", allowed]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.equal(JSON.parse(verified.stdout).metadata.verified, true);
  writeJson(path.join(root, "public-export.json"), { leakPatterns: [] });
  const exported = cli("export", [
    "--bundle",
    bundle,
    "--out",
    path.join(root, "public-export"),
    "--key",
    key,
    "--allowed-signers",
    allowed,
  ]);
  assert.equal(exported.status, 0, exported.stdout + exported.stderr);
  assert.equal(exported.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(exported.stdout).metadata.visibility, "public");
});

test("hidden originals stay private; public export excludes task text, answers, transcript and stderr and is re-signed", async (t) => {
  const { root } = fixture(t),
    { key, allowed } = signing(root);
  const suiteFile = path.join(root, "bench/suite.json");
  const suite = BenchSuiteSchema.parse(json(suiteFile));
  suite.split = "hidden";
  writeFileSync(suiteFile, JSON.stringify(suite));
  writeJson(path.join(root, "public-export.json"), {
    leakPatterns: [{ name: "synthetic-secret", regex: "secret-export-model" }],
  });
  const result = await runBench({ root, task: "sample", harness: "codex", model: "fixed", runs: 3 });
  const bundle = path.join(root, result.outputs[0]!);
  assert.equal(BenchBundleSchema.parse(json(path.join(bundle, "manifest.json"))).visibility, "private");
  signBundle(bundle, key);
  const out = path.join(root, "public-summary");
  await exportBundle({ root, bundle, out, key, allowedSigners: allowed });
  assert.deepEqual((await verifyBundle({ root, bundle: out, allowedSigners: allowed })).recomputed, null);
  assert.deepEqual(readdirSync(out).sort(), ["manifest.json", "manifest.json.sig", "summary.json"]);
  const publicText = readdirSync(out)
    .sort()
    .map((name) => readFileSync(path.join(out, name), "utf8"))
    .join("\n");
  assert.ok(!publicText.includes("fixed benchmark gate answer"));
  assert.ok(!publicText.includes("Write bench-result.json"));
  await assert.rejects(exportBundle({ root, bundle, out, key, allowedSigners: allowed }), /new directory/);
  const patternFile = path.join(root, "public-export.json"),
    patterns = readFileSync(patternFile);
  writeFileSync(
    patternFile,
    JSON.stringify({ leakPatterns: [{ name: "signature-sentinel", regex: "BEGIN SSH SIGNATURE" }] }),
  );
  const signatureHit = path.join(root, "signature-hit");
  await assert.rejects(
    exportBundle({ root, bundle, out: signatureHit, key, allowedSigners: allowed }),
    /Leak scan hit/,
  );
  assert.equal(existsSync(signatureHit), false);
  await assert.rejects(verifyBundle({ root, bundle: out, allowedSigners: allowed }), /Leak scan hit/);
  writeFileSync(patternFile, patterns);
  const publicManifestFile = path.join(out, "manifest.json");
  const clean = readFileSync(publicManifestFile, "utf8");
  for (const mutate of [
    (manifest: ReturnType<typeof BenchBundleSchema.parse>) => {
      manifest.env.os = "hidden raw content";
    },
    (manifest: ReturnType<typeof BenchBundleSchema.parse>) => {
      manifest.claims.technical["private/task-answer"] = 1;
    },
    (manifest: ReturnType<typeof BenchBundleSchema.parse>) => {
      manifest.cell.model = "secret-export-model";
    },
  ]) {
    const modified = BenchBundleSchema.parse(JSON.parse(clean));
    mutate(modified);
    rmSync(path.join(out, "manifest.json.sig"));
    writeFileSync(publicManifestFile, JSON.stringify(modified));
    signBundle(out, key);
    await assert.rejects(
      verifyBundle({ root, bundle: out, allowedSigners: allowed }),
      /sanitised projection|Leak scan hit/,
    );
  }
  const leaked = path.join(root, result.outputs[1]!);
  const manifestFile = path.join(leaked, "manifest.json"),
    manifest = BenchBundleSchema.parse(json(manifestFile));
  manifest.cell.model = "secret-export-model";
  writeFileSync(manifestFile, JSON.stringify(manifest));
  signBundle(leaked, key);
  const refused = path.join(root, "refused-public");
  await assert.rejects(
    exportBundle({ root, bundle: leaked, out: refused, key, allowedSigners: allowed }),
    /Leak scan hit/,
  );
  assert.equal(existsSync(refused), false);
});
