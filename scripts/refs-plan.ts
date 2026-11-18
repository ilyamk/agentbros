/**
 * pnpm refs:plan — reference requirements per shot in pipeline/references.json (RFC 0003 §6.3, §9). No spend.
 *   --action draft --shot S --material-item M --intent I (--family F | --endpoint E)
 *                  [--entity kind:id[@rev]]... [--asset role:sha256:<hex>]... [--chain-from SHOT] [--write]
 *                  proposes the shot's requirements; --write merges it into references.json, else a dry output
 *   --action check     validates references.json against profiles, cards, registry and media limits
 *   --action status    per shot: counts by status, open requirements with their commands, pack status
 *   --action board [--save]  the static board (no scripts) in metadata.html; --save (CLI only) writes
 *                  pipeline/references-board.html
 * --entity and --asset repeat or take comma-separated lists.
 */
import { existsSync, readFileSync } from "node:fs";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { takeRepeated } from "../src/lib/film/cli";
import {
  REFERENCES_FILE,
  checkReferencesPlan,
  draftShotReferences,
  mergeShot,
  parseAssetPicks,
  parseEntityPicks,
  planStatus,
  readReferencesPlan,
  referencesBoard,
  referencesFile,
  writeReferencesBoard,
  writeReferencesPlan,
} from "../src/lib/references/plan";
import { ShotReferenceIntentSchema } from "../src/types/references";

runScript(async () => {
  const entity = takeRepeated(process.argv.slice(2), "entity");
  const asset = takeRepeated(entity.rest, "asset");
  const args = parseArgs(
    [
      { name: "project", required: true, description: "Project id" },
      { name: "action", required: true, choices: ["draft", "check", "status", "board"], description: "What to do" },
      { name: "shot", description: "Shot id (draft)" },
      { name: "material-item", description: "material.json item id the shot makes (draft)" },
      { name: "intent", choices: ShotReferenceIntentSchema.options, description: "What the generation does (draft)" },
      { name: "family", description: "Reference profile family (draft)" },
      { name: "endpoint", description: "Exact endpoint id (draft); its profile is used" },
      { name: "chain-from", description: "Shot whose last frame opens this one (draft)" },
      {
        name: "entity",
        description: "Linked card kind:id[@rev] (draft); repeat or comma-separate (read before parsing)",
      },
      {
        name: "asset",
        description: "Imported source role:sha256:<hex> (draft); repeat or comma-separate (read before parsing)",
      },
      { name: "write", type: "boolean", description: "Merge the drafted shot into references.json" },
      { name: "save", type: "boolean", description: "Write the board to pipeline/references-board.html (CLI only)" },
    ] as const,
    asset.rest,
  );
  const projectId = args.project!;
  if (args.action === "draft") {
    for (const flag of ["shot", "material-item", "intent"] as const)
      if (!args[flag]) throw new CliErrorObject({ code: "INVALID_INPUT", message: `draft needs --${flag}.` });
    if (!args.family && !args.endpoint)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "draft needs --family or --endpoint." });
    const result = draftShotReferences({
      projectId,
      shotId: args.shot!,
      materialItemId: args["material-item"]!,
      intent: args.intent as (typeof ShotReferenceIntentSchema.options)[number],
      ...(args.family ? { family: args.family } : {}),
      ...(args.endpoint ? { endpoint: args.endpoint } : {}),
      entities: parseEntityPicks(entity.values),
      assets: parseAssetPicks(asset.values),
      ...(args["chain-from"] ? { chainFrom: args["chain-from"] } : {}),
    });
    if (!args.write) return { metadata: { written: false, ...result } };
    const file = writeReferencesPlan(projectId, mergeShot(readReferencesPlan(projectId), result.shot));
    return { outputs: [file], metadata: { written: true, ...result } };
  }
  if (args.action === "check") {
    const file = referencesFile(projectId);
    if (!existsSync(file))
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: `${REFERENCES_FILE} does not exist: pnpm refs:plan --project ${projectId} --action draft ... --write.`,
      });
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new CliErrorObject({ code: "VALIDATION", message: `${REFERENCES_FILE} is not JSON: ${String(error)}` });
    }
    const result = checkReferencesPlan(projectId, raw);
    if (!result.ok)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `${result.errors} reference plan error(s): ${result.findings
          .filter((item) => item.severity === "error")
          .map((item) => `[${item.code}] ${item.message}`)
          .slice(0, 5)
          .join(" ")}`,
        details: result,
      });
    return { metadata: result };
  }
  if (args.action === "status") return { metadata: planStatus(projectId) };
  if (!args.save) {
    const { html, file } = referencesBoard(projectId);
    return { metadata: { written: false, file, html } };
  }
  const board = writeReferencesBoard(projectId);
  return { outputs: [board], metadata: { written: true, board } };
});
