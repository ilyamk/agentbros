import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  CampaignProductionRequestSchema,
  type CampaignProductionRequest,
  type CampaignMember,
} from "../src/types/campaign-production";
import { ProjectConfigSchema } from "../src/types/video";
import { loadCampaign } from "../src/lib/campaigns/production/store";
import { pinFile, jsonFile } from "../src/lib/campaigns/production/files";
import { importResource } from "../src/lib/font-resources/registry";
import { createFontManifest, FONT_ROLES, type FontSelection } from "../src/lib/font-resources/manifest";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { saveEntityVersion, approveEntityVersion } from "../src/lib/entities/service";

const enabled = process.env.RUN_CAMPAIGN_FLOW_TESTS === "1";
const scenarios = [
  "ad-experiments",
  "catalogue-videos",
  "reference-family",
  "localise-campaign",
  "content-series",
] as const;
for (const scenario of scenarios)
  test(
    `public CLI business flow: ${scenario}, critique, repair, pilot and strict delivery`,
    {
      skip:
        !enabled ||
        Boolean(
          process.env.CAMPAIGN_FLOW_SCENARIO && !process.env.CAMPAIGN_FLOW_SCENARIO.split(",").includes(scenario),
        ),
      timeout: 900000,
    },
    async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), "campaign-business-")),
        staging = mkdtempSync(path.join(tmpdir(), "campaign-fonts-")),
        code = process.cwd();
      t.after(() => {
        if (process.env.CAMPAIGN_FLOW_ARTIFACTS) {
          const target = path.join(process.env.CAMPAIGN_FLOW_ARTIFACTS, scenario);
          mkdirSync(target, { recursive: true });
          cpSync(root, target, {
            recursive: true,
            filter: (source) => !source.includes("/node_modules") && !source.includes("/.cache/webpack"),
          });
        }
        rmSync(root, { recursive: true, force: true });
        rmSync(staging, { recursive: true, force: true });
      });
      cpSync(path.join(code, "src"), path.join(root, "src"), { recursive: true });
      cpSync(path.join(code, ".agents"), path.join(root, ".agents"), { recursive: true });
      for (const file of ["package.json", "pnpm-lock.yaml", "remotion.config.ts", "tsconfig.json"])
        copyFileSync(path.join(code, file), path.join(root, file));
      symlinkSync(path.join(code, "node_modules"), path.join(root, "node_modules"), "dir");
      mkdirSync(path.join(root, "public/projects"), { recursive: true });
      const put = (file: string, value: unknown) => {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
        return file;
      };
      const calls: string[] = [];
      const cli = (script: string, args: string[] = [], success = true) => {
        calls.push(script + " " + args.join(" "));
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            createRequire(import.meta.url).resolve("tsx"),
            path.join(code, "scripts", script),
            "--project",
            "batch",
            ...args,
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 240000,
            maxBuffer: 8 * 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: tmpdir(),
              AGENTBROS_MEMORY_ROOT: path.join(root, "memory"),
              npm_config_verify_deps_before_run: "false",
              NODE_OPTIONS: "--max-old-space-size=8192",
            },
          },
        );
        assert.equal(result.error, undefined, String(result.error));
        assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout.slice(-2000));
        const value = JSON.parse(result.stdout);
        if (!value.ok || value.metadata?.blockers?.some((blocker: { state: string }) => blocker.state === "failed"))
          put("last-cli-failure.json", { script, args, value, stderr: result.stderr.slice(-4000) });
        assert.equal(value.ok, success, JSON.stringify(value).slice(0, 3000) + result.stderr.slice(-2000));
        assert.equal(result.status, success ? 0 : 1);
        return value;
      };
      const fontSources = [
        process.env.CAMPAIGN_FONT_REGULAR ?? "/System/Library/Fonts/Supplemental/Arial.ttf",
        process.env.CAMPAIGN_FONT_BOLD ?? "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
      ];
      const count = ["ad-experiments", "catalogue-videos", "content-series"].includes(scenario) ? 2 : 1;
      const members: CampaignProductionRequest["members"] = [],
        materials: NonNullable<CampaignProductionRequest["materials"]> = [];
      const imageHashes = new Map<string, string>();
      const facts = put("facts.json", {
        product: "Product",
        prices: { "item-1": "10 EUR", "item-2": "20 EUR" },
        items: { SKU1: "SKU1", SKU2: "SKU2", "item-1": "item-1", "item-2": "item-2" },
        source: "Synthetic test facts; no commercial claims",
      });
      for (let index = 1; index <= count; index++) {
        const id = `item-${index}`,
          headline =
            scenario === "ad-experiments"
              ? `Product hook${index}`
              : scenario === "catalogue-videos"
                ? `Product item-${index}`
                : `Product SKU${index}`,
          stage = path.join(staging, "public/projects", id);
        mkdirSync(stage, { recursive: true });
        writeFileSync(path.join(stage, "project.json"), "{}");
        const faces = fontSources.map((original) => {
          assert.ok(existsSync(original), "Installed fonts required; downloads forbidden");
          const face = inspectSfnt(readFileSync(original));
          importResource(
            id,
            original,
            {
              kind: "font",
              family: face.family,
              style: face.style as "normal",
              weight: face.weight,
              subset: "fixture",
              requiredText: "Product SKU123 hook Bonjour Produit Hello",
              source: "Installed font in isolated test",
              licence: "test-only",
              licenceText: "Test-only installed resource; no redistribution claim",
              licenceEvidence: "Local installation",
              attribution: "Fixture",
              checkedAt: "2026-11-16T00:00:00Z",
            },
            staging,
          );
          return face;
        });
        const selection: FontSelection = {
          family: faces[0].family,
          style: "normal",
          weights: faces.map((face) => face.weight),
          subset: "fixture",
          requiredText: "Product SKU123 hook Bonjour Produit Hello",
        };
        const fontContext = pinFile(
          root,
          put(
            `fonts-${id}.json`,
            createFontManifest(
              id,
              Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
                (typeof FONT_ROLES)[number],
                FontSelection
              >,
              staging,
            ),
          ),
        );
        const project = ProjectConfigSchema.parse({
          name: headline,
          productName: "Product",
          colors: { accent: "#19AABB", background: "#102030", text: "#FFFFFF" },
          formats: ["vertical"],
          musicVolume: 0,
          scenes: [
            {
              id: "hook",
              text: scenario === "content-series" ? (index === 1 ? "First lesson" : "Second lesson") : "Hello",
              headline,
              visualType: "title",
              durationInFrames: 30,
              transitionToNext: "cut",
            },
          ],
        });
        const member: NonNullable<CampaignProductionRequest["members"]>[number] = {
          id,
          projectId: id,
          language: "en",
          productId: scenario === "ad-experiments" ? "SKU1" : scenario === "catalogue-videos" ? id : `SKU${index}`,
          hypothesis: "Changing the declared hook tests attention",
          factors: { hook: `hook-${index}` },
          scheduledFor: `2026-12-0${index}`,
          adapter: { kind: "template", project },
          fontContext,
          assurance: {
            facts: [
              { key: "name", value: "Product", jsonPointer: "/product", source: pinFile(root, facts) },
              ...(scenario === "catalogue-videos"
                ? [{ key: "productId", value: id, jsonPointer: `/items/${id}`, source: pinFile(root, facts) }]
                : []),
            ],
            requiredText: [headline],
            referenceSlots: [{ slotId: "hook", sceneId: "hook" }],
          },
          delivery: {
            version: 1,
            projectId: id,
            formats: ["vertical"],
            variants: ["clean"],
            commercial: false,
            placements: ["internal-test"],
            approvalMode: "manual",
            rightsReviews: createFontManifest(
              id,
              Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
                (typeof FONT_ROLES)[number],
                FontSelection
              >,
              staging,
            )
              .faces.filter((face, index, all) => all.findIndex((other) => other.hash === face.hash) === index)
              .map((face) => ({
                reviewedBy: "Fixture rights reviewer",
                reviewedAt: "2026-11-16T00:00:00Z",
                evidence:
                  "Explicit private installed-font test declaration; no commercial or redistribution permission claimed",
                sha256: face.hash,
                licence: "installed-local-test-only",
                sourceUrl: "manual:installed-test-font",
                commercialAllowed: false,
                modifiedAllowed: true,
                placements: ["internal-test"],
                attribution: "Installed font, test only",
              })),
            loudness: { targetLufs: -21, toleranceLu: 5, maxTruePeakDb: 0, audioRequired: false },
          },
        };
        if (scenario === "catalogue-videos") {
          const image = path.join(root, `product-${id}.png`),
            made = spawnSync(
              "ffmpeg",
              [
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                `color=c=${index === 1 ? "red" : "blue"}:s=48x32`,
                "-frames:v",
                "1",
                image,
              ],
              { encoding: "utf8" },
            );
          assert.equal(made.status, 0, made.stderr);
          const source = pinFile(root, image);
          imageHashes.set(id, source.sha256);
          materials.push({
            id: `product-${id}`,
            owner: "shared",
            source: {
              kind: "supplied",
              file: source,
              provenance: { origin: "manual", tool: "ffmpeg-local-fixture" },
              rights: { licence: "local-test-plate", commercialAllowed: false, attributionRequired: false },
            },
          });
          member.materials = [`product-${id}`];
          project.scenes[0].visualType = "photo";
          project.scenes[0].imageUrl = `material://product-${id}`;
          project.scenes[0].subtext = `${index * 10} EUR`;
          member.assurance!.facts!.push({
            key: "price",
            value: `${index * 10} EUR`,
            source: pinFile(root, facts),
            jsonPointer: `/prices/${id}`,
          });
          member.delivery!.rightsReviews!.push({
            reviewedBy: "Fixture rights reviewer",
            reviewedAt: "2026-11-16T00:00:00Z",
            evidence: "Locally generated diagnostic colour plate; no real product likeness asserted",
            sha256: source.sha256,
            licence: "local-test-plate",
            sourceUrl: "manual:ffmpeg-color-fixture",
            commercialAllowed: false,
            modifiedAllowed: true,
            placements: ["internal-test"],
            attribution: "Synthetic fixture",
          });
        }
        const audio = path.join(root, `speech-${id}.mp3`);
        const generated = spawnSync(
          "ffmpeg",
          ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.1", "-c:a", "libmp3lame", audio],
          { encoding: "utf8" },
        );
        assert.equal(generated.status, 0, generated.stderr);
        const alignment = put(
          `alignment-${id}.json`,
          (scenario === "localise-campaign" ? "Bonjour" : project.scenes[0].text)
            .split(" ")
            .map((text, word) => ({ text, start: word * 0.4, end: word * 0.4 + 0.3 })),
        );
        member.speech = [{ sceneId: "hook", audio: pinFile(root, audio), alignment: pinFile(root, alignment) }];
        member.delivery!.rightsReviews = [
          ...(member.delivery!.rightsReviews ?? []),
          {
            reviewedBy: "Fixture rights reviewer",
            reviewedAt: "2026-11-16T00:00:00Z",
            evidence: "Locally generated diagnostic sine tone, not speech or music quality evidence",
            sha256: pinFile(root, audio).sha256,
            licence: "local-test-tone",
            sourceUrl: "manual:ffmpeg-sine-fixture",
            commercialAllowed: false,
            modifiedAllowed: true,
            placements: ["internal-test"],
            attribution: "Synthetic fixture",
          },
        ];
        if (scenario === "localise-campaign") {
          const source = path.join(root, "public/projects/source");
          mkdirSync(source);
          writeFileSync(path.join(source, "project.json"), JSON.stringify(project));
          member.language = "fr";
          member.adapter = {
            kind: "localise",
            translation: {
              version: 1,
              sourceProjectId: "source",
              sourceLanguage: "en",
              targetLanguage: "fr",
              projectId: id,
              voice: "supplied-tone-fixture",
              source: "Synthetic translation fixture, not linguistic acceptance",
              wordsPerSecond: 2,
              scenes: [{ id: "hook", text: "Bonjour", headline }],
            },
          };
          member.speech = [{ sceneId: "hook", audio: pinFile(root, audio), alignment: pinFile(root, alignment) }];
        }
        members.push(member);
      }
      let reference: ReturnType<typeof pinFile> | undefined;
      if (scenario === "reference-family")
        reference = pinFile(
          root,
          put("reference.json", {
            schemaVersion: 1,
            referenceId: "synthetic",
            format: { width: 1080, height: 1920, fps: 30 },
            durationSec: 1,
            slots: [
              {
                id: "hook",
                role: "hook",
                startSec: 0,
                durationSec: 1,
                visualRecipe: "Original product text",
                motionRecipe: "Hold",
                soundRecipe: "Declared silence",
              },
            ],
            rhythm: { cutGrid: "Single beat" },
            style: "Fixture",
            transferRules: { keep: ["Presentation function"], mustChange: ["Product facts"] },
          }),
        );
      const entityPins: NonNullable<CampaignProductionRequest["entityPins"]> = [];
      if (scenario === "content-series") {
        const directory = path.join(root, "public/projects/bible");
        mkdirSync(directory);
        writeFileSync(path.join(directory, "project.json"), "{}");
        const view = saveEntityVersion(
          "bible",
          {
            kind: "style",
            id: "series",
            name: "Fixture programme",
            description: "Synthetic identity fixture",
            palette: ["#102030"],
            cameraGrammar: "Held shot",
            editGrammar: "One beat",
            createdBy: "fixture",
          },
          { rootDir: root },
        );
        approveEntityVersion(
          "bible",
          "style",
          "series",
          1,
          { id: "fixture", kind: "human", authorizationEvidence: "Explicit test declaration only" },
          { expectedRevision: 1, rootDir: root },
        );
        entityPins.push({
          sourceProjectId: "bible",
          kind: "style",
          entityId: "series",
          revision: 1,
          contentHash: view.version.contentHash,
        });
      }
      let catalogue: CampaignProductionRequest["catalogue"];
      if (scenario === "catalogue-videos") {
        const rows = members.map((member) => ({
          id: member.id!,
          fontSha: member.fontContext!.sha256,
          audioSha: member.speech![0].audio.sha256,
          alignmentSha: member.speech![0].alignment.sha256,
          imageSha: imageHashes.get(member.id!)!,
          price: member.adapter!.kind === "template" ? member.adapter.project.scenes[0].subtext! : "",
        }));
        writeFileSync(
          path.join(root, "catalogue.csv"),
          "id,fontSha,audioSha,alignmentSha,imageSha,price\n" +
            rows
              .map((row) => [row.id, row.fontSha, row.audioSha, row.alignmentSha, row.imageSha, row.price].join(","))
              .join("\n") +
            "\n",
        );
        const member = members[0],
          project = member.adapter!.kind === "template" ? member.adapter.project : undefined;
        assert.ok(project);
        catalogue = {
          file: pinFile(root, "catalogue.csv"),
          format: "csv",
          idColumn: "id",
          columns: {
            fontSha: "fontSha",
            audioSha: "audioSha",
            alignmentSha: "alignmentSha",
            imageSha: "imageSha",
            price: "price",
          },
          memberTemplate: {
            ...member,
            id: "{{id}}",
            projectId: "{{id}}",
            materials: ["product-{{id}}"],
            fontContext: { path: "fonts-{{id}}.json", sha256: "{{fontSha}}" },
            adapter: {
              kind: "template",
              project: {
                ...project,
                name: "Product {{id}}",
                scenes: [
                  {
                    ...project.scenes[0],
                    headline: "Product {{id}}",
                    subtext: "{{price}}",
                    imageUrl: "material://product-{{id}}",
                  },
                ],
              },
            },
            speech: [
              {
                sceneId: "hook",
                audio: { path: "speech-{{id}}.mp3", sha256: "{{audioSha}}" },
                alignment: { path: "alignment-{{id}}.json", sha256: "{{alignmentSha}}" },
              },
            ],
            assurance: {
              facts: [
                { key: "name", value: "Product", source: pinFile(root, facts), jsonPointer: "/product" },
                { key: "productId", value: "{{id}}", source: pinFile(root, facts), jsonPointer: "/items/{{id}}" },
                { key: "price", value: "{{price}}", source: pinFile(root, facts), jsonPointer: "/prices/{{id}}" },
              ],
              requiredText: ["Product {{id}}"],
            },
            delivery: {
              ...member.delivery,
              projectId: "{{id}}",
              rightsReviews: member.delivery!.rightsReviews!.map((review) =>
                review.sourceUrl === "manual:ffmpeg-sine-fixture"
                  ? { ...review, sha256: "{{audioSha}}" }
                  : review.sourceUrl === "manual:ffmpeg-color-fixture"
                    ? { ...review, sha256: "{{imageSha}}" }
                    : review,
              ),
            },
          },
        };
      }
      const request = CampaignProductionRequestSchema.parse({
        version: 1,
        id: "batch",
        revision: 1,
        scenario,
        brief:
          "Explicit local E2E fixture. Scripted agents and human declarations test protocols only; no live creative or linguistic quality claim.",
        members: catalogue ? [] : members,
        catalogue,
        reference,
        entityPins,
        materials,
        policy: {
          quality: "strict",
          pilotMemberIds: ["item-1"],
          controlMemberId: "item-1",
          variableFactors: ["hook"],
          variableSceneIds: ["hook"],
        },
        agentTasks: [
          {
            id: "intake-check",
            agent: "campaign-producer",
            purpose: "Check the supplied fixture sources",
            outputs: ["intake-check.json"],
            requirements: { commands: ["render"], modelUseCases: [], acceptance: ["Every source is explicit"] },
          },
        ],
      });
      put("request.json", request);
      cli("campaign-production.ts", ["--action", "plan", "--request", "request.json"]);
      cli("campaign-production.ts", ["--action", "init", "--request", "request.json"]);
      assert.equal(cli("next.ts").metadata.next.action, "ask");
      cli("campaign-execute.ts", [], false);
      cli("campaign-execute.ts", ["--allow-paid", "--max-total-usd", "0"], false);
      const approve = (purpose: string) => {
        const packageResult = cli("campaign-production.ts", ["--action", "review", "--purpose", purpose]);
        cli("campaign-approve.ts", [
          "--package",
          packageResult.outputs[0],
          "--expected-hash",
          packageResult.metadata.packageHash,
          "--answer",
          "Explicit fixture-only decision, not real production acceptance",
          "--reviewed-by",
          "synthetic reviewer",
        ]);
      };
      approve("creative-plan");
      const repaired = new Set<string>();
      let finished = false;
      for (let iteration = 0; iteration < 100; iteration++) {
        for (const member of members) {
          const target = path.join(root, "public/projects", member.projectId!);
          if (existsSync(target) && !existsSync(path.join(target, "resources")))
            cpSync(
              path.join(staging, "public/projects", member.projectId!, "resources"),
              path.join(target, "resources"),
              { recursive: true },
            );
        }
        const next = cli("campaign-next.ts").metadata;
        put("flow-progress.json", { iteration, next });
        if (next.action === "run") {
          const active = next.status?.heldTaskCount
            ? members.filter((member) => request.policy?.pilotMemberIds?.includes(member.id!))
            : members;
          cli("campaign-production.ts", [
            "--action",
            "run-local",
            "--max-tasks",
            active.some((member) => !existsSync(path.join(root, "public/projects", member.projectId!, "resources")))
              ? "1"
              : "100",
          ]);
          continue;
        }
        if (next.action === "dispatch") {
          const brief = cli("campaign-brief.ts", ["--task", next.taskId]).metadata;
          const manifest = jsonFile(
            brief.manifest.path.startsWith("/") ? brief.manifest.path : path.join(root, brief.manifest.path),
          ) as {
            declaredOutputs: string[];
            previousDecision?: { hash: string };
            inputs?: { member: CampaignMember; project: ReturnType<typeof pinFile>; decisionHash: string };
          };
          if (brief.agent === "fixer") {
            const input = manifest.inputs!;
            put("repair.json", {
              version: 1,
              memberId: input.member.id,
              decisionHash: input.decisionHash,
              expectedProject: input.project,
              changes: [{ sceneId: "hook", transitionToNext: "crossfade" }],
              reason: "Apply only the named presentation correction",
            });
            cli("campaign-production.ts", ["--action", "repair", "--input", "repair.json"]);
            continue;
          }
          const isCritic = brief.agent === "creative-critic",
            revise = isCritic && !repaired.has(brief.taskId);
          if (revise) repaired.add(brief.taskId);
          const evidenceFile = isCritic ? `out/${brief.taskId.slice("critique-".length)}/vertical-clean.mp4` : facts;
          const outputs = revise
            ? []
            : manifest.declaredOutputs.map((output) =>
                pinFile(root, put(output, { fixture: true, liveAgent: false, task: brief.taskId })),
              );
          put("decision.json", {
            version: 1,
            taskId: brief.taskId,
            planHash: brief.planHash,
            inputHash: brief.inputHash,
            agent: brief.agent,
            verdict: revise ? "revise" : "accept",
            rationale: "Scripted fixture verdict, not real creative judgement",
            evidence: [pinFile(root, evidenceFile)],
            outputs,
            ...(manifest.previousDecision ? { supersedes: manifest.previousDecision.hash } : {}),
            ...(revise
              ? {
                  issues: [
                    {
                      id: "transition",
                      category: "presentation",
                      sceneId: "hook",
                      instruction: "Use crossfade for this named exit",
                      acceptance: "The hook exit uses crossfade",
                      evidence: [pinFile(root, evidenceFile)],
                    },
                  ],
                }
              : {}),
          });
          cli("campaign-production.ts", ["--action", "decision", "--input", "decision.json"]);
          continue;
        }
        if (next.action === "ask") {
          if (next.reasonCode === "LANGUAGE_REVIEW_REQUIRED") {
            approve("child-gates");
            continue;
          }
          if (next.reasonCode === "PILOT_REVIEW_REQUIRED") {
            approve("pilot-outputs");
            continue;
          }
          const status = cli("campaign-production.ts", ["--action", "status"]).metadata;
          if (
            next.reasonCode === "FINAL_REVIEW_REQUIRED" &&
            status.tasks.some(
              (task: { id: string; state: string }) => task.id.startsWith("delivery-") && task.state === "blocked",
            )
          ) {
            approve("final-outputs");
            continue;
          }
          assert.fail(JSON.stringify(next));
        }
        if (next.action === "stop") {
          assert.equal(next.productionReady, true);
          finished = true;
          break;
        }
        assert.fail(JSON.stringify(next));
      }
      assert.equal(finished, true, "Flow must finish without a manual workaround");
      if (scenario === "catalogue-videos")
        for (const member of members) {
          const project = ProjectConfigSchema.parse(
              jsonFile(path.join(root, "public/projects", member.projectId!, "project.json")),
            ),
            original = project.scenes[0].imageUrl!;
          assert.ok(original.startsWith(`projects/${member.projectId}/assets/imported/`));
          assert.equal(pinFile(root, path.join("public", original)).sha256, imageHashes.get(member.id!));
        }
      const plan = loadCampaign(root, "batch");
      assert.equal(plan.request.spend, "forbid");
      assert.equal(
        cli("campaign-production.ts", ["--action", "check"]).metadata.reports.every(
          (report: { passed: boolean }) => report.passed,
        ),
        true,
      );
      put("outcomes.json", {
        version: 1,
        campaignId: "batch",
        episodeId: "item-1",
        observedAt: new Date().toISOString(),
        source: "Synthetic E2E measurement",
        cohort: "fixture",
        metrics: { views: 1 },
        review: { reviewedBy: "fixture", evidence: "Not real business performance" },
      });
      cli("campaign-production.ts", ["--action", "outcomes", "--input", "outcomes.json"]);
      assert.equal(cli("campaign-production.ts", ["--action", "run-local"]).metadata.attempted, 0);
      put("revision.json", { ...request, revision: 2 });
      cli("campaign-production.ts", ["--action", "revise", "--request", "revision.json"]);
      assert.equal(cli("campaign-next.ts").metadata.reasonCode, "PLAN_APPROVAL_REQUIRED");
      cli("campaign-production.ts", ["--action", "archive", "--reason", "Synthetic test ended"]);
      assert.equal(cli("campaign-next.ts").metadata.reasonCode, "ARCHIVED");
      put("flow-evidence.json", {
        scenario,
        completed: true,
        apiSpendUsd: 0,
        liveAgent: false,
        calls,
        repaired: [...repaired],
      });
      t.diagnostic(
        JSON.stringify({
          scenario,
          commands: calls.length,
          renderedMembers: count,
          repairedMembers: repaired.size,
          paidCalls: 0,
          liveCreativeAcceptance: false,
        }),
      );
    },
  );
