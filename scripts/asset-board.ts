import { runScript, parseArgs } from "../src/lib/cli";
import { createAssetBoard } from "../src/lib/entities/board";
void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID for local asset/entity board" },
  ] as const);
  const board = createAssetBoard(args.project!);
  return { outputs: [board.file], metadata: board };
});
