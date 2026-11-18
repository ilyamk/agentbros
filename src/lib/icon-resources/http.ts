import { CliErrorObject } from "../cli";
import { readResourceResponse } from "../resources/http";

const hosts = new Set(["api.iconify.design", "api.svgl.app", "svgl.app"]);
export function trustedUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.port || url.username || url.password || url.hash)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Untrusted icon resource URL" });
  if (url.hostname === "svgl.app" && !/^\/library\/[a-zA-Z0-9._-]+\.svg$/.test(url.pathname))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Untrusted SVGL asset path" });
  return url.toString();
}
export class IconHttp {
  private deadline?: number;
  begin() {
    this.deadline = Date.now() + 45000;
  }
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(
    private request: typeof fetch = fetch,
    private pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}
  async get(input: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
    const url = trustedUrl(input);
    if (this.active >= 2) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    const deadline = this.deadline ?? Date.now() + 45000;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (Date.now() >= deadline)
            throw new CliErrorObject({ code: "TIMEOUT", message: "Icon operation deadline exceeded" });
          const transport: typeof fetch = async (u, init) => {
            let response: Response;
            try {
              response = await this.request(u, { ...init, credentials: "omit" });
            } catch (error) {
              throw new CliErrorObject({ code: "NETWORK", message: `Icon request failed: ${String(error)}` });
            }
            if (!response.ok) {
              void response.body?.cancel().catch(() => {});
              const status = response.status;
              const raw = response.headers.get("retry-after");
              const delay =
                raw === null
                  ? 1000
                  : /^\d+$/.test(raw)
                    ? Number(raw) * 1000
                    : Math.max(0, Date.parse(raw) - Date.now());
              throw new CliErrorObject({
                code:
                  status === 429
                    ? "RATE_LIMIT"
                    : status >= 500
                      ? "NETWORK"
                      : status === 404
                        ? "ASSET_MISSING"
                        : "VALIDATION",
                message: `Icon provider HTTP ${status}`,
                retryAfterMs: status === 429 && Number.isFinite(delay) ? delay : undefined,
              });
            }
            return response;
          };
          return await readResourceResponse(transport, url, {
            maxBytes,
            timeoutMs: Math.min(15000, Math.max(1, deadline - Date.now())),
          });
        } catch (error) {
          const issue =
            error instanceof CliErrorObject
              ? error
              : new CliErrorObject({
                  code: /deadline/i.test(String(error)) ? "TIMEOUT" : "VALIDATION",
                  message: String(error),
                });
          const delay = issue.retryAfterMs ?? 500;
          if (
            attempt ||
            !["NETWORK", "TIMEOUT", "RATE_LIMIT"].includes(issue.code) ||
            Date.now() + delay + 15000 > deadline
          )
            throw issue;
          await this.pause(delay);
        }
      }
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  async json(url: string): Promise<unknown> {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.get(url)));
    } catch (error) {
      if (error instanceof CliErrorObject) throw error;
      throw new CliErrorObject({ code: "VALIDATION", message: `Invalid provider JSON: ${String(error)}` });
    }
  }
}
