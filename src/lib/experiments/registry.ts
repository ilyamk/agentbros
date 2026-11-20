export const EXPERIMENTS = [
  {
    id: "tutorial-series-kit@1",
    status: "experimental",
    playbooks: ["content-series", "product-tutorial"],
    steps: ["look", "build", "sound"],
    instruction:
      "Read public/projects/<id>/pipeline/tutorial-series-kit.json. Apply its shared titles, caption profile, cursor colour and sound cues using the existing motion library. Author this episode’s actions, text and rhythm for its own task.",
  },
  {
    id: "tutorial-camera@1",
    status: "experimental",
    playbooks: ["product-tutorial"],
    steps: ["beat-sheet"],
    instruction:
      "Build an editable camera proposal with pnpm experiment --action camera --project <id> --input <request.json>. Map each capture event to its narrated word and, where known, the region to hold readable. Check both formats; hold, widen or frame manually where the proposal calls for it. Use the approved animatic for the final decisions.",
  },
  {
    id: "proof-scenes@1",
    status: "experimental",
    playbooks: ["product-promo", "explainer"],
    steps: ["render"],
    instruction:
      "Use the suggested proof scenes only where they serve the selected concept. Check the source for each proof, and choose the order and the hero composition for this film.",
  },
] as const;

export type Experiment = (typeof EXPERIMENTS)[number];
export type ExperimentId = Experiment["id"];

export function findExperiment(id: string): Experiment | undefined {
  return EXPERIMENTS.find((entry) => entry.id === id);
}
