import { parseArgs, runScript } from "../src/lib/cli";
import { signBundle } from "../src/lib/bench/sign";
void runScript(async () => {
  const args = parseArgs([
    { name: "bundle", required: true, description: "Completed bundle directory" },
    {
      name: "key",
      required: true,
      description: "SSH private key; ssh-keygen signs the manifest in agentbros-bench namespace",
    },
  ] as const);
  return { outputs: [signBundle(args.bundle!, args.key!)], metadata: { namespace: "agentbros-bench" } };
});
