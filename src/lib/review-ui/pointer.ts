import type { EditCommand, Rational } from "../../types/timeline";

/** Pure, self-contained function also serialized into the offline browser client.
 * Geometry snaps output deltas; exact rational clocks map them to source frames.
 * This proposes commands only. Store dry-run/CAS remains the edit authority.
 */
export function pointerProposal(input: {
  mode: "move" | "start" | "end";
  deltaPx: number;
  laneWidth: number;
  durationInFrames: number;
  timebase: Rational;
  trackId: string;
  targetTrackId?: string;
  clip: {
    id: string;
    start: Rational;
    end: Rational;
    source: { start: Rational; end: Rational; timebase: Rational };
    rate: Rational;
  };
  previousEnd?: Rational;
  nextStart?: Rational;
}): EditCommand {
  const rational = (n: bigint, d = 1n): Rational => {
    if (d <= 0n) throw new Error("Invalid rational denominator");
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
    const g = gcd(n, d);
    n /= g;
    d /= g;
    if (
      n > BigInt(Number.MAX_SAFE_INTEGER) ||
      n < BigInt(Number.MIN_SAFE_INTEGER) ||
      d > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Pointer rational exceeds safe integer limits");
    return { num: Number(n), den: Number(d) };
  };
  const check = (v: Rational) => {
    if (!Number.isSafeInteger(v.num) || !Number.isSafeInteger(v.den) || v.den <= 0)
      throw new Error("Invalid rational clock");
    return v;
  };
  const add = (a: Rational, b: Rational) =>
    rational(BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den), BigInt(a.den) * BigInt(b.den));
  const sub = (a: Rational, b: Rational) => add(a, { num: -b.num, den: b.den });
  const mul = (a: Rational, b: Rational) => rational(BigInt(a.num) * BigInt(b.num), BigInt(a.den) * BigInt(b.den));
  const div = (a: Rational, b: Rational) => {
    if (b.num <= 0) throw new Error("Invalid positive clock");
    return rational(BigInt(a.num) * BigInt(b.den), BigInt(a.den) * BigInt(b.num));
  };
  const compare = (a: Rational, b: Rational) => {
    const n = BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den);
    return n < 0n ? -1 : n > 0n ? 1 : 0;
  };
  const clamp = (v: Rational, lo: Rational, hi: Rational) => {
    if (compare(lo, hi) > 0) throw new Error("No legal pointer interval");
    return compare(v, lo) < 0 ? lo : compare(v, hi) > 0 ? hi : v;
  };
  const round = (v: Rational) => {
    const n = BigInt(v.num),
      d = BigInt(v.den),
      absolute = n < 0n ? -n : n;
    const rounded = (absolute * 2n + d) / (d * 2n);
    return rational(n < 0n ? -rounded : rounded);
  };
  if (
    ![input.deltaPx, input.laneWidth, input.durationInFrames].every(Number.isFinite) ||
    input.laneWidth <= 0 ||
    !Number.isSafeInteger(input.durationInFrames) ||
    input.durationInFrames <= 0
  )
    throw new Error("Invalid pointer geometry");
  const c = input.clip;
  [
    c.start,
    c.end,
    c.source.start,
    c.source.end,
    c.source.timebase,
    c.rate,
    input.timebase,
    ...(input.previousEnd ? [input.previousEnd] : []),
    ...(input.nextStart ? [input.nextStart] : []),
  ].forEach(check);
  if (c.rate.num <= 0 || c.source.timebase.num <= 0 || input.timebase.num <= 0)
    throw new Error("Invalid positive clock");
  const pixels = Math.max(-input.laneWidth, Math.min(input.laneWidth, input.deltaPx));
  const delta = rational(BigInt(Math.round((pixels / input.laneWidth) * input.durationInFrames)));
  const binding = { trackId: input.trackId, clipId: c.id };
  if (input.mode === "move") {
    const span = sub(c.end, c.start);
    if (input.targetTrackId && input.targetTrackId !== input.trackId) {
      const start = clamp(add(c.start, delta), rational(0n), sub(rational(BigInt(input.durationInFrames)), span));
      return { type: "transfer", ...binding, targetTrackId: input.targetTrackId, start };
    }
    const start = clamp(
      add(c.start, delta),
      input.previousEnd ?? rational(0n),
      sub(input.nextStart ?? rational(BigInt(input.durationInFrames)), span),
    );
    if (compare(start, c.start) === 0) throw new Error("Pointer proposal makes no change");
    return { type: "move", ...binding, start };
  }
  const sourceSpan = sub(c.source.end, c.source.start);
  if (compare(sourceSpan, rational(1n)) <= 0) throw new Error("Clip is too short for inward frame trim");
  const sourceDelta = round(mul(mul(delta, c.rate), div(c.source.timebase, input.timebase)));
  if (input.mode === "start") {
    const start = clamp(add(c.source.start, sourceDelta), c.source.start, sub(c.source.end, rational(1n)));
    if (compare(start, c.source.start) === 0) throw new Error("Pointer proposal makes no change");
    const outputDelta = mul(div(sub(start, c.source.start), c.rate), div(input.timebase, c.source.timebase));
    return {
      type: "batch",
      commands: [
        { type: "trim", ...binding, start, end: c.source.end },
        { type: "move", ...binding, start: add(c.start, outputDelta) },
      ],
    };
  }
  if (input.mode !== "end") throw new Error("Unknown pointer mode");
  const end = clamp(add(c.source.end, sourceDelta), add(c.source.start, rational(1n)), c.source.end);
  if (compare(end, c.source.end) === 0) throw new Error("Pointer proposal makes no change");
  return { type: "trim", ...binding, start: c.source.start, end };
}
