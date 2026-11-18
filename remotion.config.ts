import { prepareRenderFontContext, fontContextWebpackAlias } from "./src/lib/font-resources/render-context";
import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.overrideWebpackConfig((currentConfiguration) => {
  const config = enableTailwind(currentConfiguration);
  if (!process.env.VIDEO_FONT_CONTEXT) return config;
  if (!process.env.VIDEO_FONT_PROJECT) throw new Error("Font context requires an explicit project ID");
  const props = { scenes: [] };
  const fonts = prepareRenderFontContext(process.env.VIDEO_FONT_PROJECT, process.env.VIDEO_FONT_CONTEXT, props);
  return fontContextWebpackAlias(config, fonts.modulePath);
});
