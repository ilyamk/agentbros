/**
 * The hash of what the user reviews in a decision (RFC 0004 FR3): every binding (path and sha256, sorted by path) and
 * the quote's hash. The projector puts it on each pending decision as `expect`; a request must send it back unchanged,
 * and the server compares it with the decision derived now. Pure: no file is read.
 */
import { createHash } from "node:crypto";
import type { Decision } from "../../types/console";

export function decisionExpect(decision: Pick<Decision, "bindTo" | "quote">): string {
  const bindings = [...decision.bindTo]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((binding) => `${binding.path}\t${binding.sha256}`);
  return createHash("sha256")
    .update(JSON.stringify({ bindings, quoteHash: decision.quote?.quoteHash ?? null }))
    .digest("hex");
}
