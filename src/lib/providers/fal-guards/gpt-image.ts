import { fail, isObject } from "../fal-errors";
import { arrayField, type FalGuard } from "./index";

export const gptImageGuard: FalGuard = {
  id: "gpt-image-2.5",
  match: (info) =>
    info.family === "gpt-image-2.5" ||
    info.family === "gpt-image-2.6" ||
    /^openai\/gpt-image-2\.[56]\//.test(info.endpoint),
  check: (input, _ctx, _warnings, info) => {
    if (input.background === "transparent" && input.output_format === "jpeg")
      fail("Transparent backgrounds require PNG or WebP.");
    if (input.output_compression != null && !["jpeg", "webp"].includes(String(input.output_format ?? "png")))
      fail("output_compression requires JPEG or WebP.");
    if (isObject(input.image_size)) {
      const { width, height } = input.image_size as { width: number; height: number };
      if (
        !width ||
        !height ||
        width % 16 ||
        height % 16 ||
        Math.max(width, height) > 3840 ||
        Math.max(width / height, height / width) > 3 ||
        width * height < 655360 ||
        width * height > 8294400
      )
        fail("GPT image size must use multiples of 16, edge ≤3840, ratio ≤3 and 655360–8294400 pixels.");
    }
    if (info.operation === "edit" && arrayField(input, "image_urls").length === 0)
      fail("GPT edit requires at least one reference image.");
  },
};
