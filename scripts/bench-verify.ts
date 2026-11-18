import { parseArgs, runScript } from "../src/lib/cli";
import { verifyBundle } from "../src/lib/bench/sign";
void runScript(async () => {
  const args = parseArgs([
    { name: "bundle", required: true, description: "Signed bundle directory" },
    { name: "allowed-signers", description: "Trusted local SSH allowed_signers file" },
    { name: "github-user", description: "GitHub handle whose registered SSH keys should verify the bundle" },
    { name: "online", type: "boolean", description: "Explicitly permit fetching https://github.com/<handle>.keys" },
    { name: "suite", description: "Pinned suite manifest (default bench/suite.json)" },
  ] as const);
  return {
    metadata: await verifyBundle({
      root: process.cwd(),
      bundle: args.bundle!,
      allowedSigners: args["allowed-signers"],
      githubUser: args["github-user"],
      online: args.online,
      suite: args.suite,
    }),
  };
});
