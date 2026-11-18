/** Runs in the actual composition document after fonts.ready, never estimates text width. */
export function measureCompositionText(
  width: number,
  height: number,
  safe: { top: number; bottom: number; sides: number },
) {
  const findings: {
    code: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    detail: string;
  }[] = [];
  const measurements: {
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    font: string;
    loaded: boolean;
    role?: string;
    opacity: number;
  }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim(),
      parent = node.parentElement;
    if (!text || !parent || ["SCRIPT", "STYLE", "TEXTAREA"].includes(parent.tagName)) continue;
    let visible = true;
    let opacity = 1;
    for (let p: Element | null = parent; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      opacity *= Number(s.opacity);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) {
        visible = false;
        break;
      }
    }
    if (!visible) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const style = getComputedStyle(parent),
      font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      loaded = document.fonts.check(font, text),
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    const role = parent.closest("[data-avc-text-role]")?.getAttribute("data-avc-text-role") ?? undefined;
    measurements.push({ text, rect, font, loaded, opacity, ...(role ? { role } : {}) });
    if (!loaded) findings.push({ code: "FONT_NOT_LOADED", text, rect, detail: font });
    if (
      rect.x < safe.sides - 1 ||
      rect.y < safe.top - 1 ||
      rect.x + rect.width > width - safe.sides + 1 ||
      rect.y + rect.height > height - safe.bottom + 1
    )
      findings.push({
        code: "TEXT_SAFEZONE",
        text,
        rect,
        detail: "Visible glyph bounds cross the selected format safe zone",
      });
    for (let p: Element | null = parent; p; p = p.parentElement) {
      const s = getComputedStyle(p),
        bounds = p.getBoundingClientRect();
      if (
        (["hidden", "clip", "scroll", "auto"].includes(s.overflowX) &&
          (box.left < bounds.left - 1 || box.right > bounds.right + 1)) ||
        (["hidden", "clip", "scroll", "auto"].includes(s.overflowY) &&
          (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1))
      ) {
        findings.push({
          code: "TEXT_CLIPPED",
          text,
          rect,
          detail: p.tagName + " clips visible text bounds",
        });
        break;
      }
    }
  }
  // Compare only explicit independent media title and spoken caption roles.
  // Typography templates may intentionally overlap; generic pairs are not defects.
  for (const title of measurements.filter((row) => row.role === "media-headline" || row.role === "media-subtext")) {
    for (const caption of measurements.filter((row) => row.role === "spoken-caption")) {
      const left = Math.max(title.rect.x, caption.rect.x),
        right = Math.min(title.rect.x + title.rect.width, caption.rect.x + caption.rect.width);
      const top = Math.max(title.rect.y, caption.rect.y),
        bottom = Math.min(title.rect.y + title.rect.height, caption.rect.y + caption.rect.height);
      if (right - left > 1 && bottom - top > 1)
        findings.push({
          code: "TEXT_OVERLAP",
          text: title.text,
          rect: title.rect,
          detail: `Media text intersects spoken caption: ${caption.text}`,
        });
    }
  }
  const faces = [...document.fonts].map((face) => ({
    family: face.family,
    status: face.status,
  }));
  return {
    // Native image readiness and count are evidence; they do not infer licence or visual quality.
    images: [...document.querySelectorAll("img")].map((image) => ({
      source: image.getAttribute("src") ?? "",
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    })),
    fontsReady: document.fonts.status === "loaded",
    faces,
    measurements,
    findings,
    coverage: measurements.length ? "visible-text-measured" : "needs-review-no-visible-text",
  };
}
