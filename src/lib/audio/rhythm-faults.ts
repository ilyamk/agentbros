/** Diagnostic formatting has no authority to replace a preparation/retirement failure. */
export function rhythmFaultText(value: unknown) {
  try {
    return String(value).slice(0, 512);
  } catch {
    return "[unprintable rhythm failure]";
  }
}
