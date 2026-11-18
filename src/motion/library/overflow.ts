/**
 * Declares that a layer's text crosses the stage or the safe zone by design on this frame: a giant word that starts
 * wider than the frame, a punch-in that crops an interface, a shot pushed through the frame into a cut. motion:check
 * reports such text under `intendedOverflow` instead of counting TEXT_OFF_STAGE or TEXT_OUTSIDE_SAFE_ZONE. Pass
 * `active` only for the frames the documented overflow lasts, so the same text resting off stage later still fails.
 */
export const intendedOverflow = (active: boolean, reason: string): { "data-overflow"?: string } =>
  active ? { "data-overflow": reason } : {};
