/**
 * Prefilled words (RFC 0004 D10): each decision's text field starts with an editable phrase for the chosen action, in
 * the UI language. Submitting it unchanged is the user's own act. Option labels and titles come from the server and are
 * not translated; known option ids get the dictionary's label.
 */
import type { Decision, DecisionOptionSchema } from "@contract";
import type { z } from "zod";
import { format, type Dictionary } from "@/i18n";

type Option = z.infer<typeof DecisionOptionSchema>;
type KnownOption = keyof Dictionary["decision"]["options"];

const KNOWN = ["approve", "reject", "change", "not-now"] as const satisfies readonly KnownOption[];

export function isKnownOption(id: string): id is KnownOption {
  return (KNOWN as readonly string[]).includes(id);
}

/** Interface label of an option: the dictionary's for known ids, the server's otherwise. */
export function optionLabel(d: Dictionary, option: Pick<Option, "id" | "label">): string {
  return isKnownOption(option.id) ? d.decision.options[option.id] : option.label;
}

/** The phrase prefilled for an option of a decision. */
export function prefilledPhrase(
  d: Dictionary,
  decision: Pick<Decision, "title" | "kind">,
  option?: Pick<Option, "id" | "label">,
): string {
  const phrases = d.decision.phrases;
  if (!option) return format(phrases.default, { label: d.decision.kinds[decision.kind], title: decision.title });
  if (isKnownOption(option.id)) return format(phrases[option.id], { title: decision.title });
  if (decision.kind === "choice") return format(phrases.choose, { label: option.label });
  return format(phrases.default, { label: option.label, title: decision.title });
}

/** The option `a` approves with: `approve`, else the first option. */
export function approveOption<T extends Pick<Option, "id">>(options: readonly T[]): T | undefined {
  return options.find((option) => option.id === "approve") ?? options[0];
}

/** The option `r` rejects with: `reject`, `change` or `not-now`, in that order. */
export function rejectOption<T extends Pick<Option, "id">>(options: readonly T[]): T | undefined {
  for (const id of ["reject", "change", "not-now"]) {
    const found = options.find((option) => option.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Signature of what a decision is bound to; a different one means the material changed (stale, FR3). */
export function bindingSignature(decision: Pick<Decision, "bindTo" | "quote">): string {
  return [
    ...decision.bindTo.map((binding) => `${binding.path}@${binding.sha256}`),
    decision.quote?.quoteHash ?? "",
  ].join("|");
}

/**
 * Everything an approval is about: the bound files, the quote (hash and amounts) and each option's exact command. The
 * decision card snapshots what the user reviewed; when the live decision's signature differs, the card is stale and
 * refuses to send until the user reloads it (FR3).
 */
export function reviewSignature(decision: Pick<Decision, "bindTo" | "quote" | "options">): string {
  return JSON.stringify([
    bindingSignature(decision),
    decision.quote ?? null,
    (decision.options ?? []).map((option) => [option.id, option.argv, option.consequential ?? false]),
  ]);
}
