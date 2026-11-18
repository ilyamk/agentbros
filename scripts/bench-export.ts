import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { exportBundle } from "../src/lib/bench/export";

void runOffline(async () => {
  const args = parseArgs([
    { name: "bundle", required: true, description: "Signed private original bundle" },
    { name: "out", required: true, description: "New public export directory" },
    { name: "key", required: true, description: "SSH private key for the new public manifest signature" },
    {
      name: "allowed-signers",
      required: true,
      description: "Trusted local allowed_signers file verifying the original",
    },
    { name: "suite", description: "Pinned suite for verifying the private original" },
  ] as const);
  return exportBundle({
    root: process.cwd(),
    bundle: args.bundle!,
    out: args.out!,
    key: args.key!,
    allowedSigners: args["allowed-signers"],
    suite: args.suite,
  });
});
