/**
 * Which service keys are set (never their values), and which goals they unlock:
 * the answer to "what keys do I need for this?". Read-only.
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { formatKeys, goalStatuses, keyStatuses, parseGoals, SETUP_GOALS } from "../src/lib/setup/keys";

runScript(async () => {
  const args = parseArgs([
    {
      name: "goal",
      description: `Comma-separated goals to answer for: ${SETUP_GOALS.map((goal) => goal.id).join(", ")}`,
    },
  ] as const);
  let only;
  try {
    only = parseGoals(args.goal);
  } catch (error) {
    throw new CliErrorObject({ code: "INVALID_INPUT", message: (error as Error).message });
  }
  const keys = keyStatuses();
  const goals = goalStatuses(keys, only);
  process.stderr.write(formatKeys(keys, goals));
  return {
    metadata: {
      keys: keys.map(({ name, service, cost, state, signup, goals: serves }) => ({
        name,
        service,
        cost,
        state,
        signup,
        goals: serves,
      })),
      goals,
    },
  };
});
