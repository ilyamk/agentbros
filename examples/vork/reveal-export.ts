/** Reproducible surface variant for the original blender-source.py fixture. */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript } from "../../src/lib/cli";
import { json, writeNew } from "../../src/lib/vork/runtime";
import { VorkTaskSchema } from "../../src/types/vork";

void runScript(async () => {
  const args = parseArgs([
    { name: "input", required: true, description: "Original bridge export directory" },
    { name: "output", required: true, description: "Fresh source variant directory" },
  ] as const);
  const input = path.resolve(args.input!),
    output = path.resolve(args.output!);
  const scene = json(path.join(input, "shot.json")) as {
    programs: Record<string, unknown>;
    materials: Record<string, unknown>;
    render: { display: { inputs: Record<string, unknown> } };
  };
  const report = json(path.join(input, "export-report.json")) as {
    material_reports: Record<string, { material: string }>;
  };
  const copper = Object.entries(report.material_reports).find(([, value]) => value.material === "Copper")?.[0];
  if (!copper) throw new Error("This example requires the original Copper fixture material");
  const task = VorkTaskSchema.parse(json(path.join(input, "task.json")));
  const files = readdirSync(input).filter(
    (file) => file.endsWith(".slang") || ["scene.glb", "shot.profile.json", "export-report.json"].includes(file),
  );
  mkdirSync(output);
  for (const file of files) copyFileSync(path.join(input, file), path.join(output, file));
  scene.programs.authored_reveal = {
    source:
      "import vork; struct Inputs {}; Closure surface(ShadingContext c, Inputs i) { float line=1.-smoothstep(.012,.035,abs(frac(c.POSITION.y*15.+c.POSITION.x*4.)-.5)); float reveal=smoothstep(-.3,.3,c.time*.45-c.POSITION.y); Closure m={}; m.base_color=float3(.42,.14,.045);m.base_metalness=.8;m.specular_roughness=.25;m.emission_color=float3(.1,.8,1.);m.emission_luminance=8.*line*reveal;return m;}",
  };
  scene.materials[copper] = { program: "authored_reveal" };
  scene.render.display.inputs.dither_intensity = 0;
  const sceneFile = writeNew(path.join(output, "shot.json"), scene);
  const taskFile = writeNew(
    path.join(output, "task.json"),
    VorkTaskSchema.parse({
      ...task,
      scene: "shot.json",
      intent: "Preserve the Blender sculpture and camera while revealing copper surface emission",
      effect: "Authored copper-to-light surface reveal",
      inputs: [
        ...task.inputs.map((file) => path.relative(output, path.resolve(input, file))),
        path.relative(output, path.join(input, "shot.json")),
      ],
    }),
  );
  return { outputs: [sceneFile, taskFile] };
});
