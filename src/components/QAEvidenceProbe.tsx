import { useLayoutEffect } from "react";
import { useCurrentFrame, useVideoConfig, delayRender, continueRender, cancelRender } from "remotion";
import { spacing } from "../lib/design-tokens";
import { measureCompositionText } from "../lib/qa-evidence/measure";
/** Opt-in diagnostic only; it does not change composition pixels or approve creative quality. */
export function QAEvidenceProbe() {
  const frame = useCurrentFrame(),
    { width, height } = useVideoConfig();
  const format = height > width ? "vertical" : height === width ? "square" : "landscape";
  useLayoutEffect(() => {
    const handle = delayRender("Measure actual text and fonts");
    let active = true;
    let observer: MutationObserver | undefined;
    const measure = () => {
      if (active)
        console.log(
          "QA_EVIDENCE:" +
            JSON.stringify({
              frame,
              width,
              height,
              ...measureCompositionText(width, height, {
                top: spacing.safeTop[format],
                bottom: spacing.safeBottom[format],
                sides: spacing.sidePadding[format],
              }),
            }),
        );
    };
    document.fonts.ready
      .then(() => {
        measure();
        observer = new MutationObserver(measure);
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["style", "class"],
        });
        continueRender(handle);
      })
      .catch((error) => cancelRender(error));
    return () => {
      active = false;
      observer?.disconnect();
      continueRender(handle);
    };
  }, [frame, width, height, format]);
  return null;
}
