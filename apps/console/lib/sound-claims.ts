/** Agents cannot hear (RFC 0004 §2.2): the console never shows an agent claiming that something sounds good. */
import type { Decision } from "@contract";

/**
 * A claim that something sounds good (RFC 0004 §2.2): agents cannot hear, so the console never shows one. Matches the
 * common English phrasings; agent text in other languages is caught by {@link HEARING_STEPS} dropping the whole recommendation.
 */
const SOUND_CLAIM =
  /\b(sounds?|sounding|the (mix|music|track|voice|audio) (is|feels))\s+(really\s+|very\s+)?(good|great|fine|right|perfect|better|amazing|excellent|balanced|clean|nice)\b/i;

/** Steps whose decisions are about sound: an agent's recommendation there is never shown. */
const HEARING_STEPS = new Set(["music", "audio-map", "sound", "human"]);

export function isSoundClaim(text: string): boolean {
  return SOUND_CLAIM.test(text);
}

/**
 * The decision as a film panel shows it: without the agent's recommendation when the step is about sound or the text
 * claims something sounds good. The recommendation is not part of what an approval binds to (`reviewSignature`), so
 * dropping it never makes the card stale.
 */
export function withoutSoundClaims(decision: Decision): Decision {
  const recommendation = decision.recommendation;
  if (!recommendation) return decision;
  if (!HEARING_STEPS.has(decision.step ?? "") && !isSoundClaim(recommendation.text)) return decision;
  const { recommendation: _dropped, ...rest } = decision;
  return rest;
}
