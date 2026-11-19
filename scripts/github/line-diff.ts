/**
 * Line diff for a PR file whose patch GitHub omits (a large lockfile): Myers' O(ND) algorithm gives a minimal edit
 * script, so its added and deleted line counts are the ones git reports for the same pair of texts. The caller accepts
 * the reconstruction only when those counts equal GitHub's; anything else stays a file a human must review.
 */
export type LineDiff = { patch: string; additions: number; deletions: number };

// Each line keeps its terminator, so a last line without a newline differs from the same text with one, as in git.
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const shown = (line: string) => (line.endsWith("\n") ? line.slice(0, -1) : line);

/** Returns undefined when the edit distance exceeds `maxEdits` (the search would grow quadratic). */
export function lineDiff(before: string, after: string, maxEdits = 10000): LineDiff | undefined {
  const a = lines(before),
    b = lines(after);
  const n = a.length,
    m = b.length,
    max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  // Step d only reads diagonals -d..d of the previous step, so each saved step keeps that band: O(D²) memory, not O(N·D).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) return undefined;
  // Walk the trace back from (n, m) to collect the edit script, then emit it in order.
  const script: { kind: "+" | "-" | " "; text: string }[] = [];
  let x = n,
    y = m;
  for (let d = found; d > 0; d--) {
    const band = trace[d]!,
      prior = (diagonal: number) => band[diagonal + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && prior(k - 1) < prior(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = prior(previousK),
      previousY = previousX - previousK;
    while (x > previousX && y > previousY) (script.push({ kind: " ", text: a[--x]! }), y--);
    if (down) script.push({ kind: "+", text: b[--y]! });
    else script.push({ kind: "-", text: a[--x]! });
  }
  while (x > 0 && y > 0) (script.push({ kind: " ", text: a[--x]! }), y--);
  script.reverse();
  // Changed lines only, each run under its own hunk header (no context: the gate reads +/- lines).
  const out: string[] = [];
  let additions = 0,
    deletions = 0,
    oldLine = 1,
    newLine = 1;
  for (let i = 0; i < script.length;) {
    if (script[i]!.kind === " ") {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    let j = i;
    while (j < script.length && script[j]!.kind !== " ") j++;
    const run = script.slice(i, j);
    const removed = run.filter((line) => line.kind === "-").length,
      added = run.length - removed;
    out.push(`@@ -${oldLine},${removed} +${newLine},${added} @@`);
    for (const line of run) out.push(`${line.kind}${shown(line.text)}`);
    oldLine += removed;
    newLine += added;
    additions += added;
    deletions += removed;
    i = j;
  }
  return { patch: out.join("\n"), additions, deletions };
}
