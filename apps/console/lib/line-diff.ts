/**
 * A line diff for the history's version compare (RFC 0004 US17): Myers' O(ND) shortest edit script over lines, with
 * JSON normalised first (sorted keys, two-space indent) so key order never shows as a change. No dependency; a size cap
 * keeps the browser responsive.
 */

export type DiffOp = { kind: "same" | "added" | "removed"; text: string };

/** Largest text compared, in characters per side; above it the UI shows "too large". */
export const DIFF_MAX_CHARS = 512 * 1024;
/** Largest edit distance computed; beyond it the files are shown as wholly replaced. */
const MAX_EDITS = 4000;

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        )
      : value;

/** The text as compared: a `.json` file that parses is re-serialised with sorted keys; `json` says whether it was. */
export function normaliseText(path: string, text: string): { text: string; json: boolean } {
  if (/\.json$/i.test(path)) {
    try {
      return { text: `${JSON.stringify(sortKeys(JSON.parse(text)), null, 2)}\n`, json: true };
    } catch {
      // not valid JSON: compared as written
    }
  }
  return { text, json: false };
}

const splitLines = (text: string) => {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** The line edit script from `a` to `b`, in order. */
export function diffLines(a: string, b: string): DiffOp[] {
  const x = splitLines(a);
  const y = splitLines(b);
  const n = x.length;
  const m = y.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let i =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      next[offset + k] = i;
      if (i >= n && j >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  if (!found)
    return [
      ...x.map((text) => ({ kind: "removed" as const, text })),
      ...y.map((text) => ({ kind: "added" as const, text })),
    ];
  // Walk back through the saved frontiers.
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const frontier = trace[d]!;
    const k = i - j;
    const prevK = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!) ? k + 1 : k - 1;
    const prevI = d === 0 ? 0 : frontier[offset + prevK]!;
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) {
      ops.push({ kind: "same", text: x[--i]! });
      j--;
    }
    if (d > 0) {
      if (i === prevI) ops.push({ kind: "added", text: y[--j]! });
      else ops.push({ kind: "removed", text: x[--i]! });
    }
  }
  return ops.reverse();
}

export type DiffRow = DiffOp | { kind: "skip"; count: number };

/** Unchanged runs longer than `context * 2` lines collapse to a "n unchanged lines" row, keeping `context` around edits. */
export function collapse(ops: readonly DiffOp[], context = 3): DiffRow[] {
  const rows: DiffRow[] = [];
  let run: DiffOp[] = [];
  const flush = (atStart: boolean, atEnd: boolean) => {
    const keepHead = atStart ? 0 : context;
    const keepTail = atEnd ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      rows.push(...run.slice(0, keepHead), { kind: "skip", count: run.length - keepHead - keepTail });
      rows.push(...run.slice(run.length - keepTail));
    } else rows.push(...run);
    run = [];
  };
  let started = false;
  for (const op of ops) {
    if (op.kind === "same") run.push(op);
    else {
      flush(!started, false);
      started = true;
      rows.push(op);
    }
  }
  flush(!started, true);
  return rows;
}
