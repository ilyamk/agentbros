/** Test-only admission of genuine mounted renderer coordinates; no inferred offsets/scales. */
export type CopyBox = { x: number; y: number; width: number; height: number };
function box(value: CopyBox): CopyBox {
  if (
    !value ||
    ![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
    value.width <= 0 ||
    value.height <= 0
  )
    throw Error("Invalid copy canvas rectangle");
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
export function admitCopyCanvas(input: {
  expectedWidth: number;
  expectedHeight: number;
  canvasCount: number;
  markerConnected: boolean;
  markerInCanvas: boolean;
  canvas: CopyBox;
}): CopyBox {
  if (
    !Number.isSafeInteger(input.expectedWidth) ||
    !Number.isSafeInteger(input.expectedHeight) ||
    input.expectedWidth <= 0 ||
    input.expectedHeight <= 0
  )
    throw Error("Invalid declared composition dimensions");
  if (input.canvasCount !== 1 || !input.markerConnected || !input.markerInCanvas)
    throw Error("Copy probe requires one genuine mounted owning canvas");
  const canvas = box(input.canvas);
  if (canvas.width !== input.expectedWidth || canvas.height !== input.expectedHeight)
    throw Error("Copy canvas must match declared composition dimensions at scale1");
  return canvas;
}
export function copyBoxObservation(canvas: CopyBox, raw: CopyBox) {
  const owner = box(canvas),
    text = box(raw),
    relative = { ...text, x: text.x - owner.x, y: text.y - owner.y };
  return { canvas: owner, raw: text, relative };
}
export function relativeCopyBox(canvas: CopyBox, raw: CopyBox): CopyBox {
  const observation = copyBoxObservation(canvas, raw),
    relative = observation.relative,
    owner = observation.canvas;
  if (
    relative.x < 0 ||
    relative.y < 0 ||
    relative.x + relative.width > owner.width ||
    relative.y + relative.height > owner.height
  )
    throw Error("Copy rectangle exceeds full owning canvas: " + JSON.stringify(observation));
  return relative;
}
export function exactCopyFacesReady(
  expected: { family: string; weight: number; style: string }[],
  registered: { family: string; weight: string; style: string; status: string }[],
): boolean {
  if (!expected.length) throw Error("Explicit nonempty expected font manifest required");
  const counts = new Map<string, number>();
  for (const face of expected) {
    if (
      !face.family ||
      !Number.isSafeInteger(face.weight) ||
      face.weight < 1 ||
      face.weight > 1000 ||
      !["normal", "italic"].includes(face.style)
    )
      throw Error("Invalid expected exact font face");
    const key = JSON.stringify([face.family, String(face.weight), face.style]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].every(
    ([key, count]) =>
      registered.filter(
        (face) => face.status === "loaded" && JSON.stringify([face.family, face.weight, face.style]) === key,
      ).length >= count,
  );
}
/** Exact observations of measured geometry, not an epsilon or acceptance of fit. */
export function stableCopyObservation(previous: unknown, current: unknown): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(current);
}

export type CopyDiagnosticNumber = number | "NaN" | "Infinity" | "-Infinity";
export type CopyDiagnosticBox = {
  x: CopyDiagnosticNumber;
  y: CopyDiagnosticNumber;
  width: CopyDiagnosticNumber;
  height: CopyDiagnosticNumber;
};
function diagnosticNumber(value: number): CopyDiagnosticNumber {
  return Number.isNaN(value) ? "NaN" : value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : value;
}
/** Receipt only: never throws or repairs geometry, and never grants fit. */
export function copyDiagnosticObservation(canvas: CopyBox, raw: CopyBox) {
  const encode = (value: CopyBox): CopyDiagnosticBox => ({
    x: diagnosticNumber(value.x),
    y: diagnosticNumber(value.y),
    width: diagnosticNumber(value.width),
    height: diagnosticNumber(value.height),
  });
  return {
    canvas: encode(canvas),
    raw: encode(raw),
    relative: encode({ ...raw, x: raw.x - canvas.x, y: raw.y - canvas.y }),
    rectangleValidity:
      [raw.x, raw.y, raw.width, raw.height].every(Number.isFinite) && raw.width > 0 && raw.height > 0
        ? ("valid" as const)
        : ("invalid" as const),
  };
}
/** Preserve every nonfinite value in diagnostics, including nested fragment/clip observations. */
export function copyDiagnosticJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "number" ? diagnosticNumber(item) : item));
}
