import assert from "node:assert/strict";

export type FullHDFrameEvidence = {
  frame: number;
  fontsReady: boolean;
  findings: Array<{ code: string }>;
  measurements: Array<{
    text: string;
    role?: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
};

/** Validate final viewport measurements, never pre-mount/offscreen callbacks. */
export function assertFullHDFrameEvidence(evidence: FullHDFrameEvidence) {
  assert.equal(evidence.fontsReady, true);
  assert.deepEqual(evidence.findings, [], `Frame ${evidence.frame} QA defects`);
  const title = evidence.measurements.find((m) => m.role === "media-headline");
  assert.ok(title, `Frame ${evidence.frame} actual instructional headline missing`);
  const words = evidence.measurements.filter((m) => m.role === "spoken-caption");
  assert.ok(words.length > 0, `Frame ${evidence.frame} timed captions missing`);
  for (const word of words) {
    assert.ok(
      title.rect.y + title.rect.height <= word.rect.y || word.rect.y + word.rect.height <= title.rect.y,
      `Frame ${evidence.frame} instructional title collides with caption ${word.text}`,
    );
  }
}
