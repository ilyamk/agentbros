/** Strings of the timeline's chapters section (RU-C); keys and placeholders as in `chaptersEn`. */
import type { Widen } from "@/i18n/types";

export const chaptersEn = {
  title: "Chapters",
  description:
    "Inspect exact chapter slices and cache decisions. Inspection never renders, writes caches or approves delivery.",
  format: "Format",
  formats: { landscape: "landscape", vertical: "vertical", square: "square" },
  inspect: "Inspect chapters",
  chapter: "Chapter",
  option: "{title} · {start}–{end}",
  notInspected: "Not inspected",
  invalidated: "Not inspected for this revision",
  inspecting: "Inspecting…",
  absent: "No chapter manifest; existing project remains compatible.",
  ready: "Revision {revision} · manifest SHA {sha} · {format} · read-only",
  readyMeta: "Journal SHA {journal} · manifest revision {manifestRevision}",
  noChapters: "No chapters",
  needsTimeline: "Initialize timeline before chapter inspection",
  candidate: "A cache receipt is a candidate until the planner verifies it.",
} as const;

export const chaptersRu: Widen<typeof chaptersEn> = {
  title: "Главы",
  description: "Точные срезы глав и решения о кэше. Проверка ничего не рендерит, не пишет кэш и не одобряет сдачу.",
  format: "Формат",
  formats: { landscape: "горизонтальный", vertical: "вертикальный", square: "квадратный" },
  inspect: "Проверить главы",
  chapter: "Глава",
  option: "{title} · {start}–{end}",
  notInspected: "Не проверено",
  invalidated: "Для этой ревизии не проверено",
  inspecting: "Проверяю…",
  absent: "Манифеста глав нет; существующий проект остаётся совместимым.",
  ready: "Ревизия {revision} · SHA манифеста {sha} · {format} · только чтение",
  readyMeta: "SHA журнала {journal} · ревизия манифеста {manifestRevision}",
  noChapters: "Глав нет",
  needsTimeline: "Инициализируйте таймлайн перед проверкой глав",
  candidate: "Квитанция кэша — лишь кандидат, пока планировщик её не проверит.",
};

export const chaptersZhHans: Widen<typeof chaptersEn> = {
  title: "章节",
  description: "检查精确的章节切片和缓存决策。检查从不渲染、写缓存或批准交付。",
  format: "画幅",
  formats: { landscape: "横屏", vertical: "竖屏", square: "方形" },
  inspect: "检查章节",
  chapter: "章节",
  option: "{title} · {start}–{end}",
  notInspected: "未检查",
  invalidated: "本修订尚未检查",
  inspecting: "检查中…",
  absent: "没有章节清单；现有项目保持兼容。",
  ready: "修订 {revision} · 清单 SHA {sha} · {format} · 只读",
  readyMeta: "日志 SHA {journal} · 清单修订 {manifestRevision}",
  noChapters: "没有章节",
  needsTimeline: "检查章节前请先初始化时间线",
  candidate: "缓存收据在规划器验证之前只是候选。",
};
