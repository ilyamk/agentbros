import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ExecutableArsenalPlanSchema, EXECUTION_WEIGHTS, type ArsenalTask } from "./eval-schema";
import { inspectCheckout, parsePlannedCommand, type CheckoutInventory } from "./eval-checkout";
import { validateRecipeParams } from "./recipes";

const worker = fileURLToPath(new URL("../../../scripts/workers/blender/avc_eval_plan.py", import.meta.url));
const PythonFactsSchema = z
  .object({
    error: z.string().nullable(),
    imports: z.array(z.string()).optional(),
    undefined: z.array(z.string()).optional(),
    faults: z.array(z.string()).optional(),
    recipes: z.array(z.object({ id: z.string(), params: z.unknown() }).strict()).optional(),
    assets: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    concrete: z.number().optional(),
    animated: z.boolean().optional(),
    simulation: z.boolean().optional(),
    baked: z.boolean().optional(),
    seeded: z.boolean().optional(),
    numbers: z.array(z.number()).optional(),
    emission: z.boolean().optional(),
    unsafe: z.boolean().optional(),
    placeholders: z.boolean().optional(),
    statements: z.number().optional(),
    commands: z.array(z.array(z.string())).optional(),
    calls: z.array(z.string()).optional(),
    lenses: z.array(z.number()).optional(),
    temperatures: z.array(z.number()).optional(),
    presets: z.array(z.string()).optional(),
    materials: z.array(z.object({ input: z.string(), value: z.number() }).strict()).optional(),
    seedValues: z.array(z.number()).optional(),
    moves: z.array(z.string()).optional(),
    setupTypes: z.array(z.string()).optional(),
    loops: z.number().optional(),
    labels: z.array(z.string()).optional(),
  })
  .strict();
