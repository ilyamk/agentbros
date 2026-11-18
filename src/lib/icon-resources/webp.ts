import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import encode, { init } from "@jsquash/webp/encode.js";
const require = createRequire(import.meta.url);
let ready: Promise<unknown> | undefined;
export async function encodeLosslessWebp(rgba: Uint8ClampedArray, width: number, height: number) {
  if (!ready)
    ready = init(new WebAssembly.Module(readFileSync(require.resolve("@jsquash/webp/codec/enc/webp_enc.wasm"))));
  await ready;
  return Buffer.from(
    await encode({ data: rgba, width, height, colorSpace: "srgb" } as ImageData, {
      lossless: 1,
      quality: 100,
      exact: 1,
    }),
  );
}
