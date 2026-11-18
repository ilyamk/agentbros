import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureRenderIdentity, withRenderIdentityReadCache } from "../src/lib/delivery/identity";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { ProjectConfigSchema } from "../src/types/video";
import { initCampaign, reviseCampaign } from "../src/lib/campaigns/production/store";
import { campaignBrief, campaignNext, recordCampaignDecision } from "../src/lib/campaigns/production/service";
import { reviewPackage, approveCampaignPackage, packageApproved } from "../src/lib/campaigns/production/review";
import { campaignInputIdentity, executeCampaignTask } from "../src/lib/campaigns/production/execute";
import { runCampaignQueue, taskInputHash, taskReceipt } from "../src/lib/campaigns/production/queue";
import { pinFile, productionDirectory, atomicJson, digest, jsonFile } from "../src/lib/campaigns/production/files";
import { validateCampaignMember } from "../src/lib/campaigns/production/assurance";
import { repairCampaignMember } from "../src/lib/campaigns/production/repair";
import { OperationStore } from "../src/lib/jobs/store";
import { needsForProject } from "../src/lib/shared-assets/cli";
import { pilotTaskIds } from "../src/lib/campaigns/production/pilot";

function fixture(t: TestContext, pilot = false, generation = false, authorised = false) {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-reliability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/projects"), { recursive: true });
  const project = ProjectConfigSchema.parse({
    name: "Synthetic",
    productName: "Original product",
    colors: {},
    musicVolume: 0,
    formats: ["vertical"],
    scenes: [
      {
        id: "hook",
        headline: "Original product",
        text: "",
        visualType: "title",
        durationInFrames: 30,
        transitionToNext: "cut",
      },
    ],
  });
  const generationRequest = path.join(root, "generation.json");
  if (generation)
    writeFileSync(
      generationRequest,
      JSON.stringify({ provider: "fal", endpoint: "explicit-fixture/image", input: {} }),
    );
  const plan = initCampaign(
    {
      version: 1,
      id: "batch",
      revision: 1,
      scenario: "ad-experiments",
      ...(authorised ? { spend: "authorised" as const, capUsd: 1, sharedQuotaUsd: 1 } : {}),
      brief: "Local protocol fixture, no live agent judgement",
      ...(generation
        ? {
            materials: [
              {
                id: "source",
                owner: "shared",
                source: {
                  kind: "generate" as const,
                  useCase: "fixture",
                  request: pinFile(root, generationRequest),
                  output: "public/projects/batch/source.png",
                  reason: "Synthetic capacity fixture only",
                },
              },
            ],
          }
        : {}),
      ...(pilot ? { policy: { pilotMemberIds: ["one"] } } : {}),
      members: ["one", "two"].map((id) => ({
        id,
        projectId: id,
        language: "en",
        adapter: { kind: "template", project },
      })),
    },
    root,
  );
  return { root, plan, project };
}
async function approve(f: ReturnType<typeof fixture>) {
  const { pack } = reviewPackage(f.root, f.plan, "creative-plan");
  await approveCampaignPackage(
    f.root,
    f.plan,
    pack,
    pack.packageHash,
    "Explicit synthetic test decision only",
    "fixture",
  );
}
function feedback(
  f: ReturnType<typeof fixture>,
  taskId: string,
  verdict: "revise" | "accept" = "revise",
  supersedes?: string,
) {
  const task = f.plan.tasks.find((task) => task.id === taskId)!,
    file = path.join(f.root, `feedback-${taskId}.json`);
  writeFileSync(file, JSON.stringify({ fixture: true, verdict }));
  const pin = pinFile(f.root, file);
  const outputs = (task.payload.agentTask as { outputs: string[] }).outputs;
  const pins =
    verdict === "accept"
      ? outputs.map((output) => {
          const target = path.join(f.root, output);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, '{"fixture":true}');
          return pinFile(f.root, target);
        })
      : [];
  return {
    version: 1,
    taskId,
    planHash: f.plan.planHash,
    inputHash: taskInputHash(f.root, f.plan, task, campaignInputIdentity),
    agent: "creative-critic",
    verdict,
    rationale: "Synthetic check of the named presentation issue",
    evidence: [pin],
    outputs: pins,
    issues:
      verdict === "revise"
        ? [
            {
              id: "hold",
              category: "timing",
              sceneId: "hook",
              instruction: "Hold for 40 frames",
              acceptance: "Duration is 40 frames",
              evidence: [pin],
            },
          ]
        : [],
    ...(supersedes ? { supersedes } : {}),
  };
}
async function throughQa(f: ReturnType<typeof fixture>, allowedTaskIds?: Set<string>) {
  return runCampaignQueue(
    f.root,
    f.plan,
    async (task, context) => {
      if (["prepare", "anchors"].includes(task.kind)) return executeCampaignTask(task, context);
      if (task.kind === "agent") return { outputs: [], blocked: true };
      const file = path.join(f.root, `${task.id}.txt`);
      writeFileSync(file, "Explicit protocol fixture, not renderer evidence");
      return { outputs: [file] };
    },
    { identity: campaignInputIdentity, allowedTaskIds },
  );
}
test("negative feedback has a CAS-protected attempt chain and accepted feedback is consumed rather than redispatched", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const first = recordCampaignDecision(f.root, "batch", feedback(f, "critique-one"));
  assert.equal(campaignNext(f.root, "batch").reasonCode, "REPAIR_REQUIRED");
  const handoff = campaignBrief(f.root, "batch", "repair-critique-one");
  assert.equal(handoff.agent, "fixer");
  assert.ok(handoff.prompt.includes("--project batch --action repair"));
  const second = feedback(f, "critique-one", "accept");
  assert.throws(() => recordCampaignDecision(f.root, "batch", second), /superseded/);
  recordCampaignDecision(f.root, "batch", { ...second, supersedes: first.hash });
  assert.equal(campaignNext(f.root, "batch").reasonCode, "DECISION_READY");
  assert.throws(
    () =>
      recordCampaignDecision(f.root, "batch", {
        ...second,
        supersedes: first.hash,
        rationale: "Concurrent stale writer",
      }),
    /superseded/,
  );
});
test("unchanged negative decisions cannot spin, while a changed attempt is bounded", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const raw = feedback(f, "critique-one"),
    first = recordCampaignDecision(f.root, "batch", raw);
  assert.throws(() => recordCampaignDecision(f.root, "batch", { ...raw, supersedes: first.hash }), /no progress/);
  const second = recordCampaignDecision(f.root, "batch", {
    ...raw,
    supersedes: first.hash,
    rationale: "Second independent fixture inspection",
  });
  recordCampaignDecision(f.root, "batch", {
    ...raw,
    supersedes: second.hash,
    rationale: "Third independent fixture inspection",
  });
  assert.equal(campaignNext(f.root, "batch").reasonCode, "ATTEMPT_LIMIT");
});
test("task failures stop after the bounded attempts and do not repeat external work indefinitely", async (t) => {
  const f = fixture(t);
  await approve(f);
  const fail = async () => {
    throw new Error("Persistent explicit fixture failure");
  };
  for (let index = 0; index < 3; index++)
    assert.equal((await runCampaignQueue(f.root, f.plan, fail, { identity: campaignInputIdentity })).attempted, 2);
  assert.equal((await runCampaignQueue(f.root, f.plan, fail, { identity: campaignInputIdentity })).attempted, 0);
  assert.equal(campaignNext(f.root, "batch").reasonCode, "ATTEMPT_LIMIT");
});
test("pending work is wait, not complete, and dead local owners are recoverable", async (t) => {
  const f = fixture(t);
  await approve(f);
  const file = path.join(f.root, ".cache/campaign-production/runtime.json");
  const records = Object.fromEntries(
    f.plan.tasks
      .filter((task) => task.kind === "prepare")
      .map((task) => [
        `batch.${f.plan.planHash}.${task.id}`,
        {
          state: "waiting",
          pid: process.pid,
          token: "fixture",
          resource: "process",
          resourceKey: "process",
          wakeAt: Date.now() + 10000,
        },
      ]),
  );
  atomicJson(file, { version: 1, limits: { generation: 2, process: 2, render: 1, qa: 2 }, records });
  assert.equal(campaignNext(f.root, "batch").action, "wait");
  for (const record of Object.values(records)) record.wakeAt = Date.now() - 1;
  atomicJson(file, { version: 1, limits: { generation: 2, process: 2, render: 1, qa: 2 }, records });
  assert.equal(campaignNext(f.root, "batch").action, "run");
  for (const record of Object.values(records)) Object.assign(record, { state: "running", pid: 2147483647 });
  atomicJson(file, { version: 1, limits: { generation: 2, process: 2, render: 1, qa: 2 }, records });
  assert.equal(campaignNext(f.root, "batch").action, "run");
});
test("pilot dependencies execute first and only the exact reviewed pilot releases remaining members", async (t) => {
  const f = fixture(t, true);
  await approve(f);
  const allowed = pilotTaskIds(f.root, f.plan)!;
  assert.ok(!allowed.has("prepare-two"));
  await runCampaignQueue(
    f.root,
    f.plan,
    async (task) => {
      const file = path.join(f.root, `${task.id}.txt`);
      writeFileSync(file, "Synthetic pilot contract only");
      return { outputs: [file] };
    },
    { allowedTaskIds: allowed },
  );
  assert.equal(campaignNext(f.root, "batch").reasonCode, "PILOT_REVIEW_REQUIRED");
  const { pack } = reviewPackage(f.root, f.plan, "pilot-outputs");
  await approveCampaignPackage(f.root, f.plan, pack, pack.packageHash, "Synthetic pilot package decision", "fixture");
  assert.equal(pilotTaskIds(f.root, f.plan), undefined);
  assert.equal(packageApproved(f.root, f.plan, "final-outputs"), false);
  assert.throws(() => reviewPackage(f.root, f.plan, "pilot-outputs", ["two"]), /missing|duplicate|ready/);
});
test("safe presentation repair preserves business facts and invalidates only the affected dependants", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const task = f.plan.tasks.find((task) => task.id === "render-one-vertical-clean")!,
    other = f.plan.tasks.find((task) => task.id === "render-two-vertical-clean")!;
  assert.ok(taskReceipt(f.root, f.plan, task, campaignInputIdentity));
  const current = recordCampaignDecision(f.root, "batch", feedback(f, "critique-one"));
  const expectedProject = pinFile(f.root, "public/projects/one/project.json");
  const request = {
    version: 1,
    memberId: "one",
    decisionHash: current.hash,
    expectedProject,
    changes: [{ sceneId: "hook", durationInFrames: 40 }],
    reason: "Only the named hold is changed",
  };
  assert.throws(
    () => repairCampaignMember(f.root, "batch", { ...request, changes: [{ sceneId: "hook", text: "Changed offer" }] }),
    /Unrecognized|unrecognized/,
  );
  repairCampaignMember(f.root, "batch", request);
  const project = ProjectConfigSchema.parse(jsonFile(path.join(f.root, "public/projects/one/project.json")));
  assert.equal(project.productName, f.project.productName);
  assert.equal(project.scenes[0].headline, f.project.scenes[0].headline);
  assert.equal(project.scenes[0].durationInFrames, 40);
  assert.equal(taskReceipt(f.root, f.plan, task, campaignInputIdentity), null);
  assert.ok(taskReceipt(f.root, f.plan, other, campaignInputIdentity));
  assert.equal(packageApproved(f.root, f.plan, "creative-plan"), true);
});
test("scenario assurance rejects mixed products, unmapped reference slots, missing speech and duplicate episodes", (t) => {
  const f = fixture(t),
    member = f.plan.members[0];
  const strict = {
    ...f.plan,
    request: { ...f.plan.request, policy: { quality: "strict" as const }, scenario: "catalogue-videos" as const },
  };
  const result = validateCampaignMember(f.root, strict, member);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.code === "PRODUCT_FACTS_UNBOUND"));
  const source = path.join(f.root, "facts.json");
  writeFileSync(source, '{"name":"Original product"}');
  const assured = {
    ...member,
    adapter: {
      kind: "template" as const,
      project: { ...f.project, scenes: [{ ...f.project.scenes[0], headline: "Original product SKU" }] },
    },
    productId: "SKU",
    assurance: {
      facts: [
        { key: "name", value: "Original product", source: pinFile(f.root, source) },
        { key: "productId", value: "SKU", source: pinFile(f.root, source) },
      ],
      requiredText: [],
      forbiddenText: [],
      referenceSlots: [],
    },
  };
  assert.equal(validateCampaignMember(f.root, strict, assured).passed, true);
  writeFileSync(source, "{}");
  assert.equal(validateCampaignMember(f.root, strict, assured).passed, false);
  const series = { ...strict, request: { ...strict.request, scenario: "content-series" as const } };
  assert.ok(
    validateCampaignMember(f.root, series, { ...member, scheduledFor: "2026-02-30" }).issues.some(
      (issue) => issue.code === "EPISODE_DATE_INVALID",
    ),
  );
  assert.ok(validateCampaignMember(f.root, series, member).issues.some((issue) => issue.code === "DUPLICATE_EPISODE"));
});
test("decision publication resumes a journalled attempt after a crash before pointer replacement", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const first = recordCampaignDecision(f.root, "batch", feedback(f, "critique-one"));
  const incoming = { ...feedback(f, "critique-one", "accept"), supersedes: first.hash };
  const file = path.join(
    productionDirectory(f.root, "batch"),
    "decisions",
    f.plan.planHash,
    "history/critique-one",
    `${digest(incoming)}.json`,
  );
  atomicJson(file, incoming);
  assert.equal(recordCampaignDecision(f.root, "batch", incoming).hash, digest(incoming));
  assert.equal(campaignNext(f.root, "batch").reasonCode, "DECISION_READY");
});
test("repair resumes after project publication and refuses unrelated intervening edits", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const current = recordCampaignDecision(f.root, "batch", feedback(f, "critique-one"));
  const request = {
    version: 1,
    memberId: "one",
    decisionHash: current.hash,
    expectedProject: pinFile(f.root, "public/projects/one/project.json"),
    changes: [{ sceneId: "hook", durationInFrames: 40 }],
    reason: "Exact synthetic repair",
  };
  const applied = repairCampaignMember(f.root, "batch", request),
    intent = jsonFile(applied.file) as { record: unknown };
  atomicJson(path.join(f.root, "public/projects/one/pipeline/campaign-preparation.json"), intent.record);
  assert.deepEqual(repairCampaignMember(f.root, "batch", request).project, applied.project);
  const file = path.join(f.root, "public/projects/one/project.json"),
    project = ProjectConfigSchema.parse(jsonFile(file));
  atomicJson(file, { ...project, productName: "Intervening business edit" });
  assert.throws(() => repairCampaignMember(f.root, "batch", request), /subsequent/);
});
test("a stale critique cannot authorise a repair against newly changed inputs", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const current = recordCampaignDecision(f.root, "batch", feedback(f, "critique-one"));
  const file = path.join(f.root, "public/projects/one/project.json");
  atomicJson(file, { ...f.project, tagline: "An intervening edit" });
  assert.throws(
    () =>
      repairCampaignMember(f.root, "batch", {
        version: 1,
        memberId: "one",
        decisionHash: current.hash,
        expectedProject: pinFile(f.root, file),
        changes: [{ sceneId: "hook", durationInFrames: 40 }],
        reason: "Stale review must fail",
      }),
    /stale|dependenc/i,
  );
});

