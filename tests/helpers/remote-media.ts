import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RemoteMediaIo } from "../../src/lib/assets/remote-media";

export const remoteIo = (bytes: Buffer | string, contentType = "video/mp4", status = 200): RemoteMediaIo => ({
  request: async () =>
    Object.assign(Readable.from([bytes]), {
      headers: { "content-type": contentType },
      statusCode: status,
    }) as IncomingMessage,
});
