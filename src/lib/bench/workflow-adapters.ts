import type { WorkflowScenario } from "../../types/workflow-evaluation";
import type { WorkflowObserver } from "./workflow-observer";
import { contractWorkflow, consumeRecording, consumeVoice, nativeWorkflow } from "./workflow-fixtures";
import { CAMPAIGN_WORKFLOW_SCENARIOS, contractCampaign } from "./workflow-campaign";
import { completionWorkflow, completionNative, providerRecovery } from "./workflow-completion";

export interface WorkflowAdapter {
  contract: (observer: WorkflowObserver) => Promise<{ outcome?: string; skip?: string }>;
  native?: (observer: WorkflowObserver) => Promise<{ outcome?: string; skip?: string }>;
  agent?: (observer: WorkflowObserver, children: readonly string[]) => Promise<string>;
}
const legacy = [
  "recording-shorts",
  "unsupported-language",
  "voice-draft",
  "translation-cues",
  "vision-crop",
  "audio-markers",
  "foundation-draft",
  "preparation-policy",
  "disabled-resource",
  "missing-language",
  "leaf-handoff",
  "bounded-recovery",
  "playbook-intake",
  "budget-boundary",
];
const completion = [
  "text-brief",
  "assistance-brief",
  "image-brief",
  "events-brief",
  "translation-localisation",
  "vision-timeline",
  "recording-delivery",
  "film-delivery",
];
const registry = new Map<string, WorkflowAdapter>(
  legacy.map((id) => [
    id,
    {
      contract: async (observer) => {
        const outcome = await contractWorkflow(observer);
        if (observer.scenario.version === 3 && id === "budget-boundary") await providerRecovery(observer);
        return { outcome };
      },
      native: nativeWorkflow,
      ...(["recording-shorts", "leaf-handoff", "voice-draft"].includes(id)
        ? {
            agent: (observer: WorkflowObserver, children: readonly string[]) =>
              id === "voice-draft" ? consumeVoice(observer) : consumeRecording(observer, "input.wav", true, children),
          }
        : {}),
    },
  ]),
);
for (const id of completion) registry.set(id, { contract: completionWorkflow, native: completionNative });

for (const id of CAMPAIGN_WORKFLOW_SCENARIOS)
  registry.set(id, { contract: async (observer) => ({ outcome: await contractCampaign(observer) }) });

export function workflowAdapter(scenario: WorkflowScenario): WorkflowAdapter | undefined {
  return registry.get(scenario.version === 3 ? scenario.oracle! : scenario.id);
}
