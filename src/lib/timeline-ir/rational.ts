import type { Rational } from "../../types/timeline";
export function fraction(num: number | bigint, den: number | bigint = 1): Rational {
  let a = BigInt(num),
    b = BigInt(den);
  if (b === 0n) throw new Error("Zero denominator");
  if (b < 0n) {
    a = -a;
    b = -b;
  }
  const gcd = (x: bigint, y: bigint): bigint => (y === 0n ? (x < 0n ? -x : x) : gcd(y, x % y));
  const divisor = gcd(a, b);
  a /= divisor;
  b /= divisor;
  if (a > BigInt(Number.MAX_SAFE_INTEGER) || a < BigInt(Number.MIN_SAFE_INTEGER) || b > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Rational exceeds safe integer limits");
  return { num: Number(a), den: Number(b) };
}
export const add = (a: Rational, b: Rational) =>
  fraction(BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den), BigInt(a.den) * BigInt(b.den));
export const sub = (a: Rational, b: Rational) => add(a, { num: -b.num, den: b.den });
export const mul = (a: Rational, b: Rational) => fraction(BigInt(a.num) * BigInt(b.num), BigInt(a.den) * BigInt(b.den));
export const div = (a: Rational, b: Rational) => fraction(BigInt(a.num) * BigInt(b.den), BigInt(a.den) * BigInt(b.num));
export const compare = (a: Rational, b: Rational) =>
  Math.sign(Number(BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den)));
export const numeric = (a: Rational) => a.num / a.den;
