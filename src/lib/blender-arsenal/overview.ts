import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ExtensionsManifestSchema } from "../../types/blender-extensions";
import { assertPathWithin } from "../cli";
import { listExtensions } from "./extensions";
import { arsenalPaths, ASSET_KINDS } from "./paths";
import { CollectionSchema, IndexSchema, ManifestSchema } from "./libraries/schemas";
import { listRecipes } from "./recipes";
import { readGenerators } from "./generators";
import { RecipeProofSchema } from "./recipe-schema";
import { improvementGaps, improvementHistory } from "./improvements";

export type AuditProblem = { file: string; problem: string; fix: string };
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const jsonFiles = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();

/** No Blender, downloads, imports of candidates, index rebuild or preference writes. */
export function auditArsenal(root = process.cwd()) {
  const p = arsenalPaths(root),
    problems: AuditProblem[] = [];
  function check<T>(file: string, schema: z.ZodType<T>): T | undefined {
    try {
      assertPathWithin(root, file);
      return schema.parse(read(file));
    } catch (error) {
      problems.push({
        file: path.relative(root, file),
        problem: String(error),
        fix: "Repair the file against its strict Zod schema; do not remove approval evidence.",
      });
      return undefined;
    }
  }
  const extensions = check(p.extensionsManifest, ExtensionsManifestSchema);
  const libraries = check(p.librariesManifest, ManifestSchema);
  let generators: ReturnType<typeof readGenerators> = [];
  try {
    generators = readGenerators(root);
  } catch (error) {
    problems.push({
      file: "blender-arsenal/generators.json",
      problem: String(error),
      fix: "Repair the strict generator manifest.",
    });
  }
  const evaluation = (
    entry: { id: string; status: string; evaluation?: string; consent?: unknown; reason?: string },
    file: string,
  ) => {
    const add = (problem: string, fix: string) => problems.push({ file: `${file}#${entry.id}`, problem, fix });
    if (entry.status === "rejected" && !entry.reason?.trim())
      add("Rejected candidate has no reason", "Record the rejection reason and its evidence.");
    if (entry.status === "approved" && !entry.consent)
      add(
        "Approved candidate has no consent",
        "Record the owner's actual approval, or propose a status correction; never invent consent.",
      );
    if (!entry.evaluation) {
      if (entry.status === "approved")
        add(
          "Approved candidate has no evaluation",
          "Link a completed docs/blender-arsenal evaluation from the template.",
        );
      return;
    }
    try {
      const filePath = path.resolve(root, entry.evaluation);
      assertPathWithin(path.join(root, "docs/blender-arsenal"), filePath);
      const doc = readFileSync(filePath, "utf8");
      if (entry.status === "approved") {
        const verdict = /^## Verdict[ \t]*\r?\n([\s\S]*?)(?=\n## |(?![\s\S]))/m.exec(doc)?.[1]?.trim();
        if (!verdict || /^(?:pending|todo|tbd|\{\{)/i.test(verdict))
          add("Evaluation has no completed Verdict", "Complete the Verdict with the measured scope and limitations.");
        const results = /^## Trial results[ \t]*\r?\n([\s\S]*?)(?=\n## |(?![\s\S]))/m.exec(doc)?.[1] ?? "";
        if (!/\d/.test(results) || /^(?:pending|todo|tbd|\{\{)/i.test(results.trim()))
          add(
            "Evaluation has no trial numbers",
            "Record measured timing, counts or pixel results under ## Trial results, with commands and sample count.",
          );
      }
    } catch (error) {
      add(
        `Cannot read evaluation: ${String(error)}`,
        "Restore a repository-contained evaluation document at the referenced path.",
      );
    }
  };
  for (const entry of generators) evaluation(entry, "blender-arsenal/generators.json");
  for (const entry of extensions?.extensions ?? []) evaluation(entry, "blender-arsenal/extensions.json");
  for (const entry of libraries?.sources ?? []) evaluation(entry, "blender-arsenal/libraries.json");
  for (const entry of generators) {
    evaluation(entry, "blender-arsenal/generators.json");
    if (entry.install.sha256) {
      try {
        const source = path.resolve(root, entry.install.source);
        assertPathWithin(root, source);
        if (createHash("sha256").update(readFileSync(source)).digest("hex") !== entry.install.sha256)
          throw new Error("Procedural source SHA256 differs from generator pin");
      } catch (error) {
        problems.push({
          file: `blender-arsenal/generators.json#${entry.id}`,
          problem: String(error),
          fix: "Review source changes and update the version/hash pin together.",
        });
      }
    }
  }
  try {
    for (const name of jsonFiles(p.collections)) {
      const collection = check(path.join(p.collections, name), CollectionSchema);
      if (!collection) continue;
      if (collection.name !== name.slice(0, -5))
        problems.push({
          file: name,
          problem: "Collection name differs from filename",
          fix: "Use the collection name as its JSON filename.",
        });
      for (const id of collection.items)
        if (libraries && !libraries.sources.some((s) => id.startsWith(`${s.id}:`)))
          problems.push({
            file: name,
            problem: `Unknown collection source: ${id}`,
            fix: "Add an evaluated source or correct the source:asset id.",
          });
    }
  } catch (error) {
    problems.push({
      file: "blender-arsenal/collections",
      problem: String(error),
      fix: "Restore the collections directory.",
    });
  }
  try {
    for (const recipe of listRecipes(root)) {
      for (const id of recipe.requires?.generators ?? [])
        if (!generators.some((g) => g.id === id))
          problems.push({
            file: recipe.id,
            problem: `Unknown generator: ${id}`,
            fix: "Add an evaluated generator pin or correct META.requires.",
          });
      for (const id of recipe.requires?.extensions ?? [])
        if (!extensions?.extensions.some((e) => e.id === id))
          problems.push({
            file: recipe.id,
            problem: `Unknown extension: ${id}`,
            fix: "Add an evaluated extension pin or correct META.requires.",
          });
    }
  } catch (error) {
    problems.push({
      file: "scripts/blender/recipes",
      problem: String(error),
      fix: "Repair literal META, filename, intent docstring and typed parameter defaults.",
    });
  }
  try {
    improvementHistory(root);
  } catch (error) {
    problems.push({
      file: "blender-arsenal/improvements",
      problem: String(error),
      fix: "Repair the strict improvement log; preserve failed history and both-order evidence.",
    });
  }
  const git = spawnSync("git", ["ls-files", "-z", "--", "blender-arsenal/local"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (git.error || git.status !== 0)
    problems.push({
      file: ".git",
      problem: "Cannot check tracked local payloads",
      fix: "Run audit inside a git checkout with git available.",
    });
  else
    for (const file of git.stdout.split("\0").filter(Boolean))
      problems.push({
        file,
        problem: "Local payload is tracked",
        fix: "Remove this path from the git index; retain the local original and contribute only pins/code/evidence.",
      });
  return {
    pass: problems.length === 0,
    problems,
    counts: {
      extensions: extensions?.extensions.length ?? 0,
      sources: libraries?.sources.length ?? 0,
      generators: generators.length,
    },
  };
}

function cacheSize(directory: string): { bytes: number; files: number } {
  if (!existsSync(directory)) return { bytes: 0, files: 0 };
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`Symlink in bake cache: ${directory}`);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  return readdirSync(directory).reduce(
    (sum, name) => {
      const next = cacheSize(path.join(directory, name));
      return { bytes: sum.bytes + next.bytes, files: sum.files + next.files };
    },
    { bytes: 0, files: 0 },
  );
}

export function arsenalCandidates(root = process.cwd(), capability?: string) {
  const p = arsenalPaths(root),
    extensions = ExtensionsManifestSchema.parse(read(p.extensionsManifest)),
    libraries = ManifestSchema.parse(read(p.librariesManifest));
  const candidates = [
    ...extensions.extensions.map((e) => ({
      kind: "extension",
      id: e.id,
      status: e.status,
      verdict: e.recommendation ?? "unmeasured",
      capabilities: e.capabilities ?? [],
      purpose: e.purpose,
      reason: e.reason ?? e.notes ?? "",
      evaluation: e.evaluation,
    })),
    ...improvementGaps(root).map((g) => ({
      kind: "gap",
      id: g.id,
      status: "unresolved",
      verdict: `severity ${g.severity}`,
      capabilities: g.capability ? [g.capability] : ([] as string[]),
      purpose: g.summary,
      reason: `severity ${g.severity}; ${g.occurrences} sightings`,
      evaluation: g.sources.join(", "),
    })),
    ...libraries.sources.map((s) => ({
      kind: "source",
      id: s.id,
      status: s.status,
      verdict: s.status,
      capabilities: [] as string[],
      purpose: s.name,
      reason: s.reason ?? s.notes,
      evaluation: s.evaluation ?? null,
    })),
    ...readGenerators(root).map((g) => ({
      kind: g.kind,
      id: g.id,
      status: g.status,
      verdict: g.verdict,
      capabilities: g.capabilities,
      purpose: g.purpose,
      reason: g.reason,
      evaluation: g.evaluation,
    })),
    ...(capability
      ? recipesOrEmpty(root).map((r) => ({
          kind: "recipe",
          id: r.id,
          status: r.status,
          purpose: r.intent,
          reason: r.needs_bake ? "Requires a cached bake" : "Frame-driven",
          evaluation: null,
          capabilities: r.capabilities ?? [],
          verdict: r.status,
        }))
      : []),
  ];
  return candidates
    .filter((e) => (capability ? e.capabilities.includes(capability) : e.status !== "approved"))
    .sort((a, b) => a.status.localeCompare(b.status) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export function arsenalStatus(root = process.cwd(), proofFile?: string) {
  const p = arsenalPaths(root),
    libraries = ManifestSchema.parse(read(p.librariesManifest));
  const assets = existsSync(p.libraryIndex) ? IndexSchema.parse(read(p.libraryIndex)).assets : [];
  const proof = proofFile ? RecipeProofSchema.parse(read(proofFile)) : null;
  const counts = (values: string[]) =>
    Object.fromEntries([...new Set(values)].sort().map((key) => [key, values.filter((v) => v === key).length]));
  const extensions = listExtensions(root).map((entry) =>
    "status" in entry
      ? {
          id: entry.id,
          name: entry.name,
          status: entry.status,
          version: entry.version,
          installedVersion: entry.installedVersion,
          drift: entry.drift,
          enableable: entry.enableable,
          evaluation: entry.evaluation,
        }
      : { ...entry, status: "unmanaged" },
  );
  const recipes = listRecipes(root).map((meta) => {
    const result = proof?.recipes.find((r) => r.id === meta.id);
    return {
      id: meta.id,
      status: result?.status ?? "unmeasured",
      needsBake: meta.needs_bake,
      costHint: meta.cost_hint,
      measuredCost: result
        ? {
            secondsPerFrame: result.secondsPerFrame ?? null,
            renderSecondsPerFrame: result.renderSecondsPerFrame ?? null,
            settings: proof!.settings,
            proof: proofFile,
          }
        : null,
    };
  });
  const collections = jsonFiles(p.collections).map((name) => {
    const collection = CollectionSchema.parse(read(path.join(p.collections, name)));
    const items = collection.items.map((id) => {
      const asset = assets.find((a) => a.id === id);
      const present = !!asset && asset.files.every((f) => existsSync(path.resolve(p.library, f.path)));
      const source = libraries.sources.find((s) => id.startsWith(`${s.id}:`));
      const command =
        source?.adapter === "bundled"
          ? "pnpm blender:assets --action index --bundled"
          : `pnpm blender:assets --action add --id ${id} --consent "$DOWNLOAD_CONSENT"`;
      return {
        id,
        present,
        sourceStatus: source?.status ?? "unknown",
        command,
        note:
          source?.adapter === "manual"
            ? "User downloads the pack, then use blender:assets --action import with --file/--source/--licence/--source-page/--consent."
            : "Run acquisition only after actual consent; source approval is separate.",
      };
    });
    return {
      name: collection.name,
      status: collection.status,
      present: items.filter((i) => i.present).length,
      missing: items.filter((i) => !i.present).length,
      items,
    };
  });
  return {
    generators: readGenerators(root),
    extensions: {
      byStatus: counts(extensions.map((e) => ("status" in e ? e.status : "unmanaged"))),
      entries: extensions,
    },
    library: {
      total: assets.length,
      byKind: Object.fromEntries(ASSET_KINDS.map((kind) => [kind, assets.filter((a) => a.kind === kind).length])),
      bySource: counts(assets.map((a) => a.source)),
      sources: libraries.sources.map((s) => ({ id: s.id, status: s.status })),
    },
    recipes,
    recipesByStatus: counts(recipes.map((r) => r.status)),
    collections,
    bakeCache: cacheSize(p.bakes),
    proofCommand: "pnpm blender:recipe proof --all --output out/qa/blender-recipes-RUN",
    indexCommand: "pnpm blender:assets --action index",
  };
}

/** Candidates stay readable in checkouts without recipes; `arsenalAudit` reports recipe errors. */
function recipesOrEmpty(root: string) {
  try {
    return listRecipes(root);
  } catch {
    return [];
  }
}
