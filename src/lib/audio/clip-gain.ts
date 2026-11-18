/** Optional attenuation never changes existing absolute volume/automation ownership. */
export function clipAudioGain(payload?: Record<string, unknown>): number {
  const gain = payload?.audioGain;
  if (gain === undefined) return 1;
  if (typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 || gain > 1)
    throw new Error("Invalid music/SFX clip audio gain");
  return gain;
}
export function attenuateAudio(payload: Record<string, unknown> | undefined, volume: number): number {
  return volume * clipAudioGain(payload);
}
