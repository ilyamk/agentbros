/**
 * Strict CSP support (RU-H04 of the review:ui parity checklist): the server puts the per-response style nonce in
 * `<meta name="csp-nonce" content="…">`. Radix's scroll lock injects a <style> through react-style-singleton, which asks
 * get-nonce; get-nonce falls back to the global `__webpack_nonce__` when nobody called its `setNonce` (the package is a
 * transitive dependency we cannot import directly), so setting that global before the first render is `setNonce`.
 * Radix ScrollArea and Select viewports take the nonce as a prop: pass {@link cspNonce}.
 */
let nonce: string | undefined;

declare global {
  // eslint-disable-next-line no-var
  var __webpack_nonce__: string | undefined;
}

/** Reads the nonce from the page and hands it to get-nonce. Call once at boot, before React renders. */
export function installCspNonce(doc: Document = document): string | undefined {
  const value = doc.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content?.trim();
  nonce = value || undefined;
  if (nonce) globalThis.__webpack_nonce__ = nonce;
  return nonce;
}

/** The page's style nonce, if the server sent one. */
export function cspNonce(): string | undefined {
  return nonce;
}
