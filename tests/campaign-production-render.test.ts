import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectConfigSchema } from "../src/types/video";
import { initCampaign, loadCampaign } from "../src/lib/campaigns/production/store";
import { pinFile } from "../src/lib/campaigns/production/files";
import { approveCampaignPackage, reviewPackage } from "../src/lib/campaigns/production/review";
import { campaignStatus, recordCampaignDecision, runCampaign } from "../src/lib/campaigns/production/service";
import { campaignInputIdentity } from "../src/lib/campaigns/production/execute";
import { taskInputHash } from "../src/lib/campaigns/production/queue";
import { importResource } from "../src/lib/font-resources/registry";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { createFontManifest, FONT_ROLES, type FontSelection } from "../src/lib/font-resources/manifest";
import { mediaProbe } from "../src/lib/audio/analysis";
import { startCampaignReviewServer } from "../src/lib/campaigns/production/review-ui";

test(
  "physical catalogue campaign: actual Full HD renders, source-bound QA, exact reviews and reuse",
  { skip: process.env.RUN_CAMPAIGN_RENDER_TESTS !== "1", timeout: 7_200_000 },
  async (t) => {
    const count = Number(process.env.CAMPAIGN_RENDER_COUNT ?? 100);
    assert.ok(Number.isInteger(count) && count > 0 && count <= 100);
    const resume = process.env.CAMPAIGN_RENDER_RESUME_ROOT;
    const root = resume ? realpathSync(resume) : realpathSync(mkdtempSync(path.join(tmpdir(), "campaign-physical-"))),
      codeRoot = process.cwd();
    assert.ok(
      root.startsWith(realpathSync(tmpdir()) + path.sep) && path.basename(root).startsWith("campaign-physical-"),
      "Physical acceptance owns only its isolated temporary workspace",
    );
    const retained = process.env.CAMPAIGN_ARTIFACTS_DIR ? path.resolve(process.env.CAMPAIGN_ARTIFACTS_DIR) : undefined;
    t.after(() => {
      if (retained) {
        mkdirSync(retained, { recursive: true });
        cpSync(root, path.join(retained, "workspace"), {
          recursive: true,
          filter: (source) => !source.includes("/node_modules") && !source.includes("/.cache/webpack"),
        });
      }
      rmSync(root, { recursive: true, force: true });
    });
    if (!resume) {
      cpSync(path.join(codeRoot, "src"), path.join(root, "src"), { recursive: true });
      for (const file of ["package.json", "pnpm-lock.yaml", "remotion.config.ts", "tsconfig.json"])
        copyFileSync(path.join(codeRoot, file), path.join(root, file));
      symlinkSync(realpathSync(path.join(codeRoot, "node_modules")), path.join(root, "node_modules"), "dir");
      writeFileSync(path.join(root, ".npmrc"), "verifyDepsBeforeRun=false\n");
      const rows: { sku: string; name: string; font: string; fontSha: string }[] = [];
      for (let index = 1; index <= count; index++) {
        const sku = `sku${String(index).padStart(3, "0")}`,
          id = `catalogue-${sku}`,
          directory = path.join(root, "public/projects", id);
        mkdirSync(directory, { recursive: true });
        const project = ProjectConfigSchema.parse({
          name: `Synthetic ${sku}`,
          productName: `SKU ${index}`,
          formats: ["vertical"],
          colors: { background: "#102030", accent: "#19AABB", text: "#FFFFFF" },
          musicVolume: 0,
          voiceoverEnabled: false,
          scenes: [
            {
              id: "hook",
              text: "",
              headline: `SKU ${index}`,
              visualType: "title",
              durationInFrames: 90,
              transitionToNext: "cut",
            },
          ],
        });
        writeFileSync(path.join(directory, "project.json"), JSON.stringify(project, null, 2) + "\n");
        const originals = [
          process.env.CAMPAIGN_FONT_REGULAR ?? "/System/Library/Fonts/Supplemental/Arial.ttf",
          process.env.CAMPAIGN_FONT_BOLD ?? "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        ];
        const faces = originals.map((original) => {
          assert.ok(existsSync(original), "Installed fixture fonts are required; no font download is permitted");
          const face = inspectSfnt(readFileSync(original));
          importResource(
            id,
            original,
            {
              kind: "font",
              family: face.family,
              style: face.style as "normal",
              weight: face.weight,
              subset: "local-test",
              requiredText: `SKU ${index}`,
              source: "Installed synthetic campaign fixture",
              licence: "test-only",
              licenceText: "No redistribution or production licence asserted",
              licenceEvidence: "Local installation",
              attribution: "Fixture",
              checkedAt: "2026-11-16T00:00:00Z",
            },
            root,
          );
          return face;
        });
        const selection: FontSelection = {
          family: faces[0].family,
          style: "normal",
          weights: faces.map((face) => face.weight),
          subset: "local-test",
          requiredText: `SKU ${index}`,
        };
        const context = path.join(directory, "fonts.json");
        writeFileSync(
          context,
          JSON.stringify(
            createFontManifest(
              id,
              Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
                (typeof FONT_ROLES)[number],
                FontSelection
              >,
              root,
            ),
          ),
        );
        const font = pinFile(root, context);
        rows.push({ sku, name: `SKU ${index}`, font: font.path, fontSha: font.sha256 });
      }
      const catalogue = path.join(root, "catalogue.json");
      writeFileSync(catalogue, JSON.stringify(rows));
      initCampaign(
        {
          version: 1,
          id: "catalogue",
          revision: 1,
          scenario: "catalogue-videos",
          brief:
            "Synthetic infrastructure acceptance. These are diagnostic product identifiers, not real products, claims or business performance.",
          catalogue: {
            file: pinFile(root, catalogue),
            format: "json",
            idColumn: "sku",
            columns: { name: "name", font: "font", fontSha: "fontSha" },
            memberTemplate: {
              id: "{{id}}",
              projectId: "catalogue-{{id}}",
              language: "en",
              fontContext: { path: "{{font}}", sha256: "{{fontSha}}" },
              adapter: { kind: "existing", projectId: "catalogue-{{id}}" },
            },
          },
        },
        root,
      );
    }
    const plan = loadCampaign(root, "catalogue");
    assert.equal(plan.members.length, count);
    const { pack } = reviewPackage(root, plan, "creative-plan");
    await approveCampaignPackage(
      root,
      plan,
      pack,
      pack.packageHash,
      "Fixture-only exact plan approval; no real human creative acceptance",
      "synthetic fixture",
    );
    const run = await runCampaign(root, "catalogue");
    const failed = run.tasks.filter((task) => task.state === "failed");
    assert.deepEqual(failed, [], JSON.stringify(failed));
    const frames = new Set<string>();
    for (const member of plan.members) {
      const output = path.join(root, "out", member.projectId, "vertical-clean.mp4"),
        probe = mediaProbe(output),
        video = probe.streams.find((stream) => stream.codec_type === "video")!;
      const decoded = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          "1.5",
          "-i",
          output,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-f",
          "framemd5",
          "-hash",
          "sha256",
          "-",
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(decoded.status, 0, decoded.stderr);
      const frame = decoded.stdout
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .at(-1)
        ?.split(",")
        .at(-1)
        ?.trim();
      assert.ok(frame);
      frames.add(frame);
      assert.equal(video.width, 1080);
      assert.equal(video.height, 1920);
      assert.equal(video.avg_frame_rate, "30/1");
      assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.04);
      const task = plan.tasks.find((task) => task.id === `critique-${member.id}`)!,
        report = path.join(root, "public/projects", member.projectId, "pipeline/campaign-critique.json");
      writeFileSync(
        report,
        JSON.stringify({
          fixture: true,
          statement: "Protocol fixture only; no independent model or human creative judgement is asserted",
          output: pinFile(root, output),
        }),
      );
      const pin = pinFile(root, report);
      recordCampaignDecision(root, "catalogue", {
        version: 1,
        taskId: task.id,
        planHash: plan.planHash,
        inputHash: taskInputHash(root, plan, task, campaignInputIdentity),
        agent: "creative-critic",
        verdict: "accept",
        rationale: "Explicitly labelled deterministic fixture result",
        evidence: [pinFile(root, output)],
        outputs: [pin],
      });
    }
    assert.equal(frames.size, count, "Every catalogue member has a distinct decoded middle frame");
    await runCampaign(root, "catalogue");
    const before = campaignStatus(root, "catalogue");
    assert.equal(before.complete, true);
    assert.equal(before.productionReady, false);
    const reuse = await runCampaign(root, "catalogue");
    assert.equal(reuse.attempted, 0);
    assert.equal(before.costs.actualUsd, 0);
    const final = reviewPackage(root, loadCampaign(root, "catalogue"), "final-outputs");
    assert.equal(final.pack.members.length, count);
    const app = await startCampaignReviewServer({ rootDir: root, projectId: "catalogue" });
    try {
      const token = new URL(app.url).hash.slice(1),
        headers = { "x-review-token": token };
      assert.equal((await fetch(`${app.origin}/api/state`)).status, 403);
      const response = await fetch(`${app.origin}/api/state`, { headers });
      assert.equal(response.status, 200);
      const state = (await response.json()) as { members: unknown[] };
      assert.equal(state.members.length, count);
      assert.equal((await fetch(`${app.origin}/file?path=package.json`, { headers })).status, 400);
    } finally {
      await new Promise<void>((resolve) => {
        app.server.close(() => resolve());
        app.server.closeAllConnections();
      });
    }
    t.diagnostic(
      JSON.stringify({
        count,
        width: 1080,
        height: 1920,
        fps: 30,
        mediaSpendUsd: 0,
        reusedTasks: before.tasks.length,
        liveModelQuality: "unverified",
        productionReady: false,
      }),
    );
  },
);
