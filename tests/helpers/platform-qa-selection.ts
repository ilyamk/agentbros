import assert from "node:assert/strict";
import type { AbsolutePhase } from "./platform-handoff-lifecycle";
export interface QaSelectedComposition {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Record<string, unknown>;
}
const withoutQa = (props: Record<string, unknown>) => {
  const copy = { ...props };
  delete copy.qaEvidence;
  return copy;
};
/** Private test consumer: resolve metadata with opt-in before still rendering, never override resolved props. */
export async function selectQaComposition<P extends Record<string, unknown>, C extends QaSelectedComposition>(
  phase: AbsolutePhase,
  props: P,
  movie: C,
  select: (qaProps: P & { qaEvidence: true }) => Promise<C>,
) {
  const qaProps = { ...props, qaEvidence: true as const };
  const qaComposition = await phase.run("select QA composition", () => select(qaProps));
  assert.equal(qaComposition.props.qaEvidence, true, "Resolved QA metadata must enable production probe");
  for (const key of ["id", "width", "height", "fps", "durationInFrames"] as const)
    assert.equal(qaComposition[key], movie[key], `QA composition ${key} must match movie`);
  assert.deepEqual(
    withoutQa(qaComposition.props),
    withoutQa(movie.props),
    "Non-QA resolved canonical props must match movie",
  );
  return { qaProps, qaComposition };
}