test("delivery source snapshots do not create media needs for unmounted library components", (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "public/projects/one/pipeline/snapshots");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "source.json"),
    JSON.stringify({ sources: ["src/motion/library/scenes/StudioProductStage.tsx"] }),
  );
  assert.deepEqual(needsForProject("one", f.root), []);
  const source = path.join(f.root, "src/projects/one");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "Scene.tsx"), "export const scene = StudioProductStage;");
  assert.ok(needsForProject("one", f.root).includes("3d:phone"));
});

test("a blocked early task cannot starve independent ready work in bounded invocations", async (t) => {
  const f = fixture(t);
  await approve(f);
  const seen: string[] = [];
  const executor = async (task: (typeof f.plan.tasks)[number]) => {
    seen.push(task.id);
    if (task.id === "prepare-one") return { outputs: [], blocked: true };
    const file = path.join(f.root, task.id + ".txt");
    writeFileSync(file, "Protocol fixture");
    return { outputs: [file] };
  };
  await runCampaignQueue(f.root, f.plan, executor, { maxTasks: 1 });
  await runCampaignQueue(f.root, f.plan, executor, { maxTasks: 1 });
  assert.deepEqual(seen, ["prepare-one", "prepare-two"]);
});
test("decision and repair journal ancestors cannot redirect writes outside the workspace", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const current = recordCampaignDecision(f.root, "batch", feedback(f, "critique-one"));
  const outside = mkdtempSync(path.join(tmpdir(), "campaign-external-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const history = path.join(productionDirectory(f.root, "batch"), "decisions", f.plan.planHash, "history/critique-one");
  rmSync(history, { recursive: true });
  symlinkSync(outside, history, "dir");
  assert.throws(
    () =>
      recordCampaignDecision(f.root, "batch", { ...feedback(f, "critique-one", "accept"), supersedes: current.hash }),
    /outside|escape|symlink/i,
  );
  const repairs = path.join(productionDirectory(f.root, "batch"), "repairs");
  mkdirSync(repairs);
  symlinkSync(outside, path.join(repairs, f.plan.planHash), "dir");
  assert.throws(
    () =>
      repairCampaignMember(f.root, "batch", {
        version: 1,
        memberId: "one",
        decisionHash: current.hash,
        expectedProject: pinFile(f.root, "public/projects/one/project.json"),
        changes: [{ sceneId: "hook", durationInFrames: 40 }],
        reason: "Refuse redirected journals",
      }),
    /outside|escape|symlink/i,
  );
  assert.deepEqual(readdirSync(outside), []);
});
test("stale accepted outputs request a new specialist decision instead of endless zero-attempt runs", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const initial = campaignBrief(f.root, "batch", "critique-one");
  const current = recordCampaignDecision(f.root, "batch", feedback(f, "critique-one", "accept"));
  writeFileSync(path.join(f.root, current.decision.outputs[0].path), "An intervening output edit");
  assert.equal(campaignNext(f.root, "batch").reasonCode, "DECISION_EVIDENCE_STALE");
  const fresh = campaignBrief(f.root, "batch", "critique-one");
  assert.notEqual(fresh.file, initial.file);
  recordCampaignDecision(f.root, "batch", {
    ...feedback(f, "critique-one", "accept", current.hash),
    rationale: "Restored fixture output inspected again",
  });
  assert.equal(campaignNext(f.root, "batch").reasonCode, "DECISION_READY");
});
test("strict experiments reject deleted protected scenes from existing controls", (t) => {
  const f = fixture(t),
    controlProject = {
      ...f.project,
      scenes: [...f.project.scenes, { ...f.project.scenes[0], id: "proof", headline: "Mandatory disclosure" }],
    };
  const control = path.join(f.root, "public/projects/one");
  mkdirSync(control);
  atomicJson(path.join(control, "project.json"), controlProject);
  const plan = {
    ...f.plan,
    request: {
      ...f.plan.request,
      policy: {
        quality: "strict" as const,
        controlMemberId: "one",
        variableFactors: ["hook"],
        variableSceneIds: ["hook"],
      },
    },
  };
  plan.members[0] = { ...plan.members[0], adapter: { kind: "existing", projectId: "one" } };
  const result = validateCampaignMember(f.root, plan, plan.members[1]);
  assert.ok(result.issues.some((issue) => issue.code === "PRESERVED_SCENE_MISSING"));
});

