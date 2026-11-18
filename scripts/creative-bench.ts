/**
 * Creative benchmark outside the chain (docs/creative-benchmark.md): merge two runs' round-1 idea pools into one blind
 * pool, write fresh judges' briefs from the older run's issued director brief, and analyse the judges per run.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import {
  BenchRefusal,
  analyseDir,
  benchFiles,
  judgeBriefs,
  mergePools,
  roundOnePool,
  writeMerge,
} from "../src/lib/film/bench";

const refusals = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof BenchRefusal) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
};

void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      required: true,
      choices: ["merge", "brief", "analyse"],
      description: "merge two runs' round-1 pools, write judge briefs, or analyse the judges",
    },
    { name: "runs", description: "merge: the two projects, older first, comma-separated" },
    { name: "kind", default: "ideas", description: "merge: ideas (the only kind benchmarked)" },
    { name: "seed", description: "merge: shuffle seed" },
    { name: "out", description: "merge: a new directory for pool.json and key.json" },
    { name: "project", description: "brief: the older run, whose issued director brief and strategy the judges get" },
    { name: "pool", description: "brief: the merged pool.json" },
    { name: "judges", default: "3", description: "brief: how many fresh judges" },
    { name: "dir", description: "analyse: the merge directory holding key.json and judge-<n>.json" },
  ] as const);
  const relative = (file: string) => path.relative(process.cwd(), file);
  const need = (name: string, value: string | undefined): string => {
    if (!value)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--action ${args.action} needs --${name}.` });
    return value;
  };
  if (args.action === "merge") {
    if (args.kind !== "ideas")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--kind must be ideas, not ${args.kind}.` });
    const runs = need("runs", args.runs)
      .split(",")
      .map((run) => run.trim())
      .filter(Boolean);
    const seed = need("seed", args.seed);
    const out = path.resolve(need("out", args.out));
    const result = refusals(() =>
      mergePools(
        runs.map((run) => ({ run, pool: roundOnePool(openExistingFilm(run).projectDir).pool })),
        seed,
      ),
    );
    const written = refusals(() => writeMerge(out, result));
    const perRun = Object.fromEntries(
      result.key.runs.map((run) => [run, result.key.entries.filter((entry) => entry.run === run).length]),
    );
    return {
      outputs: written.map(relative),
      metadata: {
        items: result.pool.items.length,
        perRun,
        seed,
        oneRunKeys: result.key.stripped.oneRunKeys,
        residualMethodWords: result.residual,
        next: `pnpm creative:bench --action brief --project ${runs[0]} --pool ${relative(benchFiles(out).pool)} --judges 3`,
      },
    };
  }
  if (args.action === "brief") {
    const project = openExistingFilm(need("project", args.project));
    const briefs = refusals(() =>
      judgeBriefs({
        rootDir: process.cwd(),
        projectDir: project.projectDir,
        poolPath: need("pool", args.pool),
        judges: Number(args.judges),
      }),
    );
    for (const brief of briefs) writeFileSync(brief.file, brief.text);
    return {
      outputs: briefs.map((brief) => relative(brief.file)),
      metadata: {
        project: project.id,
        judges: briefs.length,
        dispatch: "one fresh creative-director per brief, each passed its judge-<n>.md unchanged",
        next: `pnpm creative:bench --action analyse --dir ${relative(path.dirname(briefs[0]!.file))}`,
      },
    };
  }
  const dir = path.resolve(need("dir", args.dir));
  const result = refusals(() => analyseDir(dir));
  return { outputs: [relative(benchFiles(dir).analysis)], metadata: result };
});
