import path from "node:path";
import { parseArgs, runScript } from "../src/lib/cli";
import { writeJsonAtomic } from "../src/lib/film/evidence";
import { buildCorpus, CORPUS_FILE } from "../src/lib/reference/corpus";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";

const SPECS = [
  {
    name: "library-root",
    default: DEFAULT_LIBRARY_ROOT,
    description:
      "Library directory; every sub-directory with a source.json is read, except inbox and names starting with _",
  },
  { name: "exclude", description: "Comma-separated reference ids to leave out" },
  {
    name: "playbook",
    description: "Only references whose source.json playbooks lists this id (tag with ref:add --playbooks)",
  },
  { name: "output", description: `Output JSON path; defaults to <library-root>/${CORPUS_FILE}` },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const libraryRoot = args["library-root"]!;
  const corpus = buildCorpus({
    libraryRoot,
    exclude: args.exclude?.split(",") ?? [],
    playbook: args.playbook?.trim() || undefined,
  });
  const output = writeJsonAtomic(args.output ?? path.join(libraryRoot, CORPUS_FILE), corpus);
  const functions = Object.fromEntries(
    Object.entries(corpus.techniques.byFunction).map(([key, entries]) => [key, entries.length]),
  );
  return {
    outputs: [output],
    metadata: {
      references: corpus.referenceIds.length,
      referenceIds: corpus.referenceIds,
      metrics: Object.fromEntries(
        Object.entries(corpus.metrics).map(([key, row]) => [
          key,
          { n: row.n, median: row.median, p25: row.p25, p75: row.p75 },
        ]),
      ),
      techniques: corpus.techniques.count,
      techniquesByFunction: functions,
      missingPrimitives: corpus.gaps.missingPrimitives.length,
      invalidLayers: corpus.references.reduce((sum, row) => sum + row.invalid.length, 0),
      warnings: corpus.warnings,
      apiCalls: 0,
    },
  };
});
