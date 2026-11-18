/** Test-only complete typographic fragments; these are not painted glyph-ink bounds. */
import { copyBoxObservation, relativeCopyBox, type CopyBox } from "./copy-canvas-geometry";
export interface CopyClip {
  x: boolean;
  y: boolean;
  box: CopyBox;
}
export type CopyFragment = CopyBox & { structuralWhitespaceOffset?: number };
export interface CopyAncestry {
  visible: boolean;
  opacity: number;
  clips: CopyClip[];
}
export interface CopyTextNode {
  order: number;
  text: string;
  fragments: CopyFragment[];
  ancestry: CopyAncestry;
}
export interface CopyTextObservation {
  text: string;
  nodes: CopyTextNode[];
  visible: boolean;
  opacity: number;
  clips: CopyClip[];
}
export interface CopyCriterion {
  name: "copy-element-box-v1" | "copy-text-lines-v1";
  result: "pass" | "fail";
  issues: string[];
}
export const COPY_TEXT_LIMITS = { nodes: 256, fragments: 1024 } as const;
function fits(canvas: CopyBox, raw: CopyBox) {
  try {
    relativeCopyBox(canvas, raw);
    return true;
  } catch {
    return false;
  }
}
export function inspectCopyText(canvas: CopyBox, element: CopyBox, expected: string, observation: CopyTextObservation) {
  const issues: string[] = [];
  const issue = (message: string) => {
    if (issues.length < 32) issues.push(message);
  };
  const elementCriterion: CopyCriterion = {
    name: "copy-element-box-v1",
    result: fits(canvas, element) ? "pass" : "fail",
    issues: fits(canvas, element) ? [] : ["Element border box exceeds full canvas or is invalid"],
  };
  if (
    ![element.x, element.y, element.width, element.height].every(Number.isFinite) ||
    element.width <= 0 ||
    element.height <= 0
  )
    issue("Intrinsic element rectangle is invalid");
  if (!expected.trim() || observation.text !== expected) issue("Complete expected field text mismatch");
  if (
    !observation.visible ||
    !Number.isFinite(observation.opacity) ||
    observation.opacity <= 0 ||
    observation.opacity > 1
  )
    issue("Copy is not positively visible through all ancestors");
  if (observation.nodes.length === 0 || observation.nodes.length > COPY_TEXT_LIMITS.nodes)
    issue("Invalid complete text-node count");
  if (observation.nodes.map((node) => node.text).join("") !== expected)
    issue("Complete ordered text nodes do not match expected field");
  let fragmentCount = 0,
    positiveFragments = 0;
  for (const [index, node] of observation.nodes.entries()) {
    if (
      !node.ancestry ||
      !node.ancestry.visible ||
      !Number.isFinite(node.ancestry.opacity) ||
      node.ancestry.opacity <= 0 ||
      node.ancestry.opacity > 1
    )
      issue("Text-node ancestry is not positively visible");
    if (node.order !== index) issue("Text-node order mismatch");
    if (
      node.text.trim() &&
      !node.fragments.some(
        (fragment) => fragment.structuralWhitespaceOffset === undefined && fragment.width > 0 && fragment.height > 0,
      )
    )
      issue("Nonempty visible text node has no fragments");
    for (const fragment of node.fragments) {
      fragmentCount++;
      const structural = fragment.structuralWhitespaceOffset !== undefined;
      if (structural) {
        const offset = fragment.structuralWhitespaceOffset!;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset >= node.text.length ||
          !/^\s$/.test(node.text[offset]) ||
          ![fragment.x, fragment.y, fragment.width, fragment.height].every(Number.isFinite) ||
          fragment.width < 0 ||
          fragment.height < 0 ||
          (fragment.width !== 0 && fragment.height !== 0) ||
          fragment.x < canvas.x ||
          fragment.y < canvas.y ||
          fragment.x + fragment.width > canvas.x + canvas.width ||
          fragment.y + fragment.height > canvas.y + canvas.height
        )
          issue("Invalid structural whitespace fragment");
      } else {
        positiveFragments++;
        if (!fits(canvas, fragment)) issue("Text fragment exceeds full canvas or is invalid");
      }
      for (const clip of [...observation.clips, ...(node.ancestry?.clips ?? [])]) {
        if (
          ![clip.box.x, clip.box.y, clip.box.width, clip.box.height].every(Number.isFinite) ||
          clip.box.width <= 0 ||
          clip.box.height <= 0
        )
          issue("Invalid ancestor clipping bounds");
        else if (
          (clip.x && (fragment.x < clip.box.x || fragment.x + fragment.width > clip.box.x + clip.box.width)) ||
          (clip.y && (fragment.y < clip.box.y || fragment.y + fragment.height > clip.box.y + clip.box.height))
        )
          issue("Ancestor clips text fragment");
      }
    }
  }
  if (positiveFragments === 0 || fragmentCount > COPY_TEXT_LIMITS.fragments) issue("Invalid complete fragment count");
  const nodes = observation.nodes.slice(0, COPY_TEXT_LIMITS.nodes).map((node) => ({
    ...node,
    fragments: node.fragments.slice(0, COPY_TEXT_LIMITS.fragments).map((raw) => ({
      raw,
      relative: fits(canvas, raw)
        ? copyBoxObservation(canvas, raw).relative
        : { ...raw, x: raw.x - canvas.x, y: raw.y - canvas.y },
    })),
  }));
  const textCriterion: CopyCriterion = { name: "copy-text-lines-v1", result: issues.length ? "fail" : "pass", issues };
  return {
    elementCriterion,
    textCriterion,
    nodes,
    visible: observation.visible,
    cumulativeOpacity: observation.opacity,
    clips: observation.clips,
  };
}
/** Exact complete selection, including all descendants and all Range line fragments. */
export function observeCopyText(
  canvas: Element,
  expected: string,
  document: Document,
  style: (element: Element) => CSSStyleDeclaration,
): { element: Element; observation: CopyTextObservation } {
  const found = Array.from(canvas.querySelectorAll("div")).filter(
    (element) =>
      element.textContent === expected && !Array.from(element.children).some((child) => child.textContent === expected),
  );
  if (!expected.trim() || expected.length > 256) throw Error("Invalid bounded expected copy");
  if (found.length !== 1) throw Error("Expected unique complete copy field, found " + found.length);
  const element = found[0],
    nodes: CopyTextNode[] = [];
  const walker = document.createTreeWalker(element, 4);
  let node: Node | null;
  let total = 0;
  while ((node = walker.nextNode())) {
    if (nodes.length >= COPY_TEXT_LIMITS.nodes) throw Error("Complete copy text-node bound exceeded");
    const range = document.createRange();
    let fragments: CopyFragment[];
    try {
      range.selectNodeContents(node);
      fragments = Array.from(range.getClientRects()).map((rect) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }));
      for (const fragment of fragments.filter((rect) => rect.width === 0 || rect.height === 0)) {
        for (let offset = 0; offset < (node.textContent ?? "").length; offset++) {
          if (!/^\s$/.test(node.textContent![offset])) continue;
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          if (
            Array.from(range.getClientRects()).some(
              (rect) =>
                rect.x === fragment.x &&
                rect.y === fragment.y &&
                rect.width === fragment.width &&
                rect.height === fragment.height,
            )
          ) {
            fragment.structuralWhitespaceOffset = offset;
            break;
          }
        }
      }
    } finally {
      range.detach();
    }
    total += fragments.length;
    if (total > COPY_TEXT_LIMITS.fragments) throw Error("Complete copy fragment bound exceeded");
    // Whitespace-only nodes may have no fragments, but remain in the exact ordered text evidence.
    if (!node.parentElement) throw Error("Copy text node requires measured ancestry");
    nodes.push({
      order: nodes.length,
      text: node.textContent ?? "",
      fragments,
      ancestry: observeAncestry(node.parentElement, style),
    });
  }
  const { visible, opacity, clips } = observeAncestry(element, style);
  return { element, observation: { text: element.textContent ?? "", nodes, visible, opacity, clips } };
}

