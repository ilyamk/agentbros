import { MediaFetchError } from "./errors";
/** Retry only explicitly safe reads or conclusive rate/no-charge responses. */
export async function retryRead<T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++)
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2 || !(error instanceof MediaFetchError) || !error.retryable) throw error;
      await sleep(Math.min(30000, error.retryAfterMs ?? 1000 * 2 ** attempt));
    }
}
