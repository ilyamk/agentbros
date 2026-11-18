import { createHash } from "node:crypto";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { MotionPlanSchema } from "../../types/creative";
import type { VizBundle, VizFormat } from "../../types/viz";
import { hashFile } from "../assets/registry";
import { assertVizDestination, localFile } from "./store";
import { assertVizMotionPlan } from "./integrity";
import { collectActiveViz } from "./usage";
import { VizFilmPropsSchema as vizFilmPropsSchema } from "../../types/viz";
import { vizHash } from "./compile";
export function mountVizFilm(options: {
  project: string;
  bundle: VizBundle;
  shot: string;
  planHash: string;
  buildHash?: string;
  format: VizFormat;
  apply: boolean;
}) {
  const root = process.cwd(),
    directory = path.join("public/projects", options.project, "pipeline");
  const file = localFile(root, path.join(directory, "motion-plan.json"));
  if (hashFile(file) !== options.planHash) throw new Error("Motion plan hash conflict");
  const plan = MotionPlanSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const shot = plan.shots.find((s) => s.id === options.shot);
  if (!shot) throw new Error("Motion plan shot not found");
  const buildFile = path.join(directory, "build.json");
  const previous = existsSync(buildFile) ? readFileSync(buildFile, "utf8") : undefined;
  if (previous) {
    const build = JSON.parse(previous) as { entry?: string };
    if (build.entry !== "src/motion/viz/film.tsx")
      throw new Error("This mount cannot replace a custom film build; use its scene integration point");
    if (hashFile(buildFile) !== options.buildHash) throw new Error("Build hash conflict");
  }
  shot.vizBinding = { sceneId: options.bundle.plans[0]!.spec.sceneId, revision: options.bundle.hash };
  assertVizMotionPlan(root, options.project, plan);
  const pending = plan.shots.filter((s) => !s.vizBinding).map((s) => s.id);
  let generated: { file: string; bytes: string; build: string } | undefined;
  if (!pending.length) {
    if (plan.shots.some((s, i) => i < plan.shots.length - 1 && s.transitionToNext !== "cut"))
      throw new Error("The command-built visualisation film requires explicit cuts");
    for (let i = 1; i < plan.shots.length; i++)
      if (plan.shots[i]!.startFrame < plan.shots[i - 1]!.startFrame + plan.shots[i - 1]!.durationFrames)
        throw new Error("Visualisation film shots must not overlap");
    const active = collectActiveViz(root, options.project, plan);
    const props = vizFilmPropsSchema.parse({
      format: options.format,
      shots: plan.shots.map((s) => {
        const item = active.find(
          (a) => a.sceneId === s.vizBinding!.sceneId && a.bundle.hash === s.vizBinding!.revision,
        )!;
        if (!item.bundle.plans.some((p) => p.format === options.format))
          throw new Error("Film format has no prepared layout");
        return {
          id: s.id,
          startFrame: s.startFrame,
          durationInFrames: s.durationFrames,
          plans: item.bundle.plans,
          vizBinding: s.vizBinding,
        };
      }),
    });
    const bytes = JSON.stringify(props);
    const propsFile = path.join(directory, "viz", `film-props-${vizHash(props)}.json`);
    generated = {
      file: propsFile,
      bytes,
      build: JSON.stringify(
        {
          schemaVersion: 1,
          composition: "VizFilm",
          entry: "src/motion/viz/film.tsx",
          props: propsFile.slice("public/".length),
          vizMotionPlanHash: createHash("sha256")
            .update(JSON.stringify(plan, null, 2))
            .digest("hex"),
        },
        null,
        2,
      ),
    };
  }
  if (options.apply) {
    assertVizDestination(file);
    if (hashFile(file) !== options.planHash) throw new Error("Motion plan changed");
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(plan, null, 2), { flag: "wx" });
    renameSync(temporary, file);
    if (generated) {
      assertVizDestination(generated.file);
      mkdirSync(path.dirname(generated.file), { recursive: true });
      if (!existsSync(generated.file)) writeFileSync(generated.file, generated.bytes, { flag: "wx" });
      assertVizDestination(buildFile);
      const buildTemporary = `${buildFile}.${process.pid}.tmp`;
      writeFileSync(buildTemporary, generated.build, { flag: "wx" });
      renameSync(buildTemporary, buildFile);
    }
  }
  return {
    outputs: options.apply ? [file, ...(generated ? [generated.file, buildFile] : [])] : [],
    metadata: {
      applied: options.apply,
      pendingShots: pending,
      ...(generated ? { composition: "VizFilm", entry: "src/motion/viz/film.tsx" } : {}),
    },
  };
}