test("capacity refusal does not consume the bounded invocation before independent work is considered", async (t) => {
  const f = fixture(t, false, true);
  await approve(f);
  const file = path.join(f.root, ".cache/campaign-production/runtime.json");
  atomicJson(file, {
    version: 1,
    limits: { generation: 1, process: 2, render: 1, qa: 2 },
    records: {
      "foreign.plan.material-source": {
        state: "running",
        pid: process.pid,
        token: "other-owner",
        resource: "generation",
        resourceKey: "fal",
      },
    },
  });
  const seen: string[] = [];
  await runCampaignQueue(
    f.root,
    f.plan,
    async (task) => {
      seen.push(task.id);
      const output = path.join(f.root, "capacity.txt");
      writeFileSync(output, "Local protocol fixture");
      return { outputs: [output] };
    },
    { maxTasks: 1 },
  );
  assert.deepEqual(seen, ["prepare-one"]);
});
test("non-pilot bespoke children cannot bypass pilot dispatch eligibility", async (t) => {
  const f = fixture(t, true);
  await approve(f);
  scaffoldFilmProject(path.join(f.root, "public/projects/two"), "two", [], { filmType: "motion-graphics" });
  const next = campaignNext(f.root, "batch");
  assert.equal(next.action, "run");
  assert.notEqual((next as { childProjectId?: string }).childProjectId, "two");
});

