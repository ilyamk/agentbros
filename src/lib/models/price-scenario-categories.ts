import type { ModelSlot, ModelSlotsFile } from "../../types/model-slots";
import type { PriceScenario, PriceScenarios } from "../../types/price-matrix";

/**
 * Union the scenarios of every slot accepting this catalogue category, in scenario order.
 * A category no slot accepts (llm, json, workflow, worlds…) is compared on the `1-call` scenario only.
 */
export function scenariosForCategory(
  category: string,
  slots: readonly Pick<ModelSlot, "id" | "categories">[] | Pick<ModelSlotsFile, "slots">,
  scenarios: PriceScenarios,
): PriceScenario[] {
  const rows = "slots" in slots ? slots.slots : slots;
  const matching = rows.filter((slot) => slot.categories.includes(category as ModelSlot["categories"][number]));
  const ids = new Set(matching.flatMap((slot) => scenarios.slots[slot.id] ?? []));
  if (!matching.length) ids.add("1-call");
  return scenarios.scenarios.filter((scenario) => ids.has(scenario.id));
}
