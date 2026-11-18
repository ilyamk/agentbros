import test from "node:test";
import assert from "node:assert/strict";
import { inspectCopyText, observeCopyText, type CopyTextObservation } from "./helpers/copy-text-geometry";
import { cleanupCopyRun, type CopyOperationState } from "./helpers/copy-run-cleanup";
const canvas = { x: 20, y: 30, width: 100, height: 100 },
  inside = { x: 25, y: 35, width: 80, height: 10 };
const ancestry = { visible: true, opacity: 1, clips: [] };
const observation = (): CopyTextObservation => ({
  text: "A\nB",
  nodes: [{ order: 0, text: "A\nB", fragments: [inside, { ...inside, y: 50 }], ancestry }],
  visible: true,
  opacity: 0.5,
  clips: [],
});
test("dual criteria retain padded element failure while complete lines independently pass", () => {
  const result = inspectCopyText(canvas, { x: 19, y: 30, width: 102, height: 100 }, "A\nB", observation());
  assert.equal(result.elementCriterion.result, "fail");
  assert.equal(result.textCriterion.name, "copy-text-lines-v1");
  assert.equal(result.textCriterion.result, "pass");
  assert.equal(result.nodes[0].fragments.length, 2);
  assert.deepEqual(result.nodes[0].fragments[1].relative, { x: 5, y: 20, width: 80, height: 10 });
});
test("each overflowing edge including a later wrapped fragment fails without epsilon", () => {
  for (const rect of [
    { ...inside, x: 19.999999 },
    { ...inside, y: 29.999999 },
    { ...inside, x: 41 },
    { ...inside, y: 121 },
    { ...inside, width: 0 },
    { ...inside, x: NaN },
  ]) {
    const value = observation();
    value.nodes[0].fragments.push(rect);
    assert.equal(inspectCopyText(canvas, inside, value.text, value).textCriterion.result, "fail");
  }
});
test("complete text/order/positive content/visibility refuse fake or omitted copy", () => {
  for (const change of [
    { text: "A" },
    { nodes: [] },
    { nodes: [{ order: 1, text: "A\nB", fragments: [inside], ancestry }] },
    { nodes: [{ order: 0, text: "A\nB", fragments: [], ancestry }] },
    { nodes: [{ order: 0, text: "A", fragments: [inside], ancestry }] },
    { visible: false },
    { opacity: 0 },
    { opacity: NaN },
  ]) {
    const value = { ...observation(), ...change };
    assert.equal(inspectCopyText(canvas, inside, "A\nB", value).textCriterion.result, "fail");
  }
});
test("ancestor axis clipping is independently strict even inside full canvas", () => {
  for (const clip of [
    { x: true, y: false, box: { ...canvas, x: 26 } },
    { x: false, y: true, box: { ...canvas, y: 36 } },
    { x: true, y: true, box: { ...canvas, width: NaN } },
  ]) {
    const value = observation();
    value.clips = [clip];
    assert.equal(inspectCopyText(canvas, inside, value.text, value).textCriterion.result, "fail");
  }
  const value = observation();
  value.clips = [{ x: false, y: true, box: { ...canvas, x: 1000 } }];
  assert.equal(
    inspectCopyText(canvas, inside, value.text, value).textCriterion.result,
    "pass",
    "non-clipping X axis does not invent restriction",
  );
});
test("zero-area whitespace fragments stay recorded with exact structural offset, never cover missing content", () => {
  const value = observation();
  value.nodes[0].fragments.push({ x: 100, y: 35, width: 0, height: 10, structuralWhitespaceOffset: 1 });
  const accepted = inspectCopyText(canvas, inside, value.text, value);
  assert.equal(accepted.textCriterion.result, "pass");
  assert.equal(accepted.nodes[0].fragments.length, 3);
  for (const offset of [0, 3, -1]) {
    value.nodes[0].fragments[2].structuralWhitespaceOffset = offset;
    assert.equal(inspectCopyText(canvas, inside, value.text, value).textCriterion.result, "fail");
  }
  value.nodes[0].fragments = [{ x: 100, y: 35, width: 0, height: 10, structuralWhitespaceOffset: 1 }];
  assert.equal(inspectCopyText(canvas, inside, value.text, value).textCriterion.result, "fail");
});
function fakeDOM() {
  const textNodes = [
    { textContent: "A", rects: [inside] },
    { textContent: "\n", rects: [] },
    {
      textContent: "B",
      rects: [
        { ...inside, y: 50 },
        { ...inside, y: 70 },
      ],
    },
  ];
  let detached = 0;
  let walkedRoot: unknown;
  const owner = { parentElement: null, getBoundingClientRect: () => canvas };
  const field = { textContent: "A\nB", children: [], parentElement: owner, getBoundingClientRect: () => inside };
  let candidates = [field];
  const root = { ...owner, querySelectorAll: () => candidates };
  const document = {
    createTreeWalker: (element: unknown) => {
      walkedRoot = element;
      let index = 0;
      return {
        nextNode: () => {
          const node = textNodes[index++];
          return node ? { ...node, parentElement: field } : null;
        },
      };
    },
    createRange: () => {
      let selected: (typeof textNodes)[number];
      return {
        selectNodeContents: (node: (typeof textNodes)[number]) => {
          selected = node;
        },
        getClientRects: () => selected.rects,
        detach: () => {
          detached++;
        },
        setStart: () => {},
        setEnd: () => {},
      };
    },
  };
  const normal = {
    opacity: "1",
    display: "block",
    visibility: "visible",
    overflowX: "visible",
    overflowY: "visible",
    clipPath: "none",
    maskImage: "none",
  };
  let parentStyle = normal;
  return {
    root: root as unknown as Element,
    document: document as unknown as Document,
    style: (element: Element) =>
      (element === (owner as unknown as Element) ? parentStyle : normal) as CSSStyleDeclaration,
    field,
    textNodes,
    setCandidates: (value: typeof candidates) => {
      candidates = value;
    },
    setParentStyle: (value: Partial<typeof normal>) => {
      parentStyle = { ...normal, ...value };
    },
    get detached() {
      return detached;
    },
    get walkedRoot() {
      return walkedRoot;
    },
  };
}
test("DOM adapter measures complete ordered nodes and every wrapped line, retaining structural whitespace nodes", () => {
  const fake = fakeDOM(),
    result = observeCopyText(fake.root, "A\nB", fake.document, fake.style);
  assert.equal(fake.walkedRoot, fake.field);
  assert.equal(fake.detached, 3);
  assert.deepEqual(
    result.observation.nodes.map((node) => [node.order, node.text, node.fragments.length]),
    [
      [0, "A", 1],
      [1, "\n", 0],
      [2, "B", 2],
    ],
  );
  assert.equal(inspectCopyText(canvas, inside, "A\nB", result.observation).textCriterion.result, "pass");
  fake.textNodes[2].rects[1] = { ...inside, x: 500 };
  assert.equal(
    inspectCopyText(canvas, inside, "A\nB", observeCopyText(fake.root, "A\nB", fake.document, fake.style).observation)
      .textCriterion.result,
    "fail",
  );
});
test("DOM adapter refuses ambiguous/missing complete fields and observes ancestor invisibility/clips", () => {
  const fake = fakeDOM();
  fake.setCandidates([fake.field, { ...fake.field }]);
  assert.throws(() => observeCopyText(fake.root, "A\nB", fake.document, fake.style));
  fake.setCandidates([]);
  assert.throws(() => observeCopyText(fake.root, "A\nB", fake.document, fake.style));
  fake.setCandidates([fake.field]);
  for (const style of [{ opacity: "0" }, { visibility: "hidden" }, { display: "none" }, { clipPath: "circle(10px)" }]) {
    fake.setParentStyle(style);
    assert.equal(observeCopyText(fake.root, "A\nB", fake.document, fake.style).observation.visible, false);
  }
  fake.setParentStyle({ overflowX: "hidden" });
  assert.equal(observeCopyText(fake.root, "A\nB", fake.document, fake.style).observation.clips.length, 1);
});
test("cleanup settled normal/idle omits cancel; active deadline/failed operation cancels exactly once", async () => {
  for (const state of ["idle", "normal", "active", "failed"] as CopyOperationState[]) {
    const calls: string[] = [];
    const errors = await cleanupCopyRun({
      state,
      cancel: () => {
        calls.push("cancel");
      },
      close: async () => {
        calls.push("close");
      },
      pending: async () => {
        calls.push("pending");
      },
      persist: () => {
        calls.push("persist");
      },
      remove: () => {
        calls.push("remove");
      },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [
      ...(["active", "failed"].includes(state) ? ["cancel"] : []),
      "close",
      "pending",
      "persist",
      "remove",
    ]);
  }
});
test("cleanup preserves close/pending failures in diagnostics and removal survives persist failure", async () => {
  let removed = false,
    diagnostics: string[] = [];
  const errors = await cleanupCopyRun({
    state: "normal",
    cancel: () => {
      throw Error("must not cancel");
    },
    close: async () => {
      throw Error("close failed");
    },
    pending: async () => {
      throw Error("pending failed");
    },
    persist: (value) => {
      diagnostics = [...value];
      throw Error("write failed");
    },
    remove: () => {
      removed = true;
    },
  });
  assert.equal(removed, true);
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(errors, ["Error: close failed", "Error: pending failed", "Error: write failed"]);
});

test("complete DOM adapter retains measured zero-area whitespace rectangles with verified offset and rejects node bounds", () => {
  const fake = fakeDOM();
  fake.textNodes[1].rects = [{ x: 105, y: 35, width: 0, height: 10 }];
  const observed = observeCopyText(fake.root, "A\nB", fake.document, fake.style).observation;
  assert.equal(observed.nodes[1].fragments[0].structuralWhitespaceOffset, 0);
  assert.equal(inspectCopyText(canvas, inside, "A\nB", observed).textCriterion.result, "pass");
  const overflow = fakeDOM();
  for (let i = 0; i < 256; i++) overflow.textNodes.push({ textContent: "", rects: [] });
  assert.throws(() => observeCopyText(overflow.root, "A\nB", overflow.document, overflow.style), /bound/);
});
test("negative geometry receipt preserves all invalid fragments and cannot enter accepted quota", () => {
  const value = observation();
  value.nodes[0].fragments.push({ ...inside, width: 200 });
  const receipt = inspectCopyText(canvas, inside, value.text, value);
  assert.equal(receipt.textCriterion.result, "fail");
  assert.equal(receipt.nodes[0].fragments.length, 3);
  let accepted = 0;
  assert.throws(() => {
    assert.equal(receipt.textCriterion.result, "pass");
    accepted++;
  });
  assert.equal(accepted, 0);
});

test("cleanup cancellation and removal failures are retained rather than swallowed", async () => {
  const calls: string[] = [];
  const errors = await cleanupCopyRun({
    state: "active",
    cancel: () => {
      calls.push("cancel");
      throw Error("cancel failed");
    },
    close: async () => {
      calls.push("close");
    },
    pending: async () => {},
    persist: (value) => {
      assert.deepEqual(value, ["Error: cancel failed"]);
    },
    remove: () => {
      calls.push("remove");
      throw Error("remove failed");
    },
  });
  assert.deepEqual(calls, ["cancel", "close", "remove"]);
  assert.deepEqual(errors, ["Error: cancel failed", "Error: remove failed"]);
});

test("nested text-node ancestors may not hide or clip a convenient subset of complete copy", () => {
  const value = observation();
  value.nodes[0].ancestry = { visible: false, opacity: 0, clips: [] };
  assert.equal(inspectCopyText(canvas, inside, value.text, value).textCriterion.result, "fail");
  value.nodes[0].ancestry = { visible: true, opacity: 1, clips: [{ x: true, y: false, box: { ...canvas, x: 26 } }] };
  assert.equal(inspectCopyText(canvas, inside, value.text, value).textCriterion.result, "fail");
});