test("a standalone receipt check visits shared dependencies once and never carries cache across calls", async (t) => {
  const f = fixture(t),
    request = {
      ...f.plan.request,
      revision: 2,
      members: f.plan.members.map((member, index) =>
        index ? member : { ...member, variants: ["clean", "captioned"] as const },
      ),
    };
  const plan = reviseCampaign(
    { ...request, members: request.members.map((member) => ({ ...member, variants: [...member.variants] })) },
    f.root,
  );
  const seen = new Map<string, number>(),
    identity = (task: (typeof plan.tasks)[number]) => {
      seen.set(task.id, (seen.get(task.id) ?? 0) + 1);
      return null;
    };
  await runCampaignQueue(
    f.root,
    plan,
    async (task) => {
      const file = path.join(f.root, task.id + ".txt");
      writeFileSync(file, "Explicit DAG fixture");
      return { outputs: [file] };
    },
    { identity },
  );
  const task = plan.tasks.find((task) => task.id === "critique-one")!;
  seen.clear();
  assert.ok(taskReceipt(f.root, plan, task, identity));
  assert.equal(seen.get("prepare-one"), 1);
  writeFileSync(path.join(f.root, "prepare-one.txt"), "Changed after the completed scan");
  assert.equal(taskReceipt(f.root, plan, task, identity), null);
});
test("a due pending operation resumes with the original operation identity and completes", async (t) => {
  const f = fixture(t, false, true);
  await approve(f);
  const ids: unknown[] = [],
    allowedTaskIds = new Set(["material-source"]);
  let polled = false;
  const executor = async (task: (typeof f.plan.tasks)[number]) => {
    ids.push(task.payload.operationId);
    if (!polled) {
      polled = true;
      return { outputs: [], pending: true, retryAfterMs: 10000 };
    }
    const file = path.join(f.root, "published-fixture.txt");
    writeFileSync(file, "Synthetic provider publication");
    return { outputs: [file] };
  };
  await runCampaignQueue(f.root, f.plan, executor, { allowedTaskIds });
  const file = path.join(f.root, ".cache/campaign-production/runtime.json"),
    runtime = jsonFile(file) as { records: Record<string, { wakeAt: number }> };
  Object.values(runtime.records).forEach((record) => {
    record.wakeAt = 0;
  });
  atomicJson(file, runtime);
  const resumed = await runCampaignQueue(f.root, f.plan, executor, { allowedTaskIds });
  assert.equal(resumed.tasks.find((task) => task.id === "material-source")?.state, "complete");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("render code snapshots are shared only inside a synchronous read scope and refreshed afterwards", async (t) => {
  const f = fixture(t);
  await approve(f);
  await throughQa(f);
  const source = path.join(f.root, "src/scene.ts");
  mkdirSync(path.dirname(source));
  writeFileSync(source, "export const value = 1;");
  const identities = withRenderIdentityReadCache(() =>
    ["one", "two"].map((id) => captureRenderIdentity(id, "vertical", { rootDir: f.root, captions: "off" })),
  );
  const code = identities.map((identity) => identity.sources.find((source) => source.path === "src/scene.ts")!.sha256);
  assert.equal(code[0], code[1]);
  writeFileSync(source, "export const value = 2;");
  const fresh = withRenderIdentityReadCache(() =>
    captureRenderIdentity("one", "vertical", { rootDir: f.root, captions: "off" }),
  );
  assert.notEqual(fresh.sources.find((source) => source.path === "src/scene.ts")!.sha256, code[0]);
});

test("an unavailable exact model produces a pinned capability blocker without provider submission", async (t) => {
  const f = fixture(t, false, true);
  await approve(f);
  const task = f.plan.tasks.find((task) => task.id === "material-source")!;
  const result = await executeCampaignTask(task, {
    root: f.root,
    plan: f.plan,
    inputHash: taskInputHash(f.root, f.plan, task),
    paid: false,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reasonCode, "MODEL_UNAVAILABLE");
  assert.equal(result.outputs.length, 1);
  const operations = jsonFile(path.join(f.root, "public/projects/batch/pipeline/operations.json")) as {
    jobs: Record<string, unknown>;
  };
  assert.deepEqual(operations.jobs, {});
});
test("specialist briefs reject tools outside the existing command registry", (t) => {
  const f = fixture(t);
  reviseCampaign(
    {
      ...f.plan.request,
      revision: 2,
      agentTasks: [
        {
          id: "discovery",
          agent: "campaign-producer",
          purpose: "Explicit tool contract fixture",
          outputs: ["discovery.json"],
          requirements: { commands: ["invented:provider"], modelUseCases: [], acceptance: ["Use an existing command"] },
        },
      ],
    },
    f.root,
  );
  assert.throws(() => campaignBrief(f.root, "batch", "discovery"), /unregistered command/);
});

test("an occupied pool returns a bounded wait instead of a zero-attempt run loop", async (t) => {
  const f = fixture(t, false, true);
  f.plan = reviseCampaign(
    { ...f.plan.request, revision: 2, members: f.plan.members.map((member) => ({ ...member, materials: ["source"] })) },
    f.root,
  );
  await approve(f);
  const file = path.join(f.root, ".cache/campaign-production/runtime.json");
  atomicJson(file, {
    version: 1,
    limits: { generation: 1, process: 2, render: 1, qa: 2 },
    records: {
      "foreign.plan.material-source": {
        state: "running",
        pid: process.pid,
        token: "other-owner",
        resource: "generation",
        resourceKey: "fal",
      },
    },
  });
  const result = await runCampaignQueue(f.root, f.plan, async () => {
    throw Error("Occupied work must not start");
  });
  assert.equal(result.attempted, 0);
  const next = campaignNext(f.root, "batch");
  assert.equal(next.action, "wait");
  assert.equal(next.reasonCode, "RESOURCE_CAPACITY");
});

test("unavailable member inputs become scoped blockers while independent members continue", async (t) => {
  const f = fixture(t);
  await approve(f);
  let unavailable = true;
  const identity = (task: (typeof f.plan.tasks)[number]) => {
    if (task.id === "render-one-vertical-clean" && unavailable) throw Error("Exact fixture source is unavailable");
    return null;
  };
  const executor = async (task: (typeof f.plan.tasks)[number]) => {
    const file = path.join(f.root, task.id + ".txt");
    writeFileSync(file, "Explicit independent-work fixture");
    return { outputs: [file] };
  };
  const first = await runCampaignQueue(f.root, f.plan, executor, { identity });
  assert.equal(first.tasks.find((task) => task.id === "render-one-vertical-clean")?.state, "blocked");
  assert.equal(first.tasks.find((task) => task.id === "render-two-vertical-clean")?.state, "complete");
  unavailable = false;
  const resumed = await runCampaignQueue(f.root, f.plan, executor, { identity });
  assert.equal(
    resumed.tasks.every((task) => task.state === "complete"),
    true,
  );
});

test("an output approval cannot repeatedly retry unresolved strict delivery requirements", async (t) => {
  const f = fixture(t);
  f.plan = reviseCampaign(
    {
      ...f.plan.request,
      revision: 2,
      members: f.plan.members.map((member) => ({
        ...member,
        delivery: {
          version: 1,
          projectId: member.projectId,
          formats: ["vertical"],
          variants: ["clean"],
          placements: ["fixture"],
          loudness: { targetLufs: -21, toleranceLu: 5, maxTruePeakDb: 0, audioRequired: false },
        },
      })),
    },
    f.root,
  );
  await approve(f);
  await runCampaignQueue(f.root, f.plan, async (task) => {
    if (task.kind === "delivery")
      return {
        outputs: [],
        blocked: true,
        reasonCode: "DELIVERY_REQUIREMENTS",
        message: "Exact fixture rights evidence is missing",
      };
    const file = path.join(f.root, task.id + ".txt");
    writeFileSync(file, "Protocol fixture, not a rendered output");
    return { outputs: [file] };
  });
  const { pack } = reviewPackage(f.root, f.plan, "final-outputs");
  await approveCampaignPackage(
    f.root,
    f.plan,
    pack,
    pack.packageHash,
    "Explicit fixture output declaration",
    "fixture",
  );
  assert.equal(campaignNext(f.root, "batch").action, "ask");
  assert.equal(campaignNext(f.root, "batch").reasonCode, "DELIVERY_REQUIREMENTS");
});

test("a dead generation owner retains its uncertain paid operation slot and resumes that identity", async (t) => {
  const f = fixture(t, false, true, true),
    original = f.plan.request.materials[0];
  assert.equal(original.source.kind, "generate");
  if (original.source.kind !== "generate") return;
  f.plan = reviseCampaign(
    {
      ...f.plan.request,
      revision: 2,
      materials: [
        original,
        { ...original, id: "other", source: { ...original.source, output: "public/projects/batch/other.png" } },
      ],
    },
    f.root,
  );
  await approve(f);
  const task = f.plan.tasks.find((task) => task.id === "material-source")!,
    operationId = String(task.payload.operationId);
  const store = new OperationStore("batch", { directory: path.join(f.root, "public/projects/batch/pipeline") });
  store.reserveOperation({
    operationId,
    provider: "fal.ai",
    endpoint: "explicit-fixture/image",
    inputHash: "synthetic",
    assetId: "source",
    quote: {
      currency: "USD",
      lowUsd: 0.1,
      expectedUsd: 0.1,
      highUsd: 0.1,
      bounded: true,
      source: "Explicit local fixture, no provider",
      asOf: "2026-11-16",
      confidence: "published-rate",
    },
  });
  store.transitionJob(operationId, "submitting");
  store.transitionJob(operationId, "unknown");
  atomicJson(path.join(f.root, ".cache/campaign-production/runtime.json"), {
    version: 1,
    limits: { generation: 1, process: 2, render: 1, qa: 2 },
    records: {
      [`batch.${f.plan.planHash}.${task.id}`]: {
        state: "running",
        pid: 2147483647,
        token: "dead-owner",
        resource: "generation",
        resourceKey: "fal",
        operationId,
        inputHash: taskInputHash(f.root, f.plan, task),
        attempts: 2,
      },
    },
  });
  const seen: string[] = [];
  const result = await runCampaignQueue(
    f.root,
    f.plan,
    async (task) => {
      if (task.kind === "material") {
        seen.push(String(task.payload.operationId));
        return { outputs: [], pending: true, retryAfterMs: 10000 };
      }
      const file = path.join(f.root, task.id + ".txt");
      writeFileSync(file, "Local fixture");
      return { outputs: [file] };
    },
    { maxTasks: 2 },
  );
  assert.deepEqual(seen, [operationId]);
  assert.equal(result.tasks.find((task) => task.id === "material-other")?.state, "capacity");
  assert.equal(store.snapshot().jobs[operationId].state, "unknown");
});
