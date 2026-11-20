/**
 * The console's generations section (2026-11-20): paid model jobs from the job store with their provider error, money
 * and published result, the latest model preparation, and a `project:new` template that only holds generations.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectViewSchema } from "../src/types/console";
import { buildProjectView } from "../src/lib/console/view/build";
import { projectSummary } from "../src/lib/console/view/summary";
import { projectPaths } from "../src/lib/console/view/files";
import { OperationStore } from "../src/lib/jobs/store";
import { runGenerationStep, type JobProvider } from "../src/lib/jobs/runner";
import { USER_GRANT } from "./helpers/ceiling-grant";

const PROJECT = "swap-demo";
const NOW = Date.parse("2026-11-20T12:00:00Z");

const quote = (expectedUsd: number) => ({
  currency: "USD" as const,
  lowUsd: expectedUsd,
  expectedUsd,
  highUsd: expectedUsd,
  bounded: true as const,
  confidence: "published-rate" as const,
  source: "test rate card",
  asOf: "2026-11-20",
});

function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-generations-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects", PROJECT);
  for (const sub of ["pipeline", "music", "voiceover", "assets/imported"])
    mkdirSync(path.join(dir, sub), { recursive: true });
  // What project:new writes: a template project.json, no music, no voiceover, no code, no render.
  writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({
      name: "Swap Demo",
      formats: ["vertical"],
      scenes: [{ id: "hook", text: "Your hook voiceover text here." }],
    }),
  );
  return { root, dir };
}

function provider(outcome: "running" | "failed" | "completed"): JobProvider {
  return {
    // Higgsfield persists the exact request body before submit, which is where the prompt is read from.
    idempotentSubmit: true,
    submit: async () => ({ requestId: `req-${outcome}` }),
    inspect: async () =>
      outcome === "running"
        ? { state: "running" }
        : outcome === "failed"
          ? { state: "failed", message: "rejected by content moderation (nsfw)", refunded: true }
          : { state: "completed", result: { video: { url: "https://example.invalid/out.mp4" } } },
  };
}

async function threeJobs(dir: string) {
  const store = new OperationStore(PROJECT, { directory: path.join(dir, "pipeline") });
  store.configure({ ceilingUsd: 9, maxJobUsd: 8, repairReserveFraction: 0 }, USER_GRANT);
  const operation = (id: string, usd: number, file: string) => ({
    operationId: id,
    provider: "higgsfield",
    endpoint: "higgsfield/genjutsu/object-swap/v1.0",
    assetId: file,
    stage: "assets",
    quote: quote(usd),
    publication: {
      output: path.join(dir, "assets", file),
      kind: "video" as const,
      model: "higgsfield/genjutsu/object-swap/v1.0",
      referenceAssetIds: ["sha256:" + "a".repeat(64)],
    },
  });
  await runGenerationStep({
    store,
    operation: operation("hf:failed", 7.5, "failed.mp4"),
    input: { prompt: "Swap the face", video_url: "https://signed.example.invalid/secret.mp4" },
    provider: provider("failed"),
  });
  await runGenerationStep({
    store,
    operation: operation("hf:published", 2.2, "published.mp4"),
    input: { prompt: "Replace the man's face", resolution: "720p" },
    provider: provider("completed"),
    publish: async () => {
      writeFileSync(path.join(dir, "assets/published.mp4"), "not really a video");
      return { outputs: ["assets/published.mp4"] };
    },
  });
  await runGenerationStep({
    store,
    operation: operation("hf:running", 1.5, "running.mp4"),
    input: { prompt: "Part two" },
    provider: provider("running"),
  });
  return store;
}

function registerReference(dir: string) {
  const hash = "a".repeat(64);
  writeFileSync(path.join(dir, `assets/imported/${hash}.jpg`), "jpeg");
  writeFileSync(
    path.join(dir, "pipeline/asset-registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      assets: [
        {
          schemaVersion: 1,
          id: `sha256:${hash}`,
          hash,
          revision: 1,
          createdAt: "2026-11-20T10:42:52.631Z",
          kind: "image",
          files: { original: `projects/${PROJECT}/assets/imported/${hash}.jpg`, bytes: 4, mime: "image/jpeg" },
          media: { width: 960, height: 1280, codec: "mjpeg", hasAlpha: false, hasAudio: false },
          provenance: {
            origin: "manual",
            originalFilename: "photo.jpeg",
            tool: "unknown",
            model: "unknown",
            referenceAssetIds: [],
            billing: { status: "unknown" },
          },
          rights: { licence: "unknown", commercialAllowed: "unknown", attributionRequired: "unknown" },
          entityLinks: [],
          status: "candidate",
        },
      ],
    }),
  );
}

function preparation(dir: string, id: string, createdAt: string, approved: boolean) {
  const prep = path.join(dir, "pipeline/model-preparations", id);
  mkdirSync(prep, { recursive: true });
  writeFileSync(path.join(prep, "source-1.png"), "png");
  writeFileSync(path.join(prep, "board.html"), "<html></html>");
  writeFileSync(
    path.join(prep, "receipt.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      createdAt,
      endpoint: "higgsfield/genjutsu/object-swap/v1.0",
      spec: { id, mode: "object-swap", resolution: "720p" },
      references: [
        {
          entityId: "me",
          role: "front",
          media: { original: `projects/${PROJECT}/assets/imported/${"a".repeat(64)}.jpg` },
        },
      ],
      reviewFiles: [{ path: "source-1.png" }, { path: "board.html" }, { path: "../escape.png" }],
    }),
  );
  writeFileSync(
    path.join(prep, "request.json"),
    JSON.stringify({
      provider: "higgsfield",
      input: { prompt: `Prompt of ${id}`, image_urls: ["https://signed.example.invalid/ref.jpg"], resolution: "720p" },
    }),
  );
  if (approved) {
    writeFileSync(
      path.join(prep, "approval.json"),
      JSON.stringify({ approvedAt: "2026-11-20T10:47:07.904Z", userStatement: "Yes, approved" }),
    );
    writeFileSync(
      path.join(prep, "rights.json"),
      JSON.stringify({ status: "study-only", userStatement: "For me only" }),
    );
  }
}

const view = (root: string) => ProjectViewSchema.parse(buildProjectView(root, PROJECT, { now: NOW }));

test("one failed, one running and one published job: newest first, error, money and a result only when published", async (t) => {
  const { root, dir } = workspace(t);
  registerReference(dir);
  await threeJobs(dir);
  const v = view(root);
  const jobs = v.generations?.jobs ?? [];
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["hf:running", "hf:published", "hf:failed"],
  );
  const [running, published, failed] = jobs;
  assert.equal(failed!.state, "failed");
  assert.equal(failed!.error, "rejected by content moderation (nsfw)");
  assert.equal(failed!.noCharge, true);
  assert.equal(failed!.output, undefined, "a failed job never points at its planned file");
  assert.equal(failed!.outputPath, "assets/failed.mp4");
  assert.equal(published!.state, "published");
  assert.deepEqual(published!.output, { path: "assets/published.mp4", kind: "video", label: "published.mp4" });
  assert.equal(published!.reservedUsd, 2.2, "published without a receipt: still reserved, not settled");
  assert.equal(published!.costUsd, undefined);
  assert.equal(published!.prompt, "Replace the man's face");
  assert.equal(published!.resolution, "720p");
  assert.deepEqual(
    published!.references?.map((ref) => [ref.path, ref.label]),
    [[`assets/imported/${"a".repeat(64)}.jpg`, "photo.jpeg"]],
    "a hash-named reference is labelled with the user's original filename",
  );
  assert.equal(running!.state, "running");
  assert.equal(running!.output, undefined);
  assert.ok(running!.submittedAt);
  // Signed provider URLs never reach the view.
  assert.ok(!JSON.stringify(v).includes("signed.example.invalid"));
  assert.equal(v.money.reservedUsd, 3.7);
  assert.equal(v.money.spentUsd, 0);
  const summary = projectSummary(v, projectPaths(root, PROJECT));
  assert.equal(summary.reservedUsd, 3.7, "the home card carries the reservation beside spent");
});

test("a template project with only generations: no current render step, steps not started", async (t) => {
  const { root, dir } = workspace(t);
  await threeJobs(dir);
  const v = view(root);
  assert.equal(v.project.route, "timeline");
  assert.equal(v.generations?.templateOnly, true);
  assert.equal(v.current, undefined, "the template render is not the current step");
  assert.ok(v.steps.every((step) => step.status === "pending"));
  assert.match(v.steps[0]!.reasons[0]!, /template/);

  // Route material (a voiceover) makes it a timeline project again.
  writeFileSync(path.join(dir, "voiceover/hook.mp3"), "mp3");
  const again = view(root);
  assert.equal(again.generations?.templateOnly, undefined);
  assert.equal(again.current?.step, "render");
});

test("a template project without generations keeps its render step and no generations section", (t) => {
  const { root } = workspace(t);
  const v = view(root);
  assert.equal(v.generations, undefined);
  assert.equal(v.current?.step, "render");
});

test("the latest preparation: prompt, references, board images (no HTML), approval and rights", (t) => {
  const { root, dir } = workspace(t);
  registerReference(dir);
  preparation(dir, "face-v1", "2026-11-20T10:00:00Z", false);
  preparation(dir, "face-v2", "2026-11-20T10:46:27Z", true);
  const prep = view(root).generations?.preparation;
  assert.ok(prep);
  assert.equal(prep.id, "face-v2");
  assert.equal(prep.count, 2);
  assert.equal(prep.prompt, "Prompt of face-v2");
  assert.equal(prep.resolution, "720p");
  assert.equal(prep.mode, "object-swap");
  assert.deepEqual(
    prep.references.map((ref) => [ref.path, ref.label]),
    [[`assets/imported/${"a".repeat(64)}.jpg`, "me · front"]],
  );
  assert.deepEqual(
    prep.board.map((ref) => ref.path),
    ["pipeline/model-preparations/face-v2/source-1.png"],
  );
  assert.deepEqual(prep.approval, { at: "2026-11-20T10:47:07.904Z", userStatement: "Yes, approved" });
  assert.deepEqual(prep.rights, { status: "study-only", userStatement: "For me only" });
});

test("corrupt preparation files degrade without breaking the view", (t) => {
  const { root, dir } = workspace(t);
  const prep = path.join(dir, "pipeline/model-preparations/broken");
  mkdirSync(prep, { recursive: true });
  writeFileSync(path.join(prep, "receipt.json"), "{ torn");
  writeFileSync(path.join(prep, "request.json"), "[]");
  const v = view(root);
  assert.equal(v.generations?.preparation?.id, "broken");
  assert.deepEqual(v.generations?.preparation?.references, []);
});

function asset(dir: string, bytes: string, ext: string, kind: "video" | "image", provenance: Record<string, unknown>) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(path.join(dir, `assets/imported/${hash}.${ext}`), bytes);
  return {
    schemaVersion: 1,
    id: `sha256:${hash}`,
    hash,
    revision: 1,
    createdAt: "2026-11-20T10:42:52.631Z",
    kind,
    files: {
      original: `projects/${PROJECT}/assets/imported/${hash}.${ext}`,
      bytes: bytes.length,
      mime: kind === "video" ? "video/mp4" : "image/jpeg",
    },
    media:
      kind === "video"
        ? { width: 720, height: 1280, durationSec: 5, codec: "h264", hasAlpha: false, hasAudio: true }
        : { width: 960, height: 1280, codec: "mjpeg", hasAlpha: false, hasAudio: false },
    provenance: {
      tool: "unknown",
      model: "unknown",
      referenceAssetIds: [],
      billing: { status: "unknown" },
      ...provenance,
    },
    rights: { licence: "unknown", commercialAllowed: "unknown", attributionRequired: "unknown" },
    entityLinks: [],
    status: "candidate",
  };
}

test("media albums: sources, a prepared clip with its source, job outputs only on their card, unregistered files", async (t) => {
  const { root, dir } = workspace(t);
  mkdirSync(path.join(dir, "footage"), { recursive: true });
  const source = asset(dir, "source video", "mp4", "video", { origin: "manual", originalFilename: "stark.mp4" });
  const prepared = asset(dir, "prepared video", "mp4", "video", { origin: "manual", tool: "model:prepare" });
  const face = asset(dir, "face", "jpg", "image", { origin: "manual", originalFilename: "IMG_1.jpeg" });
  writeFileSync(
    path.join(dir, "pipeline/asset-registry.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, assets: [source, prepared, face] }),
  );
  // The user's file the source was imported from: the same bytes, so an alias of the registered source.
  writeFileSync(path.join(dir, "footage/stark.mp4"), "source video");
  writeFileSync(path.join(dir, "assets/stray.mp4"), "nobody registered me");
  const prep = path.join(dir, "pipeline/model-preparations/face-v2");
  mkdirSync(prep, { recursive: true });
  writeFileSync(
    path.join(prep, "receipt.json"),
    JSON.stringify({
      id: "face-v2",
      createdAt: "2026-11-20T10:46:27Z",
      source: { assetId: source.id, original: source.files.original },
      preparedSource: { assetId: prepared.id, original: prepared.files.original },
    }),
  );
  await threeJobs(dir);

  const built = view(root);
  assert.deepEqual(
    built.advisories.filter((advisory) => advisory.startsWith("gallery")),
    [],
  );
  const items = built.gallery?.items ?? [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const original = byId.get(source.id);
  assert.equal(original?.album, "sources");
  assert.equal(original?.registered, true);
  assert.equal(original?.media.label, "stark.mp4");
  assert.deepEqual(original?.aliases, ["footage/stark.mp4"], "the footage copy is an alias, not a second item");
  const clip = byId.get(prepared.id);
  assert.equal(clip?.album, "preparation");
  assert.equal(clip?.preparation, "face-v2");
  assert.equal(clip?.media.label, "face-v2 · prepared");
  assert.equal(clip?.parent?.path, source.files.original.replace(`projects/${PROJECT}/`, ""));
  assert.equal(byId.get(face.id)?.album, "sources");
  assert.equal(byId.get(face.id)?.media.label, "IMG_1.jpeg");
  const stray = byId.get("file:assets/stray.mp4");
  assert.equal(stray?.album, "unregistered");
  assert.equal(stray?.registered, false);
  // The published job output is on its job card in the Generations album, never a second item.
  assert.ok(!items.some((item) => item.media.path === "assets/published.mp4"));
  assert.deepEqual(
    [...new Set(items.map((item) => item.album))],
    ["sources", "preparation", "unregistered"],
    "albums in lineage order",
  );
});

test("a project without media files has no gallery section", (t) => {
  const { root } = workspace(t);
  assert.equal(view(root).gallery, undefined);
});
