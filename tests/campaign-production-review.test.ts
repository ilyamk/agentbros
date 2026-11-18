import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectConfigSchema } from "../src/types/video";
import { initCampaign } from "../src/lib/campaigns/production/store";
import { startCampaignReviewServer } from "../src/lib/campaigns/production/review-ui";
import { runCampaignQueue } from "../src/lib/campaigns/production/queue";
import { campaignInputIdentity } from "../src/lib/campaigns/production/execute";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "public/projects/item");
  mkdirSync(directory, { recursive: true });
  const project = ProjectConfigSchema.parse({
    name: "Transport fixture",
    productName: "Synthetic item",
    colors: {},
    musicVolume: 0,
    scenes: [{ id: "hook", text: "", durationInFrames: 30, visualType: "title" }],
  });
  writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
  const plan = initCampaign(
    {
      version: 1,
      id: "batch",
      revision: 1,
      scenario: "ad-experiments",
      brief: "HTTP transport fixture only, not renderer or creative acceptance",
      members: [
        {
          id: "item",
          projectId: "item",
          language: "en",
          factors: { hook: "diagnostic" },
          adapter: { kind: "existing", projectId: "item" },
        },
      ],
    },
    root,
  );
  const file = path.join(root, "clip.mp4");
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:r=30:d=1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(encoded.status, 0, encoded.stderr);
  await runCampaignQueue(
    root,
    plan,
    async (task) => {
      const output = path.join(root, `${task.id}.json`);
      writeFileSync(output, '{"transportFixtureOnly":true}');
      return { outputs: task.kind === "render" ? [file] : [output], metadata: { fixtureOnly: true } };
    },
    { identity: campaignInputIdentity },
  );
  const app = await startCampaignReviewServer({ projectId: "batch", rootDir: root });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  });
  return { ...app, root, plan, file, headers: { "x-review-token": new URL(app.url).hash.slice(1) } };
}
test("campaign review authenticates, streams byte ranges, rejects stale drafts and hides stale outputs", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/api/state`)).status, 403);
  const response = await fetch(`${f.origin}/api/state`, { headers: f.headers }),
    state = (await response.json()) as {
      planHash: string;
      selection: { revision: number };
      members: { outputs: { path: string }[] }[];
    };
  assert.equal(state.members[0].outputs[0].path, "clip.mp4");
  const part = await fetch(`${f.origin}/file?path=clip.mp4`, { headers: { ...f.headers, range: "bytes=2-9" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), readFileSync(f.file).subarray(2, 10));
  assert.equal(
    (await fetch(`${f.origin}/file?path=clip.mp4`, { headers: { ...f.headers, range: "bytes=999999999-" } })).status,
    416,
  );
  assert.equal((await fetch(`${f.origin}/file?path=../package.json`, { headers: f.headers })).status, 400);
  const body = {
    planHash: state.planHash,
    expectedRevision: 0,
    memberId: "item",
    choice: "fix",
    note: "Fixture request for a new opening",
    outputs: state.members[0].outputs,
  };
  const save = (origin: string) =>
    fetch(`${f.origin}/api/selection`, {
      method: "POST",
      headers: { ...f.headers, origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await save("https://example.invalid")).status, 403);
  assert.equal((await save(f.origin)).status, 200);
  assert.equal((await save(f.origin)).status, 409);
  writeFileSync(f.file, "tampered");
  const after = (await (await fetch(`${f.origin}/api/state`, { headers: f.headers })).json()) as typeof state;
  assert.equal(after.members[0].outputs.length, 0);
  await runCampaignQueue(
    f.root,
    f.plan,
    async (task) => ({
      outputs: task.kind === "render" ? [f.file] : [path.join(f.root, `${task.id}.json`)],
      metadata: { fixtureOnly: true },
    }),
    { identity: campaignInputIdentity },
  );
  const stale = await fetch(`${f.origin}/api/selection`, {
    method: "POST",
    headers: { ...f.headers, origin: f.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, expectedRevision: 1 }),
  });
  assert.equal(stale.status, 409, "Unseen same-plan output changes cannot inherit a displayed verdict");
});
// The browser flow (filter, play, save an exact selection, 409) is the console's campaign view (RU-CP01–06, WP13e):
// apps/console/e2e/campaign.e2e.ts.
