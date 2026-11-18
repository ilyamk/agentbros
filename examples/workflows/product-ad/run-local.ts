import { readFileSync } from "node:fs";
import path from "node:path";
import { runScript, parseArgs, CliErrorObject } from "../../../src/lib/cli";
import { runProductAdWorkflow } from "../../../src/lib/workflows/product-ad";
runScript(async () => {
  const args = parseArgs([
    {
      name: "request",
      required: true,
    },
    {
      name: "action",
      default: "plan",
    },
    {
      name: "root",
      description: "Project workspace root",
    },
  ] as const);
  if (!["plan", "create"].includes(args.action!))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Action must be plan or create",
    });
  return runProductAdWorkflow(JSON.parse(readFileSync(args.request!, "utf8")), {
    action: args.action as "plan" | "create",
    rootDir: args.root ? path.resolve(args.root) : process.cwd(),
  });
});
