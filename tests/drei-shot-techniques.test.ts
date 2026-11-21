import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BoxGeometry, Mesh, Vector3 } from "three";
import { renderBrief } from "../src/lib/film/brief";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { openFilmProject } from "../src/lib/film/state";
import { selectExperiment, startExperiment } from "../src/lib/experiments/project";
import { THREE_SHOT_EXPERIMENT } from "../src/lib/experiments/registry";
import { readCatalogue } from "../src/lib/library/catalogue";
import { withPlaybook } from "../src/lib/pipeline/route";
import { writeProjectPlaybook } from "../src/lib/playbooks/project";
import {
  assemblyCues,
  assemblySchema,
  cameraCurve,
  cameraPose,
  clipTime,
  modelDistance,
  modelFit,
  modelShotSchema,
  shotModelSchema,
} from "../src/motion/library/three/shot-plan";
import { projectorDemoSource } from "../src/motion/library/three/shot-demo-model";
import { connectorReveal } from "../src/motion/library/three/shot-techniques";

test("GLB inputs are local and shot ranges fit their composition", () => {
  assert.equal(shotModelSchema.safeParse({ src: "projects/project-one/assets/product.glb" }).success, true);
  for (const src of [
    "https://example.com/model.glb",
    "projects/p/../../model.glb",
    "projects/p/model.gltf",
    "shared/model.glb",
  ]) {
    assert.equal(shotModelSchema.safeParse({ src }).success, false, src);
  }
  const clip = { name: "release-battery", startFrame: 30, endFrame: 90 };
  assert.equal(modelShotSchema.safeParse({ durationInFrames: 90, clip }).success, false);
  assert.equal(modelShotSchema.safeParse({ durationInFrames: 91, clip }).success, true);
  assert.equal(modelShotSchema.safeParse({ clip: { ...clip, endFrame: 29 } }).success, false);
});

test("model framing accounts for centre, depth and aspect ratio", () => {
  const object = new Mesh(new BoxGeometry(4, 2, 2));
  object.position.set(3, 2, 1);
  const { centre, size, scale } = modelFit(object);
  assert.deepEqual(centre.toArray(), [3, 2, 1]);
  assert.deepEqual(size.toArray(), [2.7, 1.35, 1.35]);
  assert.equal(scale, 2.7 / 4);
  const model = new Vector3(2.7, 1.35, 1.35);
  assert.ok(modelDistance(model, 9 / 16, 0.78, 0, 34) > modelDistance(model, 16 / 9, 0.78, 0, 34));
  assert.throws(() => modelFit(new Mesh(new BoxGeometry(0, 0, 0))), /no finite, visible geometry/);
});

test("camera, GLB time and assembly cues depend on absolute frame", () => {
  const camera = connectorReveal.camera!;
  const curve = cameraCurve(camera.points);
  const pose = (f: number) => cameraPose(camera, curve, f, 4);
  const middle = pose(63);
  assert.deepEqual(pose(0), pose(camera.startFrame));
  assert.deepEqual(pose(149), pose(camera.endFrame));
  assert.deepEqual(pose(63), middle);
  assert.notDeepEqual(pose(63), pose(0));
  const clip = { startFrame: 20, endFrame: 40 };
  assert.deepEqual(
    [21, 40, 0, 30, 40, 21].map((frame) => clipTime(frame, clip, 2)),
    [0.1, 2, 0, 1, 2, 0.1],
  );
  const assembly = assemblySchema.parse({ durationInFrames: 180 });
  assert.equal(assembly.groupCount * assembly.unitsPerGroup, 24);
  assert.deepEqual(assemblyCues(assembly), [61, 85, 109]);
});

