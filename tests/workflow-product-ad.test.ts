import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { productAdFixture } from "./workflow-product-ad-fixtures";
import { runProductAdWorkflow } from "../src/lib/workflows/product-ad";
import { planProjectRender } from "../src/lib/render-plan";
import { readAssetRegistry, hashFile } from "../src/lib/assets/registry";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
const fixture = (run: (root: string, request: ReturnType<typeof productAdFixture>) => void) => {
  const root = mkdtempSync(path.join(tmpdir(), "product-ad-contract-"));
  try {
    run(root, productAdFixture(root));
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
};
test("plan is write-free; create preserves originals and produces six usable exact-timing render plans", () =>
  fixture((root, request) => {
    const before = readdirSync(root);
    const plan = runProductAdWorkflow(request, {
      action: "plan",
      rootDir: root,
    });
    assert.equal(plan.metadata.productionReady, false);
    assert.deepEqual(readdirSync(root), before);
    const result = runProductAdWorkflow(request, {
      action: "create",
      rootDir: root,
    });
    assert.equal(result.outputs.length, 5);
    assert.equal(result.metadata.paidOperations, 0);
    const dir = path.join(root, "public/projects", request.projectId);
    const registry = readAssetRegistry(request.projectId, root);
    assert.ok(registry.assets.length >= 6);
    for (const media of request.media) assert.equal(hashFile(media.path), media.sha256);
    const ir = new TimelineEditStore(path.join(dir, "pipeline/timeline-edit.json")).read().timeline;
    const snapshot = compileTimelineIR(ir);
    assert.equal(snapshot.durationInFrames, 150);
    assert.equal(snapshot.tracks.find((t) => t.kind === "voiceover")!.clips[2].captions[0].start.num, 64);
    assert.throws(() => planProjectRender(request.projectId, undefined, root), /timeline/i);
    for (const captions of ["on", "off"] as const) {
      const jobs = planProjectRender(request.projectId, undefined, root, {
        timeline: true,
        captions,
      }).jobs;
      assert.equal(jobs.length, 3);
      for (const job of jobs) {
        assert.equal(job.durationInFrames, 150);
        assert.equal(job.props.captionsEnabled, captions === "on");
        assert.ok(job.props.timelineAssets);
      }
    }
    assert.match(readFileSync(path.join(dir, "pipeline/captions.srt"), "utf8"), /00:00:02,133/);
    const evidence = JSON.parse(readFileSync(path.join(dir, "pipeline/product-ad-evidence.json"), "utf8"));
    assert.deepEqual(evidence.delivery.declaredClaims, [
      {
        id: "visible-action:proof",
        text: "Result indicator becomes green",
        sceneId: "proof",
      },
    ]);
    assert.equal(evidence.approval.status, "pending-human-review");
    assert.equal(
      evidence.claimEvidence[0].evidence.path.startsWith(`projects/${request.projectId}/assets/evidence/`),
      true,
    );
    assert.throws(
      () =>
        runProductAdWorkflow(request, {
          action: "create",
          rootDir: root,
        }),
      /never overwrites/,
    );
  }));
test("invalid captions, fake claim references, incomplete demo and unsafe crops fail before project creation", () =>
  fixture((root, request) => {
    const cases = [
      (r: typeof request) => {
        r.beats[2].visual.interaction = undefined;
      },
      (r: typeof request) => {
        r.beats[3].claimIds = ["invented"];
      },
      (r: typeof request) => {
        r.beats[0].voice.words[0].endFrame = 31;
      },
      (r: typeof request) => {
        r.beats[0].spokenText = "Not supplied words";
      },
      (r: typeof request) => {
        r.media[0].criticalRegion = {
          x: 0,
          y: 0,
          width: 0.2,
          height: 0.2,
        };
      },
      (r: typeof request) => {
        r.beats[2].visual.sourceStartFrame = 150;
      },
      (r: typeof request) => {
        r.claims[0].evidence.excerpt = "Invented result";
      },
    ];
    for (const alter of cases) {
      const r = structuredClone(request);
      alter(r);
      assert.throws(() =>
        runProductAdWorkflow(r, {
          action: "create",
          rootDir: root,
        }),
      );
      assert.equal(existsSync(path.join(root, "public/projects", request.projectId)), false);
    }
  }));
test("escaping output ancestor and duplicate speech music cannot mutate another workspace", () =>
  fixture((root, request) => {
    const external = mkdtempSync(path.join(tmpdir(), "product-ad-output-external-"));
    try {
      symlinkSync(external, path.join(root, "public"));
      assert.throws(
        () =>
          runProductAdWorkflow(request, {
            action: "create",
            rootDir: root,
            scopeRoot: root,
          }),
        /symlink/,
      );
      assert.deepEqual(readdirSync(external), []);
    } finally {
      rmSync(external, {
        recursive: true,
        force: true,
      });
    }
    const duplicate = structuredClone(request);
    duplicate.music.mediaId = "voice";
    assert.throws(
      () =>
        runProductAdWorkflow(duplicate, {
          action: "plan",
          rootDir: root,
        }),
      /duplicate.*speech/,
    );
    const alias = structuredClone(request);
    const voice = alias.media.find((media) => media.id === "voice")!;
    Object.assign(
      alias.media.find((media) => media.id === "music")!,
      {
        path: voice.path,
        sha256: voice.sha256,
      },
    );
    assert.throws(
      () =>
        runProductAdWorkflow(alias, {
          action: "plan",
          rootDir: root,
        }),
      /aliased/,
    );
    const hidden = structuredClone(request);
    hidden.beats[3].headline = "Unsupported proof copy";
    assert.throws(
      () =>
        runProductAdWorkflow(hidden, {
          action: "plan",
          rootDir: root,
        }),
      /actually appear/,
    );
  }));
test("changed source/evidence and nested scope escape reject without writes", () =>
  fixture((root, request) => {
    assert.throws(
      () =>
        runProductAdWorkflow(request, {
          action: "plan",
          rootDir: root,
          scopeRoot: path.join(root, "supplied originals"),
        }),
      /scope/,
    );
    assert.throws(
      () =>
        runProductAdWorkflow(request, {
          action: "invalid" as any,
          rootDir: root,
        }),
      /Unknown workflow action/,
    );
    const external = mkdtempSync(path.join(tmpdir(), "product-external-"));
    try {
      const file = path.join(external, "external.png");
      copyFileSync(request.media[0].path, file);
      const moved = structuredClone(request);
      moved.media[0].path = file;
      assert.throws(
        () =>
          runProductAdWorkflow(moved, {
            action: "plan",
            rootDir: root,
            scopeRoot: root,
          }),
        /authority scope/,
      );
    } finally {
      rmSync(external, {
        recursive: true,
        force: true,
      });
    }
    const drift = structuredClone(request);
    drift.media[0].sha256 = "0".repeat(64);
    assert.throws(
      () =>
        runProductAdWorkflow(drift, {
          action: "create",
          rootDir: root,
        }),
      /checksum changed/,
    );
    writeFileSync(request.claims[0].evidence.path, "Edited evidence");
    assert.throws(
      () =>
        runProductAdWorkflow(request, {
          action: "create",
          rootDir: root,
        }),
      /checksum changed/,
    );
    assert.equal(existsSync(path.join(root, "public")), false);
  }));

test("explicit disjoint voice and music selections from one original retain range semantics", () =>
  fixture((root, request) => {
    const audio = path.join(root, "separate-sections.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", audio]);
    for (const id of ["voice", "music"])
      Object.assign(
        request.media.find((media) => media.id === id)!,
        { path: audio, sha256: hashFile(audio) },
      );
    request.music.sourceStartFrame = 150;
    const result = runProductAdWorkflow(request, { action: "plan", rootDir: root });
    assert.equal(result.metadata.dryRun, true);
    assert.equal(existsSync(path.join(root, "public")), false);
  }));
