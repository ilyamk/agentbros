/** Reproducible technical demo only; substitute actual original recordings for production. */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { productAdFixture } from "../../../tests/workflow-product-ad-fixtures";
import { runScript, parseArgs, CliErrorObject } from "../../../src/lib/cli";
runScript(async () => {
  const args = parseArgs([
    {
      name: "directory",
      required: true,
      description: "New local synthetic example directory",
    },
  ] as const);
  const directory = path.resolve(args.directory!);
  if (existsSync(directory))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Synthetic example requires a new directory",
    });
  mkdirSync(directory, {
    recursive: true,
  });
  const request = productAdFixture(directory);
  const file = path.join(directory, "product-ad-request.json");
  writeFileSync(file, JSON.stringify(request, null, 2) + "\n");
  return {
    outputs: [file],
    metadata: {
      synthetic: true,
      productionReady: false,
      noServiceCalls: true,
      description:
        "Synthetic visual interaction, tone audio and declared technical captions only; replace original speech and reviewed product evidence for production",
    },
  };
});
