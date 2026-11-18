/** Installed fal SDK auth.js/config.js: one temporary auth POST; never log or persist tokens. */
export function createFalRealtimeTokenProvider(credentials: () => string, request: typeof fetch = fetch) {
  return async (endpoint: string): Promise<string> => {
    if (endpoint !== "fal-ai/flux-2/klein/realtime") throw new Error("Unsupported realtime auth endpoint");
    const key = credentials();
    if (!key.trim()) throw new Error("Realtime credentials missing");
    let response: Response;
    try {
      response = await request("https://rest.fal.ai/tokens/", {
        method: "POST",
        headers: {
          Authorization: `Key ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          allowed_apps: ["flux-2"],
          token_expiration: 120,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new Error("Realtime token acquisition failed; credentials/response omitted");
    }
    if (!response.ok || !response.body) throw new Error(`Realtime token acquisition rejected: HTTP ${response.status}`);
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 16384) throw new Error("Token response exceeds limit");
        chunks.push(next.value);
      }
    } catch {
      await reader.cancel();
      throw new Error("Invalid bounded realtime token response");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Invalid realtime token response");
    }
    const token =
      typeof parsed === "string"
        ? parsed
        : parsed && typeof parsed === "object" && "detail" in parsed
          ? (
              parsed as {
                detail: unknown;
              }
            ).detail
          : undefined;
    if (typeof token !== "string" || !token.trim() || token.length > 8192)
      throw new Error("Invalid realtime token response");
    return token;
  };
}
