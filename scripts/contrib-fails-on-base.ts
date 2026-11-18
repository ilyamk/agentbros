import { CliErrorObject, parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { failsOnBase, proofBlocks } from "../src/lib/contrib/fails-on-base";

void runOffline(async () => {
  const args = parseArgs([
    { name: "base", required: true, description: "Base commit for the regression proof" },
    { name: "head", description: "Head revision to test (default HEAD)" },
    { name: "force", type: "boolean", description: "Require proof even outside the fix category" },
  ] as const);
  const proof = await failsOnBase({ root: process.cwd(), base: args.base!, head: args.head, force: args.force });
  if (proofBlocks(proof))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Failing-on-base proof: ${proof.outcome}`,
      details: { proof },
    });
  return { metadata: { proof } };
});
