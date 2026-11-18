/**
 * ULIDs for journal events and run ids: 48-bit millisecond time and 80 random bits in Crockford base32, monotonic
 * within a process (a second id in the same millisecond increments the random part), so ids sort by time.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = "";
  let rest = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  return Array.from({ length: 16 }, (_, i) => bytes[i]! % 32);
}

/** Increments the base32 digits; on overflow (practically never) starts over with fresh randomness. */
function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]! += 1;
      return next;
    }
    next[i] = 0;
  }
  return freshRandom();
}

export function ulid(now: number = Date.now()): string {
  const time = Math.min(Math.max(0, Math.floor(now)), MAX_TIME);
  if (time <= lastTime) lastRandom = increment(lastRandom);
  else {
    lastTime = time;
    lastRandom = freshRandom();
  }
  return encodeTime(Math.max(time, lastTime)) + lastRandom.map((digit) => ALPHABET[digit]).join("");
}

/** The millisecond time a ULID encodes. */
export function ulidTime(id: string): number {
  let time = 0;
  for (const char of id.slice(0, 10).toUpperCase()) time = time * 32 + ALPHABET.indexOf(char);
  return time;
}
