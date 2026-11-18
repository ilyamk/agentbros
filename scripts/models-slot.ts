import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { editModelSlot, SlotEditSchema } from "../src/lib/models/model-slots-maintenance";

runScript(async () => {
  const args = parseArgs([
    { name: "slot", required: true, description: "Slot id" },
    { name: "provider", choices: ["fal", "higgsfield"], description: "Candidate provider" },
    { name: "add", description: "Endpoint to add as active with owner evidence" },
    { name: "promote", description: "Proposed endpoint to activate" },
    { name: "retire", description: "Endpoint to retire" },
    { name: "move", type: "boolean", description: "Move --endpoint to an unused --order" },
    { name: "endpoint", description: "Endpoint for --move or --evidence-acceptance" },
    { name: "class", choices: ["hero", "balanced", "budget", "draft"], description: "Candidate class" },
    { name: "order", type: "number", description: "Unique order within slot" },
    { name: "why", description: "Reason to recommend" },
    {
      name: "evidence-acceptance",
      type: "boolean",
      description: "Record aggregate local first-pass verdict counts (no project names) for --endpoint",
    },
    { name: "evidence-owner", description: "Owner's verdict text" },
    { name: "accept-unverified", description: "--promote below verified tier: recorded reason" },
    { name: "review-by", description: "New review date YYYY-MM-DD" },
  ] as const);
  const actions = [
    args.add && "add",
    args.promote && "promote",
    args.retire && "retire",
    args.move && "move",
    args["evidence-acceptance"] && "evidence-acceptance",
    args["review-by"] && "review-by",
  ].filter(Boolean);
  if (actions.length !== 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose exactly one edit action" });
  const edit = SlotEditSchema.parse({
    slot: args.slot,
    action: actions[0],
    endpoint: args.add ?? args.promote ?? args.retire ?? args.endpoint,
    provider: args.provider,
    class: args.class,
    order: args.order,
    why: args.why,
    evidenceOwner: args["evidence-owner"],
    acceptUnverified: args["accept-unverified"],
    reviewBy: args["review-by"],
  });
  const file = editModelSlot(edit);
  return { metadata: { slot: file.slots.find((slot) => slot.id === args.slot) } };
});
