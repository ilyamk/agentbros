import { parseArgs, runScript } from "../src/lib/cli";
import { loadModelSlots } from "../src/lib/models/model-slots";
import { modelStats } from "../src/lib/models/model-slots-project";

runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Project id" },
    {
      name: "propose",
      type: "boolean",
      description: "Propose acceptance evidence across all local projects; read-only",
    },
    { name: "all", type: "boolean", description: "Aggregate all local projects" },
  ] as const);
  const stats = modelStats(loadModelSlots(), {
    project: args.project,
    all: args.all || (args.propose && !args.project),
  });
  return {
    metadata: {
      stats,
      ...(args.propose
        ? {
            acceptanceProposals: stats
              .filter((row) => row.slot && row.accepted + row.rejected > 0)
              .map((row) => ({
                slot: row.slot,
                provider: row.provider,
                endpoint: row.endpoint,
                accepted: row.accepted,
                rejected: row.rejected,
                judged: row.accepted + row.rejected,
                firstPassAcceptance: row.firstPassAcceptance,
              })),
          }
        : {}),
      firstPassVerdict: "first recorded verdict per operation",
      costBasis: "actual receipt or latest ledger actual/estimate; unknown costs excluded from average",
    },
  };
});
