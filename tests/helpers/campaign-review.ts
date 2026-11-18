/**
 * A campaign container fixture for the console campaign review suites (RFC 0004 WP13e): campaign `batch` with one
 * member (`item`) whose render task is complete with a pinned `clip.mp4` of random bytes (the routes never probe
 * content). No ffmpeg, no provider.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { campaignInputIdentity } from "../../src/lib/campaigns/production/execute";
import { runCampaignQueue } from "../../src/lib/campaigns/production/queue";
import { initCampaign } from "../../src/lib/campaigns/production/store";
import { ProjectConfigSchema } from "../../src/types/video";

export const CAMPAIGN = "batch";

export async function makeCampaign(root: string) {
  const directory = path.join(root, "public/projects/item");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "project.json"),
    JSON.stringify(
      ProjectConfigSchema.parse({
        name: "Transport fixture",
        productName: "Synthetic item",
        colors: {},
        musicVolume: 0,
        scenes: [{ id: "hook", text: "", durationInFrames: 30, visualType: "title" }],
      }),
    ),
  );
  const plan = initCampaign(
    {
      version: 1,
      id: CAMPAIGN,
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
  writeFileSync(file, randomBytes(4096));
  /** Runs the queue: every task completes; the render task outputs `clip.mp4` as it is now. */
  const run = () =>
    runCampaignQueue(
      root,
      plan,
      async (task) => {
        const output = path.join(root, `${task.id}.json`);
        writeFileSync(output, '{"transportFixtureOnly":true}');
        return { outputs: task.kind === "render" ? [file] : [output], metadata: { fixtureOnly: true } };
      },
      { identity: campaignInputIdentity },
    );
  await run();
  return { plan, file, run };
}
