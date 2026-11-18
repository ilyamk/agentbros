import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CampaignProductionRequestSchema, type CampaignProductionRequest } from "../src/types/campaign-production";
import { ProjectConfigSchema } from "../src/types/video";
import { buildCampaignPlan, validateTaskGraph } from "../src/lib/campaigns/production/plan";
import {
  initCampaign,
  loadCampaign,
  reviseCampaign,
  campaignCosts,
  campaignRemovalBlockers,
  bindCampaignChild,
  archiveCampaign,
} from "../src/lib/campaigns/production/store";
import {
  approveCampaignPackage,
  packageApproved,
  reviewPackage,
  verifyPackage,
} from "../src/lib/campaigns/production/review";
import {
  campaignBrief,
  campaignNext,
  recordCampaignDecision,
  recordCampaignOutcome,
  runCampaign,
  campaignStatus,
} from "../src/lib/campaigns/production/service";
import { runCampaignQueue, taskInputHash, taskReceipt } from "../src/lib/campaigns/production/queue";
import {
  campaignInputIdentity,
  executeCampaignTask,
  resolveCampaignAnchors,
  campaignTimeline,
  campaignRenderOptions,
  canonicalCampaignAlignment,
} from "../src/lib/campaigns/production/execute";
import {
  digest,
  immutableJson,
  jsonFile,
  pinFile,
  productionDirectory,
  acquireLock,
  atomicJson,
} from "../src/lib/campaigns/production/files";
import { captureDeliverySnapshot } from "../src/lib/delivery/service";
import { TimelineEditStore, adaptLegacyProject } from "../src/lib/timeline-ir";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { spawnSync } from "node:child_process";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { OperationStore } from "../src/lib/jobs/store";
import { assertProductionReferences } from "../src/lib/campaigns/production/guard";
import { detectRoute } from "../src/lib/pipeline/route";
import { prepareCommand } from "../src/mcp/bridge";
import { COMMANDS } from "../src/mcp/catalog";
import { USER_GRANT } from "./helpers/ceiling-grant";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-production-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/projects"), { recursive: true });
  const project = ProjectConfigSchema.parse({
    name: "Synthetic catalogue fixture",
    productName: "Synthetic item",
    colors: { accent: "#19AABB", background: "#101318", text: "#FFFFFF" },
    formats: ["vertical"],
    musicVolume: 0,
    scenes: [
      { id: "hook", headline: "Fixture", text: "", durationInFrames: 90, transitionToNext: "cut", visualType: "title" },
    ],
  });
  const request: CampaignProductionRequest = {
    version: 1,
    id: "batch",
    revision: 1,
    scenario: "ad-experiments",
    brief: "Synthetic infrastructure fixture; no model quality or human approval is asserted",
    members: [{ id: "first", projectId: "batch-first", language: "en", adapter: { kind: "template", project } }],
  };
  return { root, request, project };
}
async function approve(root: string, plan: ReturnType<typeof initCampaign>) {
  const { pack } = reviewPackage(root, plan, "creative-plan");
  return approveCampaignPackage(
    root,
    plan,
    pack,
    pack.packageHash,
    "Fixture-only approval of this exact synthetic plan; not a production acceptance",
    "test fixture",
  );
}
test("campaign planning is read-only and explicit matrices never invent a Cartesian product", (t) => {
  const f = fixture(t),
    request = {
      ...f.request,
      members: [],
      matrix: {
        axes: { hook: ["A", "B"], cta: ["X", "Y"] },
        combinations: [
          { hook: "A", cta: "X" },
          { hook: "B", cta: "Y" },
        ],
        memberTemplate: {
          id: "{{id}}",
          projectId: "{{campaign}}-{{id}}",
          language: "en",
          adapter: { kind: "template", project: f.project },
        },
      },
    };
  const plan = buildCampaignPlan(request, f.root);
  assert.equal(plan.members.length, 2);
  assert.equal(existsSync(path.join(f.root, "public/projects/batch")), false);
  assert.deepEqual(plan.members[1].factors, { hook: "B", cta: "Y" });
  assert.throws(
    () =>
      buildCampaignPlan({ ...request, matrix: { ...request.matrix, combinations: [{ hook: "C", cta: "X" }] } }, f.root),
    /declared axes/,
  );
  assert.throws(
    () =>
      buildCampaignPlan(
        {
          ...request,
          matrix: { ...request.matrix, combinations: [request.matrix.combinations[0], request.matrix.combinations[0]] },
        },
        f.root,
      ),
    /Duplicate/,
  );
});
test("catalogue handles quoted CSV, TSV and JSON with stable product IDs and rejects missing facts", (t) => {
  const f = fixture(t);
  for (const format of ["csv", "tsv", "json"] as const) {
    const file = path.join(f.root, `catalogue.${format}`);
    writeFileSync(
      file,
      format === "csv"
        ? 'sku,name\none,"A, B"\ntwo,Second\n'
        : format === "tsv"
          ? "sku\tname\none\tA, B\ntwo\tSecond\n"
          : JSON.stringify([
              { sku: "one", name: "A, B" },
              { sku: "two", name: "Second" },
            ]),
    );
    const input = {
      ...f.request,
      scenario: "catalogue-videos" as const,
      members: [],
      catalogue: {
        file: pinFile(f.root, file),
        format,
        idColumn: "sku",
        columns: { name: "name" },
        memberTemplate: {
          id: "{{id}}",
          projectId: "{{campaign}}-{{id}}",
          language: "en",
          adapter: { kind: "template", project: { ...f.project, productName: "{{name}}" } },
        },
      },
    };
    const plan = buildCampaignPlan(input, f.root);
    assert.equal(plan.members[0].productId, "one");
    assert.equal(plan.members[0].factors.name, "A, B");
    assert.throws(
      () => buildCampaignPlan({ ...input, catalogue: { ...input.catalogue, columns: { name: "absent" } } }, f.root),
      /Missing catalogue/,
    );
  }
});
test("shared and member quotas are one immutable allocation and owner costs are included once", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      buildCampaignPlan(
        {
          ...f.request,
          capUsd: 1,
          sharedQuotaUsd: 1,
          members: f.request.members!.map((member) => ({ ...member, quotaUsd: 1 })),
        },
        f.root,
      ),
    /allocations exceed/,
  );
  const plan = initCampaign(f.request, f.root);
  assert.equal(loadCampaign(f.root, "batch").planHash, plan.planHash);
  assert.equal(campaignCosts(f.root, "batch").owners.length, 2);
  const store = new OperationStore("batch", { directory: path.join(f.root, "public/projects/batch/pipeline") });
  assert.throws(() => store.configure({ ceilingUsd: 1, maxJobUsd: 1 }, USER_GRANT), /quota/);
  assert.throws(() => initCampaign(f.request, f.root), /already exists/);
  assert.equal(detectRoute(path.join(f.root, "public/projects/batch")).route, "campaign");
  assert.throws(
    () => reviseCampaign({ ...f.request, revision: 2, capUsd: 2, sharedQuotaUsd: 1 }, f.root),
    /allocation/,
  );
});
test("no-spend is inherited and does not silently grant a default generation budget", async (t) => {
  const f = fixture(t),
    plan = initCampaign(f.request, f.root);
  assert.equal(campaignNext(f.root, "batch").action, "ask");
  assert.equal((await runCampaign(f.root, "batch")).attempted, 0);
  await assert.rejects(() => runCampaign(f.root, "batch", { paid: true, maxTotalUsd: 100 }), /forbidden/);
  await approve(f.root, plan);
  assert.equal(packageApproved(f.root, plan, "creative-plan"), true);
  assert.equal(
    campaignCosts(f.root, "batch").owners.reduce((sum, owner) => sum + owner.paidAttempts, 0),
    0,
  );
  assert.throws(() => reviseCampaign({ ...f.request, revision: 2, spend: "authorised" }, f.root), /cannot authorise/);
});
test("approval preflights the exact set and hash and is idempotent without inheriting a master decision", async (t) => {
  const f = fixture(t),
    plan = initCampaign(f.request, f.root),
    { pack } = reviewPackage(f.root, plan, "creative-plan");
  await assert.rejects(
    () => approveCampaignPackage(f.root, plan, pack, "0".repeat(64), "fixture", "fixture"),
    /exact package/,
  );
  const receipt = await approve(f.root, plan);
  assert.equal(receipt.complete, true);
  assert.deepEqual(await approve(f.root, plan), receipt);
  await assert.rejects(
    () => approveCampaignPackage(f.root, plan, pack, pack.packageHash, "different", "fixture"),
    /Conflicting/,
  );
  const next = reviseCampaign({ ...f.request, revision: 2, brief: "Different synthetic hypothesis" }, f.root);
  assert.notEqual(next.planHash, plan.planHash);
  assert.equal(packageApproved(f.root, next, "creative-plan"), false);
});
test("input pins, task graph and workspace boundaries fail closed", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "facts.txt");
  writeFileSync(file, "First");
  const request = {
    ...f.request,
    members: f.request.members!.map((member) => ({ ...member, inputs: [pinFile(f.root, file)] })),
  };
  initCampaign(request, f.root);
  writeFileSync(file, "Changed");
  assert.throws(() => loadCampaign(f.root, "batch"), /Stale/);
  const task = { id: "one", kind: "prepare" as const, resource: "process" as const, dependsOn: ["two"], payload: {} };
  assert.throws(() => validateTaskGraph([task]), /Missing/);
  assert.throws(() => validateTaskGraph([task, { ...task, id: "two", dependsOn: ["one"] }]), /Cyclic/);
  assert.throws(() => pinFile(f.root, "../escape"), /escapes|outside/);
});
test("queue preserves completed work, checks actual bytes and respects resource concurrency", async (t) => {
  const f = fixture(t),
    plan = initCampaign(f.request, f.root);
  let active = 0,
    peak = 0,
    count = 0;
  const executor = async (task: (typeof plan.tasks)[number]) => {
    active++;
    peak = Math.max(peak, active);
    count++;
    const file = path.join(f.root, `${task.id}.txt`);
    writeFileSync(file, `Synthetic task ${task.id}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return { outputs: [file], metadata: { fixture: true } };
  };
  const result = await runCampaignQueue(f.root, plan, executor, { limits: { process: 1, render: 1, qa: 1 } });
  assert.ok(result.tasks.every((task) => task.state === "complete"));
  assert.equal(peak, 1);
  const before = count;
  await runCampaignQueue(f.root, plan, executor);
  assert.equal(count, before);
  writeFileSync(path.join(f.root, "prepare-first.txt"), "Tampered");
  assert.equal(
    taskReceipt(
      f.root,
      plan,
      plan.tasks.find((task) => task.id === "prepare-first")!,
    ),
    null,
  );
  assert.equal(
    taskReceipt(
      f.root,
      plan,
      plan.tasks.find((task) => task.kind === "render")!,
    ),
    null,
  );
});
test("exclusive queue locks do not expire a live owner and recover a proved-dead process", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "runtime.lock"),
    release = acquireLock(file)!;
  assert.equal(acquireLock(file), null);
  release();
  writeFileSync(file, JSON.stringify({ pid: 2147483647, token: "dead-fixture" }));
  const recovered = acquireLock(file);
  assert.ok(recovered);
  recovered();
  assert.equal(existsSync(file), false);
});
test("agent decisions bind the current handoff and require actual declared outputs", async (t) => {
  const f = fixture(t);
  f.request.agentTasks = [
    { id: "write-copy", agent: "campaign-producer", purpose: "Write a synthetic copy fixture", outputs: ["copy.json"] },
  ];
  const plan = initCampaign(f.request, f.root);
  await approve(f.root, plan);
  const brief = campaignBrief(f.root, "batch", "write-copy");
  assert.match(brief.prompt, /Leaf agent/);
  assert.match(brief.prompt, /Spending: forbid/);
  writeFileSync(path.join(f.root, "copy.json"), JSON.stringify({ text: "Synthetic fixture" }));
  const pin = pinFile(f.root, "copy.json"),
    decision = {
      version: 1,
      taskId: "write-copy",
      planHash: plan.planHash,
      inputHash: brief.inputHash,
      agent: "campaign-producer",
      verdict: "accept",
      rationale: "Synthetic contract fixture, not a live agent result",
      evidence: [pin],
      outputs: [pin],
    };
  assert.throws(() => recordCampaignDecision(f.root, "batch", { ...decision, inputHash: "0".repeat(64) }), /changed/);
  recordCampaignDecision(f.root, "batch", decision);
  await runCampaign(f.root, "batch", { maxTasks: 1 });
  assert.ok(
    taskReceipt(
      f.root,
      plan,
      plan.tasks.find((task) => task.id === "write-copy")!,
      campaignInputIdentity,
    ),
  );
});
test("outcomes retain reviewed source and exact variant factors without claiming causal attribution", (t) => {
  const f = fixture(t);
  initCampaign(f.request, f.root);
  const result = recordCampaignOutcome(f.root, "batch", {
    version: 1,
    campaignId: "batch",
    episodeId: "first",
    observedAt: new Date().toISOString(),
    source: "supplied test fixture",
    cohort: "synthetic",
    metrics: { views: 10 },
    review: { reviewedBy: "fixture", evidence: "Not real business performance" },
  });
  assert.equal(result.outcome.causalAttribution, "not-inferred");
  assert.ok(existsSync(result.file));
  assert.ok(campaignRemovalBlockers(f.root, "batch-first").some((message) => message.includes("batch")));
});
test("campaign MCP refuses approval/spend flags and single-project authority", (t) => {
  const f = fixture(t),
    definition = COMMANDS.find((command) => command.name === "campaign_production")!;
  const options = { root: f.root, codeRoot: process.cwd(), allowPaid: false };
  assert.throws(() =>
    prepareCommand(definition, { project: "batch", action: "run-local", "allow-paid": true }, options),
  );
  assert.throws(
    () => prepareCommand(definition, { project: "batch", action: "init" }, { ...options, projectScope: "batch" }),
    /single-project/,
  );
  const result = prepareCommand(definition, { project: "batch", action: "run-local" }, options);
  assert.equal(result.flags["scope-root"], realpathSync(f.root));
  assert.equal(
    COMMANDS.some((command) => command.name === "campaign_approve"),
    false,
  );
});

test("a no-spend child cannot submit a reservation created before campaign binding", (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "public/projects/batch-first");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "project.json"), JSON.stringify(f.project));
  const store = new OperationStore("batch-first", { directory: path.join(directory, "pipeline") });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  store.reserveOperation({
    operationId: "historical",
    provider: "test",
    endpoint: "test/image",
    assetId: "image",
    inputHash: "fixture",
    quote: {
      currency: "USD",
      lowUsd: 1,
      expectedUsd: 1,
      highUsd: 1,
      bounded: true,
      source: "fixture",
      asOf: "2026-11-16",
      confidence: "published-rate",
    },
  });
  const plan = initCampaign(
    {
      ...f.request,
      capUsd: 1,
      members: [{ ...f.request.members![0], quotaUsd: 1, adapter: { kind: "existing", projectId: "batch-first" } }],
    },
    f.root,
  );
  bindCampaignChild(f.root, plan, "batch-first");
  assert.throws(() => store.admitSubmission("historical"), /forbid/);
  assert.throws(() => store.transitionJob("historical", "submitting"), /forbid/);
  assert.equal(store.snapshot().jobs.historical.paidAttempts, 0);
});
test("approval and revision are excluded while a campaign worker owns the writer lock", async (t) => {
  const f = fixture(t),
    plan = initCampaign(f.request, f.root),
    { pack } = reviewPackage(f.root, plan, "creative-plan");
  const release = acquireLock(path.join(productionDirectory(f.root, "batch"), "writer.lock"))!;
  try {
    assert.throws(() => reviseCampaign({ ...f.request, revision: 2 }, f.root), /busy/);
    await assert.rejects(
      () => approveCampaignPackage(f.root, plan, pack, pack.packageHash, "fixture", "fixture"),
      /busy/,
    );
  } finally {
    release();
  }
  reviseCampaign({ ...f.request, revision: 2 }, f.root);
  await assert.rejects(
    () => approveCampaignPackage(f.root, plan, pack, pack.packageHash, "fixture", "fixture"),
    /revision changed/,
  );
  await assert.rejects(() => runCampaignQueue(f.root, plan, async () => ({ outputs: [] })), /superseded/);
});
test("generation approval rejects a correctly rehashed subset of exact requests", (t) => {
  const f = fixture(t),
    input = path.join(f.root, "generation.json");
  writeFileSync(input, JSON.stringify({ provider: "fal", endpoint: "fixture/image" }));
  const materials = ["a", "b"].map((id) => ({
    id,
    source: {
      kind: "generate" as const,
      useCase: "product-image",
      request: pinFile(f.root, input),
      output: `public/projects/batch/assets/${id}.png`,
      reason: "Synthetic request contract",
    },
  }));
  const plan = initCampaign({ ...f.request, materials }, f.root),
    { pack } = reviewPackage(f.root, plan, "generation-requests");
  const { packageHash: _, ...content } = pack,
    changed = { ...content, members: content.members.slice(0, 1) };
  assert.throws(
    () => verifyPackage(f.root, plan, { ...changed, packageHash: digest(changed) }),
    /complete request set/,
  );
});
test("terminal or never-created historical generation waits do not leak resource capacity", async (t) => {
  const f = fixture(t),
    plan = initCampaign(f.request, f.root),
    file = path.join(f.root, ".cache/campaign-production/runtime.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      limits: { generation: 1, process: 1, render: 1, qa: 1 },
      records: {
        [`batch.${"0".repeat(64)}.material-old`]: {
          state: "waiting",
          pid: process.pid,
          token: "fixture",
          resource: "generation",
          resourceKey: "fal",
          operationId: "never-created",
        },
      },
    }),
  );
  await runCampaignQueue(
    f.root,
    plan,
    async (task) => {
      const output = path.join(f.root, `${task.id}.json`);
      writeFileSync(output, "{}");
      return { outputs: [output] };
    },
    { maxTasks: 1 },
  );
  const runtime = jsonFile(file) as { records: Record<string, { state: string }> };
  assert.equal(Object.values(runtime.records)[0].state, "complete");
});
test("new member-owned material requests fail during planning instead of forming a deadlock", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "source.json");
  writeFileSync(file, "{}");
  assert.throws(
    () =>
      buildCampaignPlan(
        {
          ...f.request,
          materials: [
            {
              id: "material",
              owner: "first",
              source: { kind: "supplied", file: pinFile(f.root, file), provenance: { origin: "manual" } },
            },
          ],
        },
        f.root,
      ),
    /shared owner/,
  );
});
test("shared originals are owned once, copied through the registry and reused by child preparation", async (t) => {
  const f = fixture(t),
    original = path.join(f.root, "product.png");
  assert.equal(
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=48x32", "-frames:v", "1", original]).status,
    0,
  );
  const member = f.request.members![0];
  const request = {
    ...f.request,
    materials: [
      {
        id: "product",
        source: { kind: "supplied" as const, file: pinFile(f.root, original), provenance: { origin: "manual" } },
      },
    ],
    members: [1, 2].map((index) => ({
      ...member,
      id: `item-${index}`,
      projectId: `item-${index}`,
      materials: ["product"],
      adapter: {
        kind: "template" as const,
        project: { ...f.project, scenes: [{ ...f.project.scenes[0], imageUrl: "material://product" }] },
      },
    })),
  };
  const plan = initCampaign(request, f.root);
  await approve(f.root, plan);
  const result = await runCampaignQueue(f.root, plan, async (task, context) =>
    ["material", "prepare", "anchors"].includes(task.kind)
      ? executeCampaignTask(task, context)
      : { outputs: [], blocked: true, message: "Render excluded from this material integration fixture" },
  );
  assert.deepEqual(
    result.tasks.filter((task) => task.state === "failed"),
    [],
  );
  const owner = readAssetRegistry("batch", f.root);
  assert.equal(owner.assets.length, 1);
  for (const item of plan.members) {
    const child = readAssetRegistry(item.projectId, f.root);
    assert.equal(child.assets.length, 1);
    const project = ProjectConfigSchema.parse(
      jsonFile(path.join(f.root, "public/projects", item.projectId, "project.json")),
    );
    assert.equal(project.scenes[0].imageUrl, child.assets[0].files.original);
    assert.equal(child.assets[0].hash, owner.assets[0].hash);
  }
});
test("localisation reflows three supplied audio tracks and resolves speech anchors without changing the source", async (t) => {
  const f = fixture(t),
    source = path.join(f.root, "public/projects/source");
  mkdirSync(source);
  const sourceFile = path.join(source, "project.json");
  writeFileSync(
    sourceFile,
    JSON.stringify({
      ...f.project,
      scenes: [{ ...f.project.scenes[0], text: "Original words", durationInFrames: 30 }],
    }),
  );
  const before = pinFile(f.root, sourceFile),
    audio = path.join(f.root, "replacement.mp3");
  assert.equal(
    spawnSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", audio],
      { encoding: "utf8" },
    ).status,
    0,
  );
  const members = ["en", "es", "fr"].map((language) => {
    const text =
      language === "en"
        ? "Longer synthetic words"
        : language === "es"
          ? "Palabras sintéticas largas"
          : "Longues paroles synthétiques";
    const words = text.split(" ").map((text, index) => ({ text, start: index * 0.5, end: index * 0.5 + 0.4 }));
    const alignment = path.join(f.root, `${language}.json`);
    writeFileSync(alignment, JSON.stringify(words));
    return {
      id: language,
      projectId: `local-${language}`,
      language,
      adapter: {
        kind: "localise" as const,
        translation: {
          version: 1 as const,
          sourceProjectId: "source",
          sourceLanguage: "en",
          targetLanguage: language,
          projectId: `local-${language}`,
          voice: "supplied",
          source: "Synthetic test copy",
          wordsPerSecond: 2,
          scenes: [{ id: "hook", text, headline: "Fixture" }],
        },
      },
      speech: [{ sceneId: "hook", audio: pinFile(f.root, audio), alignment: pinFile(f.root, alignment) }],
      anchors: [
        {
          id: "word",
          sceneId: "hook",
          alignment: pinFile(f.root, alignment),
          at: "word" as const,
          word: words[1].text,
        },
      ],
    };
  });
  const plan = initCampaign({ ...f.request, scenario: "localise-campaign", members }, f.root);
  await approve(f.root, plan);
  const executor = async (task: (typeof plan.tasks)[number], context: Parameters<typeof executeCampaignTask>[1]) =>
    ["prepare", "anchors"].includes(task.kind)
      ? executeCampaignTask(task, context)
      : { outputs: [], blocked: true, message: "Physical renders are covered separately" };
  const run = await runCampaignQueue(f.root, plan, executor);
  assert.deepEqual(
    run.tasks.filter((task) => task.state === "failed"),
    [],
  );
  for (const member of plan.members) {
    const directory = path.join(f.root, "public/projects", member.projectId),
      project = ProjectConfigSchema.parse(jsonFile(path.join(directory, "project.json")));
    assert.ok(project.scenes[0].durationInFrames! >= 60);
    assert.equal(
      (jsonFile(path.join(directory, "pipeline/campaign-anchors.json")) as { anchors: { frame: number }[] }).anchors[0]
        .frame,
      15,
    );
  }
  assert.deepEqual(pinFile(f.root, sourceFile), before);
  rmSync(path.join(f.root, "public/projects/local-en/voiceover/hook.mp3"));
  writeFileSync(path.join(f.root, "public/projects/local-fr/voiceover/hook.words.json"), "[]");
  const restored = await runCampaignQueue(f.root, plan, executor);
  assert.deepEqual(
    restored.tasks.filter((task) => task.state === "failed"),
    [],
  );
  assert.equal(
    pinFile(f.root, "public/projects/local-en/voiceover/hook.mp3").sha256,
    members[0].speech[0].audio.sha256,
  );
  assert.deepEqual(
    jsonFile(path.join(f.root, "public/projects/local-fr/voiceover/hook.words.json")),
    canonicalCampaignAlignment(jsonFile(path.join(f.root, members[2].speech[0].alignment.path))),
  );
  const revised = reviseCampaign({ ...f.request, revision: 2, scenario: "localise-campaign", members }, f.root);
  await approve(f.root, revised);
  const second = await runCampaignQueue(f.root, revised, executor);
  assert.deepEqual(
    second.tasks.filter((task) => task.state === "failed"),
    [],
  );
});
test("speech output IDs and symlinked destination folders cannot escape a child project", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "fixture.json");
  writeFileSync(file, "[]");
  assert.throws(() =>
    buildCampaignPlan(
      {
        ...f.request,
        members: [
          {
            ...f.request.members![0],
            speech: [{ sceneId: "../../outside", audio: pinFile(f.root, file), alignment: pinFile(f.root, file) }],
          },
        ],
      },
      f.root,
    ),
  );
});

test("a child's leftover legacy pipeline-state.json opens no template stage gate", (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "public/projects/batch-first");
  mkdirSync(path.join(directory, "pipeline"), { recursive: true });
  writeFileSync(path.join(directory, "project.json"), JSON.stringify(f.project));
  writeFileSync(
    path.join(directory, "pipeline/pipeline-state.json"),
    JSON.stringify({ projectId: "batch-first", stages: { brief: { status: "done" } }, history: [] }),
  );
  writeFileSync(path.join(directory, "pipeline/brief.json"), JSON.stringify({ fixture: "Exact supplied brief" }));
  const request = {
    ...f.request,
    members: [{ ...f.request.members![0], adapter: { kind: "existing" as const, projectId: "batch-first" } }],
  };
  const plan = initCampaign(request, f.root);
  bindCampaignChild(f.root, plan, "batch-first");
  assert.throws(() => reviewPackage(f.root, plan, "child-gates"), /No concrete review members/);
  // An old stage-approval receipt pinned to a since-changed brief cannot be renewed, so it no longer blocks the child.
  mkdirSync(path.join(directory, "pipeline/campaign-stage-approvals"), { recursive: true });
  writeFileSync(
    path.join(directory, "pipeline/campaign-stage-approvals/brief.json"),
    JSON.stringify({
      packageHash: "0".repeat(64),
      answer: "old",
      files: [{ path: "public/projects/batch-first/pipeline/brief.json", sha256: "f".repeat(64) }],
    }),
  );
  assert.doesNotThrow(() => assertProductionReferences(directory));
});
test("immutable task history preserves superseded receipts when changed inputs require new work", async (t) => {
  const f = fixture(t),
    plan = initCampaign(f.request, f.root);
  let revision = 1;
  const executor = async (task: (typeof plan.tasks)[number]) => {
    const output = path.join(f.root, `${task.id}.txt`);
    writeFileSync(output, String(revision));
    return { outputs: [output] };
  };
  const identity = () => revision;
  await runCampaignQueue(f.root, plan, executor, { identity });
  const task = plan.tasks[0],
    first = taskReceipt(f.root, plan, task, identity)!;
  revision++;
  const second = await runCampaignQueue(f.root, plan, executor, { identity });
  assert.ok(second.tasks.every((task) => task.state === "complete"));
  assert.notEqual(taskReceipt(f.root, plan, task, identity)!.inputHash, first.inputHash);
  assert.ok(
    existsSync(
      path.join(
        productionDirectory(f.root, "batch"),
        "receipts",
        plan.planHash,
        "history",
        `${task.id}-${digest(first)}.json`,
      ),
    ),
  );
});

test("explicit archive closes production and releases child retention without orphaning shared owners", async (t) => {
  const f = fixture(t),
    plan = initCampaign(f.request, f.root);
  await approve(f.root, plan);
  await runCampaign(f.root, "batch", { maxTasks: 1 });
  assert.ok(campaignRemovalBlockers(f.root, "batch-first").some((message) => message.includes("batch")));
  const record = await archiveCampaign(
    f.root,
    "batch",
    "Synthetic retention ended; preserve the owner until children are removed",
  );
  assert.equal(record.planHash, plan.planHash);
  assert.deepEqual(await archiveCampaign(f.root, "batch", "Same request"), record);
  assert.equal(campaignRemovalBlockers(f.root, "batch-first").length, 0);
  assert.ok(campaignRemovalBlockers(f.root, "batch").some((message) => message.includes("batch-first")));
  assert.equal(campaignNext(f.root, "batch").action, "stop");
  await assert.rejects(() => runCampaign(f.root, "batch"), /archived/);
  assert.throws(() => reviseCampaign({ ...f.request, revision: 2 }, f.root), /archived/);
  const { pack } = reviewPackage(f.root, plan, "creative-plan");
  await assert.rejects(
    () => approveCampaignPackage(f.root, plan, pack, pack.packageHash, "Fixture", "Fixture"),
    /archived/,
  );
});
test("snapshot, render identity and QA share explicit master audio and delivery timeline mode", async (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "public/projects/batch-first");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "project.json"), JSON.stringify(f.project));
  new TimelineEditStore(path.join(directory, "pipeline/timeline-edit.json")).initialize(
    adaptLegacyProject(f.project, "batch-first"),
  );
  const audio = path.join(directory, "master.wav");
  assert.equal(
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=3", audio]).status,
    0,
  );
  const master = path.join(directory, "master.wav.json");
  writeFileSync(
    master,
    JSON.stringify({
      source: "projects/batch-first/master.wav",
      sourceSha256: pinFile(f.root, audio).sha256,
      durationSec: 3,
      integratedLufs: -16,
      truePeakDb: -1.5,
      targetLufs: -16,
      createdAt: "2026-11-16T00:00:00Z",
    }),
  );
  const member = {
    ...f.request.members![0],
    adapter: { kind: "existing" as const, projectId: "batch-first" },
    delivery: {
      version: 1 as const,
      projectId: "batch-first",
      formats: ["vertical" as const],
      variants: ["clean" as const],
      timeline: false,
      audioMaster: path.relative(f.root, master),
      placements: ["test"],
      loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
    },
  };
  const plan = initCampaign({ ...f.request, members: [member] }, f.root);
  await approve(f.root, plan);
  bindCampaignChild(f.root, plan, member.projectId);
  const snapshot = captureDeliverySnapshot(member.delivery, { rootDir: f.root });
  const render = plan.tasks.find((task) => task.kind === "render")!;
  assert.equal(campaignTimeline(f.root, plan.members[0]), false);
  assert.equal(campaignInputIdentity(render, plan, f.root), snapshot.snapshot.identities[0].sourceSnapshotHash);
  assert.equal(campaignRenderOptions(f.root, plan.members[0]).audioMaster, path.relative(f.root, master));
  assert.throws(
    () => buildCampaignPlan({ ...f.request, members: [{ ...member, formats: ["square"] }] }, f.root),
    /same exact output set/,
  );
});

test("campaigns share resource limits and tolerate brief runtime writer contention", async (t) => {
  const f = fixture(t),
    first = initCampaign(f.request, f.root),
    second = initCampaign(
      { ...f.request, id: "other", members: [{ ...f.request.members![0], id: "other", projectId: "other-first" }] },
      f.root,
    );
  const release = acquireLock(path.join(f.root, ".cache/campaign-production/runtime.json.lock"))!;
  const timer = setTimeout(release, 80);
  t.after(() => clearTimeout(timer));
  const active: Record<string, number> = {},
    peak: Record<string, number> = {};
  const executor = async (task: (typeof first.tasks)[number], context: Parameters<typeof executeCampaignTask>[1]) => {
    active[task.resource] = (active[task.resource] ?? 0) + 1;
    peak[task.resource] = Math.max(peak[task.resource] ?? 0, active[task.resource]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const output = path.join(f.root, `${context.plan.request.id}-${task.id}.json`);
    writeFileSync(output, "{}");
    active[task.resource]--;
    return { outputs: [output] };
  };
  const limits = { generation: 1, process: 1, render: 1, qa: 1 };
  await Promise.all([
    runCampaignQueue(f.root, first, executor, { limits }),
    runCampaignQueue(f.root, second, executor, { limits }),
  ]);
  for (const plan of [first, second]) await runCampaignQueue(f.root, plan, executor, { limits });
  assert.ok(Object.values(peak).every((value) => value === 1));
  for (const plan of [first, second]) for (const task of plan.tasks) assert.ok(taskReceipt(f.root, plan, task));
});

test("speech replacement refuses a destination symlink to another project", async (t) => {
  const f = fixture(t),
    audio = path.join(f.root, "speech.mp3"),
    words = path.join(f.root, "words.json");
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "libmp3lame",
      audio,
    ]).status,
    0,
  );
  writeFileSync(words, JSON.stringify([{ text: "Fixture", start: 0, end: 0.5 }]));
  const project = { ...f.project, scenes: [{ ...f.project.scenes[0], text: "Fixture" }] };
  const member = {
    ...f.request.members![0],
    adapter: { kind: "template" as const, project },
    speech: [{ sceneId: "hook", audio: pinFile(f.root, audio), alignment: pinFile(f.root, words) }],
  };
  const plan = initCampaign({ ...f.request, members: [member] }, f.root);
  await approve(f.root, plan);
  await runCampaign(f.root, "batch", { maxTasks: 1 });
  const other = path.join(f.root, "public/projects/other");
  mkdirSync(other);
  symlinkSync(other, path.join(f.root, "public/projects/batch-first/voiceover"), "dir");
  assert.throws(() => resolveCampaignAnchors(f.root, plan, plan.members[0]), /escapes/);
  assert.equal(existsSync(path.join(other, "hook.mp3")), false);
});

test("review drafts dispatch a bounded repair proposal and exclusions retain the frozen allocation", async (t) => {
  const f = fixture(t);
  f.request.members!.push({ ...f.request.members![0], id: "second", projectId: "batch-second" });
  const plan = initCampaign(f.request, f.root);
  await approve(f.root, plan);
  atomicJson(path.join(productionDirectory(f.root, "batch"), "selection.json"), {
    revision: 1,
    planHash: plan.planHash,
    choices: [
      {
        planHash: plan.planHash,
        memberId: "second",
        choice: "reject",
        note: "Synthetic user review draft",
        outputs: [],
        kind: "review-draft",
        at: new Date().toISOString(),
      },
    ],
  });
  assert.equal(campaignNext(f.root, "batch").action, "dispatch");
  const brief = campaignBrief(f.root, "batch", "review-repair");
  assert.match(brief.prompt, /excluded:true/);
  assert.ok("output" in brief);
  assert.ok(brief.output);
  immutableJson(path.resolve(f.root, brief.output!), {
    ...f.request,
    revision: 2,
    members: f.request.members!.map((member) => ({ ...member, ...(member.id === "second" ? { excluded: true } : {}) })),
  });
  assert.equal(campaignNext(f.root, "batch").action, "run");
  const revised = reviseCampaign(jsonFile(path.resolve(f.root, brief.output!)) as CampaignProductionRequest, f.root);
  assert.equal(revised.allocationHash, plan.allocationHash);
  assert.equal(revised.allocation.owners.length, 3);
  assert.equal(
    revised.tasks.some((task) => task.memberId === "second"),
    false,
  );
  assert.equal(campaignStatus(f.root, "batch").selectedMemberCount, 1);
  assert.deepEqual(campaignStatus(f.root, "batch").rejectedMemberIds, ["second"]);
  assert.equal(campaignNext(f.root, "batch").action, "ask");
});
test("existing bespoke films and legacy project IDs retain their format and normal child gates", async (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "public/projects/Film_Existing");
  scaffoldFilmProject(directory, "Film_Existing", [], { filmType: "motion-graphics" });
  const plan = initCampaign(
    {
      ...f.request,
      members: [
        {
          id: "film",
          projectId: "Film_Existing",
          language: "en",
          adapter: { kind: "existing", projectId: "Film_Existing" },
        },
      ],
    },
    f.root,
  );
  await approve(f.root, plan);
  assert.deepEqual(plan.members[0].variants, ["captioned"]);
  await runCampaign(f.root, "batch", { maxTasks: 1 });
  assert.ok(existsSync(path.join(directory, "pipeline/campaign-preparation.json")));
  assert.equal((campaignNext(f.root, "batch") as { childProjectId?: string }).childProjectId, "Film_Existing");
  assert.throws(
    () =>
      buildCampaignPlan(
        {
          ...f.request,
          id: "other",
          members: [
            {
              id: "film",
              projectId: "Film_Existing",
              language: "en",
              formats: ["square"],
              adapter: { kind: "existing", projectId: "Film_Existing" },
            },
          ],
        },
        f.root,
      ),
    /format must match/,
  );
});

test("catalogue identifiers survive unsafe SKUs and reordered rows without reallocating owners", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "products.json"),
    rows = [
      { sku: "SKU A/42", name: "One" },
      { sku: "товар 2", name: "Two" },
    ];
  writeFileSync(file, JSON.stringify(rows));
  const request = {
    ...f.request,
    scenario: "catalogue-videos" as const,
    members: [],
    catalogue: {
      file: pinFile(f.root, file),
      format: "json" as const,
      idColumn: "sku",
      columns: { name: "name" },
      memberTemplate: {
        id: "{{memberId}}",
        projectId: "{{projectId}}",
        language: "en",
        adapter: { kind: "template", project: f.project },
      },
    },
  };
  const first = initCampaign(request, f.root);
  assert.equal(first.members[0].productId, "SKU A/42");
  assert.match(first.members[0].id, /^sku-a-42-/);
  writeFileSync(file, JSON.stringify([...rows].reverse()));
  const second = reviseCampaign(
    { ...request, revision: 2, catalogue: { ...request.catalogue, file: pinFile(f.root, file) } },
    f.root,
  );
  assert.equal(second.allocationHash, first.allocationHash);
  assert.equal(second.members[1].projectId, first.members[0].projectId);
});
test("supplied outcomes can name a historical revision and exact recorded output hashes", async (t) => {
  const f = fixture(t),
    first = initCampaign(f.request, f.root);
  await runCampaignQueue(f.root, first, async (task) => {
    const output = path.join(f.root, `${task.id}${task.kind === "render" ? ".mp4" : ".txt"}`);
    writeFileSync(output, "Explicit non-media protocol fixture");
    return { outputs: [output] };
  });
  const render = first.tasks.find((task) => task.kind === "render")!,
    receipt = taskReceipt(f.root, first, render)!;
  const output = receipt.outputs[0];
  reviseCampaign({ ...f.request, revision: 2, brief: "New hypothesis" }, f.root);
  writeFileSync(path.resolve(f.root, output.path), "New bytes replaced the old export");
  const raw = {
    version: 1,
    campaignId: "batch",
    episodeId: "first",
    planHash: first.planHash,
    outputHashes: [output.sha256],
    observedAt: new Date().toISOString(),
    source: "Synthetic supplied data",
    cohort: "fixture",
    metrics: { views: 10 },
    review: { reviewedBy: "fixture", evidence: "No real business performance" },
  };
  const result = recordCampaignOutcome(f.root, "batch", raw);
  assert.equal(result.outcome.planHash, first.planHash);
  assert.equal(result.outcome.attributionScope, "exact-outputs");
  assert.equal(result.outcome.outputAvailability[0].bytesPresent, false);
  assert.throws(
    () => recordCampaignOutcome(f.root, "batch", { ...raw, outputHashes: ["0".repeat(64)] }),
    /not recorded/,
  );
});

test("replacement speech cannot retain an anchor pinned to an older alignment", (t) => {
  const f = fixture(t),
    old = path.join(f.root, "old.json"),
    fresh = path.join(f.root, "new.json"),
    audio = path.join(f.root, "audio.mp3");
  writeFileSync(old, JSON.stringify([{ text: "Now", start: 0, end: 0.3 }]));
  writeFileSync(fresh, JSON.stringify([{ text: "Now", start: 0.5, end: 1 }]));
  writeFileSync(audio, "Planning fixture only");
  assert.throws(
    () =>
      buildCampaignPlan(
        {
          ...f.request,
          members: [
            {
              ...f.request.members![0],
              speech: [{ sceneId: "hook", audio: pinFile(f.root, audio), alignment: pinFile(f.root, fresh) }],
              anchors: [{ id: "cue", sceneId: "hook", at: "word", word: "Now", alignment: pinFile(f.root, old) }],
            },
          ],
        },
        f.root,
      ),
    /exact replacement alignment/,
  );
});
