/** Strings of the timeline's visualisations section (RU-V); keys and placeholders as in `visualisationsEn`. */
import type { Widen } from "@/i18n/types";

export const visualisationsEn = {
  title: "Prepared visualisations",
  description: "Prepared visualisations mounted in this project, with their factual status.",
  none: "No prepared visualisations mounted.",
  factualTruth: "Factual truth: {value}",
  scene: "{scene} · {recipe} · {formats} · revision {revision}",
  commands: "Checks to run",
  raw: "Advice as returned",
} as const;

export const visualisationsRu: Widen<typeof visualisationsEn> = {
  title: "Подготовленные визуализации",
  description: "Подготовленные визуализации проекта и их фактический статус.",
  none: "Подготовленных визуализаций нет.",
  factualTruth: "Фактическая достоверность: {value}",
  scene: "{scene} · {recipe} · {formats} · ревизия {revision}",
  commands: "Проверки для запуска",
  raw: "Совет как есть",
};

export const visualisationsZhHans: Widen<typeof visualisationsEn> = {
  title: "预备可视化",
  description: "本项目已挂载的预备可视化及其事实状态。",
  none: "未挂载预备可视化。",
  factualTruth: "事实真实性：{value}",
  scene: "{scene} · {recipe} · {formats} · 修订 {revision}",
  commands: "需运行的检查",
  raw: "原始建议",
};