export function inspectPythonPlans(code: string[]) {
  const result = spawnSync(pythonUv(), pythonArgs("stdlib", [worker]), {
    env: pythonEnvironment("stdlib"),
    input: JSON.stringify(code),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Cannot inspect proposed Python: ${result.error?.message ?? result.stderr.slice(-500)}`);
  return z.array(PythonFactsSchema).parse(JSON.parse(result.stdout));
}
const within = (file: string) => !path.isAbsolute(file) && !file.includes("\\") && !file.split("/").includes("..");
const stdlib = new Set([
  "__future__",
  "bpy",
  "mathutils",
  "bmesh",
  "bpy_extras",
  "math",
  "random",
  "json",
  "sys",
  "os",
  "pathlib",
  "typing",
  "collections",
  "itertools",
  "functools",
  "hashlib",
  "subprocess",
  "dataclasses",
  "time",
  "array",
  "statistics",
]);

/** Static evidence only: no model judgement, candidate execution, downloads or arbitrary CLI runs. */
export function scoreExecutablePlan(
  task: ArsenalTask,
  input: unknown,
  root: string,
  inventory: CheckoutInventory = inspectCheckout(root),
  sample = 1,
  error: string | null = null,
) {
  type Category = keyof typeof EXECUTION_WEIGHTS;
  const parsed = ExecutableArsenalPlanSchema.safeParse(input),
    plan = parsed.success ? parsed.data : null;
  if (!parsed.success) error ??= parsed.error.message;
  const checks: Array<{ criterion: string; pass: boolean; points: number; maximum: number; reason: string }> = [];
  const findings: Array<{ category: Category; message: string }> = [];
  const evidence = new Map<Category, Array<{ pass: boolean; reason: string }>>();
  const add = (category: Category, pass: boolean, reason: string) => {
    const entries = evidence.get(category) ?? [];
    entries.push({ pass, reason });
    evidence.set(category, entries);
    if (!pass) findings.push({ category, message: reason });
  };
  if (plan) {
    const commands = plan.commands.map((c) => ({ ...parsePlannedCommand(c.argv, inventory), phase: c.phase }));
    for (const command of commands) {
      if (!command.values.help) {
        if (command.alias === "blender:run" && !command.values.script && !command.values.blend)
          command.faults.push("blender:run needs --script or --blend");
        if (
          command.values.samples !== undefined &&
          (!Number.isInteger(Number(command.values.samples)) || Number(command.values.samples) < 1)
        )
          command.faults.push("samples must be a positive integer");
        if (typeof command.values.frames === "string" && !/^[1-9]\d*-[1-9]\d*$/.test(command.values.frames))
          command.faults.push("frames must be a concrete positive a-b range");
        if (typeof command.values.frames === "string") {
          const [first, last] = command.values.frames.split("-").map(Number);
          if (first! > last!) command.faults.push("frames are reversed");
        }
        if (command.alias === "blender:recipe" && command.action !== "list") {
          if (command.action === "proof" ? !!command.values.id === !!command.values.all : !command.values.id)
            command.faults.push("recipe action needs --id (proof exactly one of --id/--all)");
          const recipe = inventory.recipes.find((r) => r.id === command.values.id);
          if (
            recipe &&
            typeof command.values.frames === "string" &&
            Number(command.values.frames.split("-")[1]) > recipe.frames_hint
          )
            command.faults.push(`Recipe ${recipe.id}: frames exceed META limit ${recipe.frames_hint}`);
        }
      }
      add(
        "commands",
        command.faults.length === 0,
        command.faults.join("; ") || `${command.alias}: parser accepts all flags/values`,
      );
    }
    const production = commands.filter((c) => !c.values.help && c.phase !== "inspect");
    add(
      "commands",
      production.some((c) => ["blender:run", "blender:recipe", "blender:scene"].includes(c.alias)),
      "Includes a concrete Blender build/render command beyond inspection",
    );
    const declared = new Map(plan.execution.scripts.map((s) => [s.path, s.code]));
    add(
      "implementation",
      declared.size === plan.execution.scripts.length && [...declared.keys()].every(within),
      "Script paths are unique, relative and contained",
    );
    const code: string[] = [],
      scriptPaths: string[] = [];
    for (const command of production) {
      if (command.alias === "blender:run" && typeof command.values.script === "string") {
        const file = command.values.script,
          existing = within(file) && existsSync(path.join(root, file));
        add(
          "implementation",
          within(file) && (declared.has(file) || existing),
          `Scene script must exist or be supplied in execution.scripts: ${file}`,
        );
        if ((declared.has(file) || existing) && !scriptPaths.includes(file)) {
          scriptPaths.push(file);
          code.push(declared.get(file) ?? readFileSync(path.join(root, file), "utf8"));
        }
      }
      if (command.alias === "blender:run" && typeof command.values.blend === "string")
        add(
          "implementation",
          within(command.values.blend) && existsSync(path.join(root, command.values.blend)),
          `Blend input must already exist: ${command.values.blend}`,
        );
    }
    const facts = inspectPythonPlans(code);
    const recipeUses: Array<{ id: string; params: unknown }> = plan.execution.recipes.map((use) => {
      try {
        return { id: use.id, params: JSON.parse(use.params) as unknown };
      } catch {
        return { id: use.id, params: null };
      }
    });
    const assetIds = new Set(plan.execution.assets),
      extensionIds = new Set(plan.execution.extensions.map((e) => e.id));
    let nativeSetup = false;
    for (const [index, fact] of facts.entries()) {
      const label = scriptPaths[index]!;
      add("implementation", !fact.error, `${label}: Python syntax${fact.error ? `: ${fact.error}` : " valid"}`);
      add(
        "implementation",
        !fact.placeholders && (fact.undefined?.length ?? 0) === 0,
        `${label}: no stubs/undefined globals${fact.undefined?.length ? ` (${fact.undefined.join(", ")})` : ""}`,
      );
      add(
        "references",
        (fact.faults?.length ?? 0) === 0,
        `${label}: literal recipe/asset dependencies${fact.faults?.length ? `: ${fact.faults.join(", ")}` : ""}`,
      );
      for (const imported of fact.imports ?? []) {
        const parts = imported.split("."),
          module = parts[0]!;
        const local = [
          path.join(root, "scripts/blender", `${parts.join("/")}.py`),
          path.join(root, "scripts/blender", `${parts.slice(0, -1).join("/")}.py`),
          path.join(root, "scripts/workers/blender", `${module}.py`),
          path.join(root, "scripts/blender", `${module}.py`),
          path.join(root, "scripts/blender", module),
        ].some((p) => existsSync(p));
        add(
          "implementation",
          stdlib.has(module) || local,
          `${label}: import available in checkout/Blender: ${imported}`,
        );
      }
      add(
        "safety",
        !fact.unsafe,
        `${label}: no direct network/opaque shell/dynamic-execution calls in production Python`,
      );
      for (const argv of fact.commands ?? []) {
        const nested = parsePlannedCommand(argv, inventory);
        add("commands", nested.faults.length === 0, nested.faults.join("; ") || `${label}: nested pnpm flags valid`);
        const acquisition =
          ["add", "acquire", "fetch", "install", "trial"].includes(nested.action) ||
          (nested.alias === "assets:sync" && nested.values.check !== true);
        add(
          "safety",
          !acquisition ||
            production
              .filter((c) => c.values.script === label)
              .every((c) => ["after-consent", "after-approval"].includes(c.phase)),
          `${label}: embedded acquisition is conditional on consent`,
        );
      }
      const verification =
        !fact.simulation &&
        !(fact.concrete ?? 0) &&
        production.filter((c) => c.values.script === label).every((c) => c.values["no-render"]);
      nativeSetup ||= (fact.concrete ?? 0) > 0;
      add(
        "implementation",
        verification || (fact.concrete ?? 0) > 0,
        `${label}: concrete mesh/text/node/material/asset/recipe construction`,
      );
      add(
        "determinism",
        verification || !!fact.animated,
        `${label}: actual frame keys/Timeline/recipe application, not only prose`,
      );
      add(
        "determinism",
        verification || !!fact.seeded || (fact.recipes?.length ?? 0) > 0,
        `${label}: render/procedural seed set in code or recipe`,
      );
      if (fact.simulation)
        add(
          "determinism",
          !!fact.baked &&
            plan.determinism.method !== "frame-function" &&
            !!plan.determinism.cachePath &&
            within(plan.determinism.cachePath) &&
            plan.determinism.cachePath.startsWith("blender-arsenal/local/bakes/"),
          `${label}: simulation bake call and contained arsenal cache before render`,
        );
      recipeUses.push(...(fact.recipes ?? []));
      for (const id of fact.assets ?? []) assetIds.add(id);
      for (const id of fact.extensions ?? []) extensionIds.add(id);
    }
    for (const command of commands) {
      if (command.alias === "blender:recipe" && typeof command.values.id === "string") {
        let params: unknown = {};
        try {
          if (command.values.params) params = JSON.parse(String(command.values.params));
        } catch {
          params = null;
        }
        recipeUses.push({ id: command.values.id, params: params as Record<string, string | number | boolean> });
      }
      if (command.alias === "blender:assets" && typeof command.values.id === "string") assetIds.add(command.values.id);
      if (typeof command.values.extensions === "string" && command.values.extensions !== "approved")
        for (const id of command.values.extensions.split(",")) extensionIds.add(id);
      if (command.alias === "blender:ext" && typeof command.values.id === "string") extensionIds.add(command.values.id);
      if (command.alias === "blender:assets" && typeof command.values.name === "string")
        add("references", !!inventory.collections[command.values.name], `Collection exists: ${command.values.name}`);
    }
    for (const choice of plan.choices) {
      if (choice.kind === "recipe" && !recipeUses.some((r) => r.id === choice.id))
        recipeUses.push({ id: choice.id, params: {} });
      if (choice.kind === "extension") extensionIds.add(choice.id);
      if (choice.kind === "collection")
        add("references", !!inventory.collections[choice.id], `Collection exists: ${choice.id}`);
    }
    for (const material of plan.execution.materials) if (material.assetId) assetIds.add(material.assetId);
    let validProductionRecipe = false,
      fittingProductionRecipe = false;
    for (const use of recipeUses) {
      const meta = inventory.recipes.find((r) => r.id === use.id);
      let failure = meta ? "" : `Recipe absent in this checkout: ${use.id}`;
      if (meta) {
        try {
          validateRecipeParams(meta, use.params);
        } catch (cause) {
          failure = `Recipe ${use.id} params rejected: ${String(cause)}`;
        }
      }
      add("references", !failure, failure || `Recipe ${use.id}: id and bounded typed params valid`);
      if (
        meta &&
        !failure &&
        (facts.some((f) => f.recipes?.some((r) => r.id === use.id)) ||
          production.some(
            (c) =>
              c.alias === "blender:recipe" && c.values.id === use.id && ["render", "bake", "proof"].includes(c.action),
          ))
      ) {
        validProductionRecipe = true;
        fittingProductionRecipe ||= task.expected.recipes.includes(use.id);
      }
      if (meta?.needs_bake)
        add(
          "determinism",
          plan.determinism.method !== "frame-function" &&
            !!plan.determinism.cachePath &&
            within(plan.determinism.cachePath) &&
            plan.determinism.cachePath.startsWith("blender-arsenal/local/bakes/"),
          `Recipe ${use.id} requires a contained bake cache`,
        );
    }
    for (const id of assetIds)
      add(
        "references",
        inventory.assets.some((a) => a.id === id),
        `Asset pinned/collected/indexed in this checkout: ${id}`,
      );
    for (const id of extensionIds) {
      const ext = inventory.extensions.find((e) => e.id === id);
      add("references", !!ext, `Extension exists in this checkout: ${id}`);
      if (ext?.status !== "approved")
        add(
          "safety",
          plan.execution.extensions.some((e) => e.id === id && e.requiresApproval) &&
            commands
              .filter(
                (c) =>
                  (typeof c.values.extensions === "string" && c.values.extensions.split(",").includes(id)) ||
                  (typeof c.values.script === "string" &&
                    facts[scriptPaths.indexOf(c.values.script)]?.extensions?.includes(id)) ||
                  (c.alias === "blender:ext" && c.values.id === id && ["install", "approve"].includes(c.action)),
              )
              .every((c) => c.phase === "after-approval"),
          `Unapproved extension ${id} explicitly conditional on owner approval`,
        );
    }
    for (const [index, fact] of facts.entries())
      for (const id of fact.extensions ?? [])
        add(
          "references",
          production.some(
            (c) =>
              c.values.script === scriptPaths[index] &&
              typeof c.values.extensions === "string" &&
              (c.values.extensions === "approved" || c.values.extensions.split(",").includes(id)),
          ),
          `Script extension ${id} supplied to renderer --extensions`,
        );
    const nativeFit = facts.some((f) => {
      const labels = (f.labels ?? []).join(" "),
        calls = (f.calls ?? []).join(" "),
        types = (f.setupTypes ?? []).join(" ");
      switch (task.id) {
        case "hero-dust":
          return (
            /VolumePrincipled|VolumeScatter/.test(types) ||
            (/dust|mote|particle|puff/i.test(labels) && ((f.loops ?? 0) > 0 || /InstanceOnPoints/.test(types)))
          );
        case "logo-shatter":
          return (
            /fracture|bisect|voronoi/i.test(calls + types) ||
            (/shard|cell/i.test(labels) && /BOOLEAN|Boolean/.test(types))
          );
        case "cosy-desk":
          return /import_device/.test(calls) && /wood|desk/i.test(labels);
        case "neon-tech":
          return /Curve|curves/.test(calls + types) && (/Emission/.test(types) || !!f.emission);
        case "kinetic-title":
          return /text_add|curves.new/.test(calls) && (/FONT/.test(types) || /text_add/.test(calls));
        case "glass-caustics":
          return (f.materials ?? []).some((m) => /Transmission/.test(m.input) && m.value > 0);
        case "confetti-cta":
          return /confetti|foil/i.test(labels) && ((f.loops ?? 0) > 0 || /InstanceOnPoints/.test(types));
        case "fabric-reveal":
          return /CLOTH/.test(types) && !!f.baked;
        case "abstract-loop":
          return ((f.loops ?? 0) > 0 && /sin|cos/.test(calls)) || /InstanceOnPoints/.test(types);
        case "handheld-device":
          return /import_device/.test(calls) && (f.moves ?? []).includes("handheld");
        default:
          return nativeSetup;
      }
    });
    add(
      "implementation",
      fittingProductionRecipe || nativeFit,
      "Task-specific effect is implemented by a suitable validated recipe or concrete native setup",
    );
    add(
      "implementation",
      nativeSetup || validProductionRecipe,
      "Runnable native scene construction or validated production recipe, not inspection alone",
    );
    add(
      "references",
      recipeUses.length > 0 || assetIds.size > 0 || extensionIds.size > 0 || nativeSetup,
      "References a verifiable capability or supplies concrete native construction",
    );
    add(
      "determinism",
      plan.execution.frames[1]! >= plan.execution.frames[0]! && plan.determinism.seed >= 0,
      "Ordered concrete frames and non-negative seed",
    );
    add(
      "determinism",
      /pixel/i.test(plan.determinism.pixelCheck) &&
        /alone|isolated|individual|single|independen/i.test(plan.determinism.pixelCheck) &&
        /range|sequence|within frames|within\s+\d|inside\s+\d/i.test(plan.determinism.pixelCheck),
      "Plans a decoded-pixel frame-alone/range comparison",
    );
    const renderCommands = production.filter(
      (c) => ["blender:run", "blender:recipe"].includes(c.alias) && !c.values["no-render"] && c.action !== "bake",
    );
    add(
      "specificity",
      renderCommands.length > 0 &&
        renderCommands.some((c) => c.values.frames === `${plan.execution.frames[0]}-${plan.execution.frames[1]}`) &&
        renderCommands.every((c) => {
          const range = String(c.values.frames ?? "")
            .split("-")
            .map(Number);
          return (
            range.length === 2 &&
            range[0]! >= plan.execution.frames[0]! &&
            range[1]! <= plan.execution.frames[1]! &&
            range[1]! >= range[0]!
          );
        }),
      "A full concrete render range and valid contained still/proof subranges appear in commands",
    );
    add(
      "specificity",
      recipeUses.some(
        (r) =>
          !!r.params && typeof r.params === "object" && "seed" in r.params && r.params.seed === plan.determinism.seed,
      ) || facts.some((f) => f.seedValues?.includes(plan.determinism.seed)),
      "Seed is present in actual Python/recipe parameters",
    );
    add(
      "specificity",
      facts.some((f) => f.lenses?.includes(plan.execution.lensMm)) &&
        facts.some(
          (f) =>
            f.temperatures?.includes(plan.execution.temperatureK) || f.presets?.includes(plan.execution.lightPreset),
        ) &&
        (plan.execution.cameraMove === "locked" ||
          facts.some((f) => f.moves?.includes(plan.execution.cameraMove) || f.moves?.includes("keyed"))),
      "Lens and lighting are implemented in scene code, not only declared",
    );
    add(
      "specificity",
      plan.execution.materials.every(
        (m) =>
          !!m.assetId ||
          facts.some(
            (f) =>
              f.materials?.some((v) => v.input === "Roughness" && v.value === m.roughness) &&
              f.materials?.some((v) => v.input === "Metallic" && v.value === m.metallic),
          ),
      ),
      "Material ids or shader values appear in implementation",
    );
    for (const command of commands) {
      const downloading =
        ["add", "import", "fetch", "trial", "acquire"].includes(command.action) ||
        /^(?:fetch:|generate:|media:fetch$|asset:fetch)/.test(command.alias) ||
        (command.alias === "assets:sync" && command.values.check !== true);
      add(
        "safety",
        !downloading || ["after-consent", "after-approval"].includes(command.phase),
        `${command.alias}/${command.action}: acquisitions require a conditional consent phase`,
      );
      if (command.values.consent !== undefined)
        add(
          "safety",
          /^\$[A-Z][A-Z0-9_]*$/.test(String(command.values.consent)),
          "Consent remains an owner-supplied variable",
        );
    }
    const ccby =
      task.expected.requiresCredit ||
      [...assetIds].some((id) => /CC-BY/.test(inventory.assets.find((a) => a.id === id)?.licence ?? ""));
    add(
      "safety",
      !ccby ||
        (plan.credits.required &&
          plan.credits.lines.some((line) => /CC[ -]BY/.test(line) && /author|creator|https?:/i.test(line))),
      "CC-BY use retains creator/source/licence credit",
    );
    add(
      "safety",
      plan.builtIn.comparison.length > 20 && plan.choices.some((c) => c.kind === "builtin" || c.kind === "recipe"),
      "Explicit native/recipe alternative before external dependencies",
    );
  }
  for (const [category, maximum] of Object.entries(EXECUTION_WEIGHTS) as [Category, number][]) {
    const entries = evidence.get(category) ?? [],
      passed = entries.filter((e) => e.pass).length;
    const points = !error && entries.length ? Math.round(((maximum * passed) / entries.length) * 100) / 100 : 0;
    checks.push({
      criterion: category,
      pass: !error && entries.length > 0 && passed === entries.length,
      points,
      maximum,
      reason:
        entries
          .filter((e) => !e.pass)
          .map((e) => e.reason)
          .join("; ") ||
        (error ?? "All static checks passed"),
    });
  }
  return {
    id: task.id,
    sample,
    score: Math.round(checks.reduce((sum, c) => sum + c.points, 0) * 100) / 100,
    maximum: 100 as const,
    checks,
    findings,
    error,
  };
}

export function distribution(values: number[]) {
  const mean = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  return {
    mean,
    sd: values.length ? Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length) : 0,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    n: values.length,
  };
}
