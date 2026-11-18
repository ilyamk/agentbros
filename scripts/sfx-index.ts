import { writeFileSync } from "node:fs";
import path from "node:path";
import { ensureFfmpeg, parseArgs, runScript } from "../src/lib/cli";
import {
  buildSfxMeasureIndex,
  projectSfxDirs,
  SFX_INDEX_FILE,
  SHARED_SFX_DIR,
  type SfxIndex,
} from "../src/lib/audio/sfx-index";
import {
  CLAP_MODEL,
  readClapStore,
  runClap,
  SFX_CLAP_FILE,
  SFX_LABELS,
  sfxTagsFromScores,
} from "../src/lib/audio/sfx-clap";

const SPECS = [
  { name: "dir", default: SHARED_SFX_DIR, description: "Sound directory to index recursively (under public/)" },
  {
    name: "projects",
    type: "boolean",
    description: "Also index every project's sfx/ and assets/sfx/ into public/projects/<id>/sfx-index.json",
  },
  {
    name: "clap",
    type: "boolean",
    description: "Also embed with the local CLAP model and write auto-tags (first run downloads ~0.7 GB)",
  },
  { name: "clap-model", default: CLAP_MODEL, description: "Hugging Face CLAP model id" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  const publicDir = path.resolve("public");
  const shared = path.resolve(SHARED_SFX_DIR);
  const targets = [{ dir: path.resolve(args.dir!), output: path.join(path.resolve(args.dir!), SFX_INDEX_FILE) }];
  if (args.projects)
    for (const item of projectSfxDirs(path.resolve("public/projects")))
      targets.push({ dir: item.dir, output: path.join(publicDir, "projects", item.project, SFX_INDEX_FILE) });
  const reports = [];
  for (const target of targets) {
    process.stderr.write(`Measuring ${path.relative(process.cwd(), target.dir)}\n`);
    const result = buildSfxMeasureIndex({
      dir: target.dir,
      output: target.output,
      publicDir,
      provenanceRoot: target.dir.startsWith(shared) ? shared : target.dir,
    });
    let clapped = 0;
    if (args.clap) clapped = embedIndex(result.index, target.output, args["clap-model"]!, publicDir);
    const byKind: Record<string, number> = {};
    const byDynamics: Record<string, number> = {};
    for (const entry of result.index.entries) {
      byKind[entry.kind ?? "unsorted"] = (byKind[entry.kind ?? "unsorted"] ?? 0) + 1;
      if (entry.measured) byDynamics[entry.measured.dynamics] = (byDynamics[entry.measured.dynamics] ?? 0) + 1;
    }
    reports.push({
      index: path.relative(process.cwd(), target.output),
      files: result.index.entries.length,
      measured: result.measured,
      reused: result.reused,
      clapped,
      byKind,
      byDynamics,
      errors: result.errors,
    });
  }
  return {
    outputs: reports.map((report) => report.index),
    metadata: {
      reports,
      notice: "Measurements and CLAP tags are proxies: agents cannot hear. Audition before delivery.",
      apiCalls: 0,
    },
  };
});

/** Embeds entries without a vector, stores vectors beside the index and writes tags into it. */
function embedIndex(index: SfxIndex, output: string, model: string, publicDir: string): number {
  const storeFile = path.join(path.dirname(output), SFX_CLAP_FILE);
  const previous = readClapStore(storeFile);
  const store =
    previous && previous.model === model
      ? previous
      : { schemaVersion: 1 as const, model, dims: 0, vectors: {} as Record<string, string> };
  const todo = index.entries.filter((entry) => entry.measured && (!store.vectors[entry.sha256] || !entry.clap));
  if (todo.length) {
    process.stderr.write(`CLAP: embedding ${todo.length} files with ${model}\n`);
    const result = runClap({ audio: todo.map((entry) => path.join(publicDir, entry.file)), labels: SFX_LABELS, model });
    store.dims = result.dims;
    for (const entry of todo) {
      const item = result.audio[path.join(publicDir, entry.file)];
      if (!item?.embedding || !item.labelScores) continue;
      store.vectors[entry.sha256] = item.embedding;
      entry.clap = sfxTagsFromScores(item.labelScores);
    }
  }
  const live = new Set(index.entries.map((entry) => entry.sha256));
  store.vectors = Object.fromEntries(
    Object.entries(store.vectors)
      .filter(([sha]) => live.has(sha))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  index.clapModel = model;
  writeFileSync(storeFile, `${JSON.stringify(store)}\n`);
  writeFileSync(output, `${JSON.stringify(index, null, 1)}\n`);
  return todo.length;
}
