/** Strings of the timeline's QA evidence and outputs section (RU-Q); keys and placeholders as in `qaEn`. */
import type { Widen } from "@/i18n/types";

export const qaEn = {
  title: "QA evidence and outputs",
  description: "Reports, renders and review packs, opened as text or media, never as pages.",
  pin: "Current timeline hash: {hash} · QA reports retain their own captured revision; edits may make them stale.",
  reports: "Reports",
  outputs: "Outputs",
  noReports: "No QA reports or evidence runs yet.",
  noOutputs: "No renders or screenshots in out/ yet.",
  opened: "Opened: {file}",
  packSource: "{kind} · {sha256} · {status}",
  freshness: "Source freshness: {value}",
  page: "Open {kind} page: {frames}",
  frame: "{id} · {time}s · {reasons}",
  original: "Original {id}",
  crop: "Crop {id}/{n}",
  truncated: "Frame metadata truncated; inspect the manifest with vision:inspect.",
  packPreview: "Pack preview",
} as const;

export const qaRu: Widen<typeof qaEn> = {
  title: "Проверки и результаты",
  description: "Отчёты, рендеры и пакеты проверки открываются как текст или медиа, не как страницы.",
  pin: "Текущий хеш таймлайна: {hash} · Отчёты QA хранят свою ревизию; правки могут сделать их устаревшими.",
  reports: "Отчёты",
  outputs: "Результаты",
  noReports: "Отчётов QA и прогонов проверки пока нет.",
  noOutputs: "В out/ пока нет рендеров и скриншотов.",
  opened: "Открыто: {file}",
  packSource: "{kind} · {sha256} · {status}",
  freshness: "Свежесть источника: {value}",
  page: "Открыть страницу {kind}: {frames}",
  frame: "{id} · {time} с · {reasons}",
  original: "Оригинал {id}",
  crop: "Кадрирование {id}/{n}",
  truncated: "Метаданные кадров обрезаны; посмотрите манифест через vision:inspect.",
  packPreview: "Просмотр пакета",
};

export const qaZhHans: Widen<typeof qaEn> = {
  title: "质检证据与输出",
  description: "报告、渲染和审阅包以文本或媒体打开，绝不作为网页。",
  pin: "当前时间线哈希：{hash} · 质检报告保留其采集时的修订；编辑可能使其过时。",
  reports: "报告",
  outputs: "输出",
  noReports: "尚无质检报告或证据运行。",
  noOutputs: "out/ 中尚无渲染或截图。",
  opened: "已打开：{file}",
  packSource: "{kind} · {sha256} · {status}",
  freshness: "来源新鲜度：{value}",
  page: "打开 {kind} 页面：{frames}",
  frame: "{id} · {time} 秒 · {reasons}",
  original: "原始帧 {id}",
  crop: "裁切 {id}/{n}",
  truncated: "帧元数据已截断；请用 vision:inspect 检查清单。",
  packPreview: "审阅包预览",
};