function observeAncestry(element: Element, style: (element: Element) => CSSStyleDeclaration): CopyAncestry {
  let visible = true,
    opacity = 1;
  const clips: CopyClip[] = [];
  let ancestorCount = 0;
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (++ancestorCount > 256) throw Error("Copy ancestor bound exceeded");
    const s = style(ancestor);
    opacity *= Number(s.opacity);
    if (
      s.display === "none" ||
      ["hidden", "collapse"].includes(s.visibility) ||
      !Number.isFinite(opacity) ||
      opacity <= 0
    )
      visible = false;
    // Unmeasured nonrectangular clipping cannot be declared safe by rectangular evidence.
    if ((s.clipPath && s.clipPath !== "none") || (s.maskImage && s.maskImage !== "none")) visible = false;
    const x = ["hidden", "clip", "scroll", "auto"].includes(s.overflowX),
      y = ["hidden", "clip", "scroll", "auto"].includes(s.overflowY);
    if (x || y) {
      // Border/rounded/scrollbar clipping needs a different measured clipping shape; do not claim a border-box is that shape.
      if (
        [
          s.borderLeftWidth,
          s.borderRightWidth,
          s.borderTopWidth,
          s.borderBottomWidth,
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomLeftRadius,
          s.borderBottomRightRadius,
        ].some((value) => value && Number.parseFloat(value) !== 0) ||
        s.overflowX === "scroll" ||
        s.overflowY === "scroll" ||
        (typeof ancestor.scrollLeft === "number" && ancestor.scrollLeft !== 0) ||
        (typeof ancestor.scrollTop === "number" && ancestor.scrollTop !== 0)
      )
        visible = false;
      if (
        (s.overflowX === "auto" || s.overflowY === "auto") &&
        typeof (ancestor as HTMLElement).offsetWidth === "number" &&
        ((ancestor as HTMLElement).offsetWidth !== ancestor.clientWidth ||
          (ancestor as HTMLElement).offsetHeight !== ancestor.clientHeight)
      )
        visible = false;
      const b = ancestor.getBoundingClientRect();
      clips.push({ x, y, box: { x: b.x, y: b.y, width: b.width, height: b.height } });
    }
  }
  const color = style(element).color;
  if (color === "transparent" || /^rgba\(.*[,]\s*0(?:\.0+)?\s*\)$/.test(color)) visible = false;
  return { visible, opacity, clips };
}
