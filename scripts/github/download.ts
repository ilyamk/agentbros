import { CliErrorObject } from "../../src/lib/cli";

export const ATTACHMENT_HOSTS = new Set([
  "github.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export const BENCH_ATTACHMENT_HOSTS = new Set([...ATTACHMENT_HOSTS, "release-assets.githubusercontent.com"]);
export function attachmentUrl(value: string, hosts: ReadonlySet<string> = ATTACHMENT_HOSTS): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.has(url.hostname))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Expected an HTTPS GitHub attachment or release-asset URL on an allowlisted host.",
    });
  return url;
}
/** Redirects are checked individually; no credentials are forwarded to attachments. */
export async function download(
  value: string,
  maxBytes: number,
  request: typeof fetch = fetch,
  hosts: ReadonlySet<string> = ATTACHMENT_HOSTS,
): Promise<Buffer> {
  let url = attachmentUrl(value, hosts);
  const signal = AbortSignal.timeout(120_000);
  for (let hop = 0; hop < 6; hop++) {
    const response = await request(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Attachment redirect has no location");
      url = attachmentUrl(new URL(location, url).href, hosts);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Attachment download failed: HTTP ${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      await response.body.cancel();
      throw new Error("Attachment exceeds size cap");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("Attachment exceeds size cap");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes);
  }
  throw new Error("Too many attachment redirects");
}
