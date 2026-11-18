/**
 * Fails a test on any fetch to a fal or Higgsfield host. Provider suites import it first:
 *   import "./helpers/fal-no-network";
 * Injected fetch/provider fakes are unaffected; only the global fetch is guarded.
 */
const FAL_HOST = /(^|\.)(fal\.(ai|run|media)|higgsfield\.ai|(d28lhcrx5qdowv|d3u0tzju9qaucj)\.cloudfront\.net)$/;
const original = globalThis.fetch;
export const falNetworkAttempts: string[] = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (FAL_HOST.test(url.hostname)) {
    falNetworkAttempts.push(url.href);
    throw new Error(`Network to a model provider is forbidden in tests: ${url.hostname}${url.pathname}`);
  }
  return original(input, init);
}) as typeof fetch;
delete process.env.FAL_KEY;
delete process.env.HIGGSFIELD_API_KEY;
delete process.env.ELEVENLABS_API_KEY;
