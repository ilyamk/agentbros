import { fail, isObject } from "../fal-errors";
import { arrayField, type FalGuard } from "./index";

/** Kling element and motion-control limits this guard enforces; reference profiles are checked against them. */
export const KLING_ELEMENT_LIMITS = {
  referenceImagesMin: 1,
  referenceImagesMax: 3,
  videoElementsMax: 1,
  motionControlElementsMax: 1,
  motionControlMaxDurationSec: { video: 30, image: 10 },
  videoToVideoCombinedMax: 4,
} as const;
const L = KLING_ELEMENT_LIMITS;

export const klingGuard: FalGuard = {
  id: "kling",
  match: (info) => info.family?.startsWith("kling") ?? false,
  check: (input, ctx, _warnings, info) => {
    const family = info.family!;
    const operation = info.operation ?? "";
    if (operation !== "motion-control" && family !== "kling-voice") {
      const hasPrompt = typeof input.prompt === "string" && input.prompt.trim().length > 0;
      const shots = arrayField(input, "multi_prompt");
      if (!hasPrompt && !shots.length) fail("Kling requires prompt or multi_prompt.");
      if (hasPrompt && shots.length) fail("Kling prompt and multi_prompt are mutually exclusive.");
      if (shots.length && input.duration && shots.every((shot) => isObject(shot) && shot.duration)) {
        const sum = shots.reduce<number>(
          (total, shot) => total + Number((shot as Record<string, unknown>).duration),
          0,
        );
        if (sum !== Number(input.duration)) fail("Multi-shot durations must sum to the requested duration.");
      }
      if (
        info.inputSchema.properties?.generate_audio &&
        (input.generate_audio ?? true) &&
        ctx.speechLanguage &&
        !/^(en|zh)(-|$)/i.test(ctx.speechLanguage) &&
        !ctx.allowTranslatedSpeech
      )
        fail(
          "Kling native speech supports English/Chinese; other speech is translated. Use external audio or explicitly allow translation.",
        );
    }
    const elements = arrayField(input, "elements");
    const videoElements = elements.filter((element) => isObject(element) && element.video_url);
    if (videoElements.length > L.videoElementsMax) fail("Kling permits one video element per request.");
    for (const element of elements) {
      if (!isObject(element)) continue;
      const refs = arrayField(element, "reference_image_urls");
      if (
        !element.video_url &&
        (!element.frontal_image_url || refs.length < L.referenceImagesMin || refs.length > L.referenceImagesMax)
      )
        fail("Kling image elements require frontal image plus 1–3 references.");
      if (element.video_url && (element.frontal_image_url || refs.length))
        fail("Kling element must use a video or an image set.");
    }
    if (operation === "motion-control") {
      if (elements.length > L.motionControlElementsMax || (elements.length && input.character_orientation !== "video"))
        fail("Motion element binding requires video orientation and at most one element.");
      const duration = typeof input.video_url === "string" ? ctx.media[input.video_url]?.durationSec : undefined;
      if (
        duration &&
        duration > L.motionControlMaxDurationSec[input.character_orientation === "image" ? "image" : "video"]
      )
        fail("Motion reference exceeds orientation duration limit.");
    }
    if (
      operation.startsWith("video-to-video") &&
      elements.length + arrayField(input, "image_urls").length > L.videoToVideoCombinedMax
    )
      fail("Kling video-to-video allows at most four elements/reference images combined.");
  },
};
