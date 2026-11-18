import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cacheRoot } from "../cache-dir";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { sha256File } from "./media";

/** OpenCV Zoo YuNet face detector (MIT), pinned by commit and checksum. */
export const YUNET = {
  name: "yunet-2023mar",
  url: "https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
  sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
} as const;

export const modelRoot = () => cacheRoot();

export async function ensureModel(
  model: { name: string; url: string; sha256: string },
  folder: string,
  extension: string,
): Promise<string> {
  const file = path.join(modelRoot(), folder, `${model.name}${extension}`);
  if (existsSync(file) && sha256File(file) === model.sha256) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  emitProgress(`Downloading ${model.url}`);
  const response = await fetch(model.url).catch((error: Error) => {
    throw new CliErrorObject({ code: "NETWORK", message: `Model download failed: ${error.message}` });
  });
  if (!response.ok)
    throw new CliErrorObject({
      code: "NETWORK",
      message: `Model download failed: HTTP ${response.status} for ${model.url}`,
    });
  const partial = `${file}.part`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  if (sha256File(partial) !== model.sha256) {
    rmSync(partial);
    throw new CliErrorObject({ code: "VALIDATION", message: `Checksum mismatch for ${model.url}` });
  }
  renameSync(partial, file);
  return file;
}
