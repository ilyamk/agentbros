import WebSocket from "ws";
import { encode, decode } from "@msgpack/msgpack";
/** Exactly the SDK's documented default URL/MessagePack protocol, without reconnect/replay. */
export function falRealtimeUrl(endpoint: string, token: string) {
  if (endpoint !== "fal-ai/flux-2/klein/realtime") throw new Error("Unsupported realtime endpoint");
  if (!token.trim()) throw new Error("Temporary token is empty");
  return `wss://fal.run/${endpoint}?${new URLSearchParams({
    fal_jwt_token: token,
    max_buffering: "1",
  })}`;
}
export function openRealtimeSocket(url: string, maxPayload: number) {
  return new WebSocket(url, {
    maxPayload,
    handshakeTimeout: 10000,
    perMessageDeflate: false,
    followRedirects: false,
  });
}
export const encodeRealtimeInput = (input: Record<string, unknown>) => encode(input);
export function decodeRealtimeResult(data: WebSocket.RawData, isBinary: boolean): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return isBinary
    ? decode(bytes, {
        maxStrLength: 16 * 1024 * 1024,
        maxBinLength: 16 * 1024 * 1024,
        maxArrayLength: 64,
        maxMapLength: 64,
        maxExtLength: 0,
      })
    : JSON.parse(bytes.toString("utf8"));
}
