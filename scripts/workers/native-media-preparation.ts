/** Trusted Node preparation entry point; authored HTML is never imported. */
import path from "node:path";
import { readNativeJson } from "../../src/lib/backends/native-media-files";
import { registerOwnedRenderProcesses } from "../../src/lib/longform/bounded-worker";
import { prepareNativeMedia } from "../../src/lib/backends/native-media-preparation";
async function main() {
  await registerOwnedRenderProcesses();
  const request = readNativeJson(process.argv[2], path.dirname(process.argv[2]), 2 * 1024 * 1024);
  await prepareNativeMedia(request);
}
void main()
  .then(() => {
    process.disconnect?.();
  })
  .catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
    process.disconnect?.();
  });
