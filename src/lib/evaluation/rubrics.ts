import type { WorkflowKind } from "../workflows/dispatch";
export const CRAFT_RUBRIC_VERSION = 1;
export interface CraftCriterion {
  id: string;
  question: string;
  kind: "technical" | "creative";
}
const contract: CraftCriterion = {
  id: "workflow-contract",
  kind: "technical",
  question: "Do the existing read-only workflow validators accept the exact request and original source pins?",
};
const decisions: CraftCriterion = {
  id: "decision-evidence",
  kind: "technical",
  question:
    "Are decisions recorded for every creative criterion with pinned evidence, observations, rationale and unresolved assumptions?",
};
const delivery: CraftCriterion = {
  id: "delivery-evidence",
  kind: "technical",
  question:
    "If delivery evidence is supplied, is the package complete and free of imported blocking findings with exact config/output bindings?",
};
const human = (id: string, question: string): CraftCriterion => ({ id, question, kind: "creative" });
export const CRAFT_RUBRICS: Record<WorkflowKind, readonly CraftCriterion[]> = {
  "product-ad": [
    contract,
    decisions,
    delivery,
    human(
      "promise-payoff",
      "Does the opening promise pay off in the supplied demonstration without unsupported testimonial or claim?",
    ),
    human(
      "product-proof",
      "Are approved product identity, readable proof, interaction coverage and the real visible outcome preserved?",
    ),
    human(
      "cta-rhythm",
      "Is the CTA legible and destination correct, with motivated pacing, clear speech and purposeful sound?",
    ),
  ],
  education: [
    contract,
    decisions,
    delivery,
    human(
      "factual-context",
      "Are sources, assumptions, uncertainty and qualifications preserved rather than presented as invented facts?",
    ),
    human(
      "learning-progression",
      "Can this audience follow the prerequisite, question, mechanism, worked example, application and recap?",
    ),
    human(
      "explanation-readability",
      "Are spoken cadence, diagrams, bilingual captions and chapter transitions readable and motivated?",
    ),
  ],
  "recording-edit": [
    contract,
    decisions,
    delivery,
    human("meaning-context", "Does before/after speech preserve negations, caveats, attribution and adjacent context?"),
    human(
      "source-continuity",
      "Do picture, authentic speech and captions stay synchronized across source cuts without unrelated ripple?",
    ),
    human(
      "edit-purpose",
      "Do removals improve the intended story without changing meaning, and can edits be reversed?",
    ),
  ],
  "shorts-series": [
    contract,
    decisions,
    delivery,
    human("standalone-context", "Does each short retain the context and qualifications necessary to stand alone?"),
    human("series-consistency", "Are approved source, brand/entity pins and independent episode identity consistent?"),
    human(
      "hook-selection",
      "Does the selected opening earn its payoff with readable framing and sound, without claiming predicted virality?",
    ),
  ],
};