test("showcase uses an original self-contained and repeatable glTF fixture", () => {
  const source = projectorDemoSource();
  assert.equal(projectorDemoSource(), source);
  const file = JSON.parse(Buffer.from(source.split(",")[1]!, "base64").toString());
  assert.equal(file.asset.version, "2.0");
  assert.equal(file.animations[0].name, "release-battery");
  assert.ok(file.nodes.some(({ name }: { name: string }) => name === "Air Intake"));
  assert.ok(file.buffers.every(({ uri }: { uri: string }) => uri.startsWith("data:")));
});

function filmFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "drei-shot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "public/projects/pocket-projector");
  mkdirSync(directory, { recursive: true });
  scaffoldFilmProject(directory, "pocket-projector", [], { filmType: "motion-graphics" });
  writeProjectPlaybook(directory, "product-promo", "user");
  return { root, directory };
}

test("only opted-in shot stages see the experiment, and starting pins it", (t) => {
  const { root, directory } = filmFixture(t);
  const film = openFilmProject(directory, { rootDir: root });
  assert.equal(withPlaybook(directory, [], "look").experiments, undefined);
  assert.doesNotMatch(renderBrief(film, "look").prompt, /three-shot-techniques/);
  selectExperiment(directory, THREE_SHOT_EXPERIMENT, true);
  assert.equal(withPlaybook(directory, [], "look").experiments?.[0]?.id, THREE_SHOT_EXPERIMENT);
  assert.match(renderBrief(film, "beat-sheet").prompt, /library:list --for-shot.*--project pocket-projector/);
  assert.equal(withPlaybook(directory, [], "script").experiments, undefined);
  assert.equal(startExperiment(directory, THREE_SHOT_EXPERIMENT), true);
  assert.throws(() => selectExperiment(directory, THREE_SHOT_EXPERIMENT, false), /has started/);
});

test("catalogue returns at most three checked options for an opted-in project", (t) => {
  const id = path.basename(mkdtempSync(path.join(process.cwd(), "public/projects/drei-search-")));
  const directory = path.join("public/projects", id);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  scaffoldFilmProject(directory, id, [], { filmType: "motion-graphics" });
  writeProjectPlaybook(directory, "motion-design", "user");
  const search = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "scripts/library-list.ts", ...args], { encoding: "utf8" }),
    ).metadata;
  assert.equal(search("--for-shot", "reveal", "--project", id).count, 0);
  assert.equal(search("--query", "frosted-product-window").count, 0);
  const changeExperiment = (action: "enable" | "disable") =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/experiment.ts",
          "--action",
          action,
          "--project",
          id,
          "--id",
          THREE_SHOT_EXPERIMENT,
        ],
        { encoding: "utf8", env: { ...process.env, AGENTBROS_STEP_GUARD: "enforce" } },
      ),
    );
  assert.equal(changeExperiment("enable").metadata.active[0].id, THREE_SHOT_EXPERIMENT);
  const result = search("--for-shot", "reveal", "--format", "vertical", "--project", id);
  assert.equal(result.count, 3);
  assert.deepEqual(
    result.items.map(({ id }: { id: string }) => id),
    ["product-model-stage", "camera-path-reveal", "gltf-clip-cue"],
  );
  assert.ok(result.items.every(({ card }: { card: string }) => card.startsWith("design-reference/techniques/")));
  assert.equal(search("--for-shot", "reveal", "--format", "square", "--project", id).count, 0);
  assert.equal(
    search("--for-shot", "reveal", "--query", "glass", "--project", id).items[0].id,
    "frosted-product-window",
  );
  assert.equal(search("--id", "gltf-clip-cue").item.shotTechnique.id, "gltf-clip-cue");
  assert.equal(
    readCatalogue()?.items.filter(({ shotTechnique }) => shotTechnique?.experiment === THREE_SHOT_EXPERIMENT).length,
    6,
  );
  assert.deepEqual(changeExperiment("disable").metadata.active, []);
  writeProjectPlaybook(directory, "feature-update", "user", undefined, { force: true });
  assert.throws(() => selectExperiment(directory, THREE_SHOT_EXPERIMENT, true), /cannot be changed/);
});
