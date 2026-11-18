export function splitHiggsfieldKey(value: string | undefined): { id: string; secret: string } | undefined {
  const colon = value?.indexOf(":") ?? -1;
  if (!value || colon < 1 || !value.slice(0, colon).trim() || !value.slice(colon + 1).trim() || /[\r\n]/.test(value))
    return undefined;
  return { id: value.slice(0, colon), secret: value.slice(colon + 1) };
}
