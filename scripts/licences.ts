import { parseArgs, CliErrorObject } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { writeLicenceInventory } from "../src/lib/contrib/licences";
import { LICENCE_REVIEW_REPORT } from "../src/lib/contrib/licence-review";

void runOffline(async () => {
  const args = parseArgs([
    {
      name: "write",
      type: "boolean",
      description:
        "Collect locked package licences and declared integrations into DEPENDENCY_LICENCES.json and .md; no network or approval",
    },
    {
      name: "check",
      type: "boolean",
      description:
        "Verify the committed inventory matches the lockfile, policy and evidence; read-only, portable across platforms",
    },
    {
      name: "strict",
      type: "boolean",
      description:
        "Also fail for unresolved package policy or missing licence texts; does not certify external integration rights",
    },
    {
      name: "scope",
      default: "package-policy",
      description:
        "package-policy (default), or repository-source for exact-version reviewed source-only distribution; never binary/bundle clearance",
    },
  ] as const);
  if (args.write && args.check)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose --write or --check" });
  const check = !args.write;
  if (args.scope !== "package-policy" && args.scope !== "repository-source")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Scope must be package-policy or repository-source" });
  const metadata = writeLicenceInventory(process.cwd(), check, args.strict, args.scope);
  return {
    outputs: check
      ? []
      : [
          "DEPENDENCY_LICENCES.json",
          "DEPENDENCY_LICENCES.md",
          ...(metadata.reviewedPackages ? [LICENCE_REVIEW_REPORT] : []),
        ],
    metadata,
  };
});
