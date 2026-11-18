/** Strings of the timeline view's frame (header, status, notices); keys and placeholders as in `commonEn`. */
import type { Widen } from "@/i18n/types";

export const commonEn = {
  title: "Timeline",
  identity: "{project} · revision {revision} · {frames} frames",
  identityUninitialized: "{project} · no timeline journal",
  refresh: "Refresh",
  nonApproval: "Local editing. Snapshot choices do not approve production delivery.",
  statusLabel: "Review status",
  status: { idle: "Not loaded", working: "Working…", ready: "Ready" },
  conflict: "Revision changed. Review the refreshed clip and validate again; no automatic replay.",
  uninitializedTitle: "No timeline journal yet",
  uninitializedHint:
    "Run pnpm timeline:edit --project {project} --init first. Edits and chapters need an initialized timeline; the rest of the review below still works.",
  needsServer: "Timeline review needs the local console server",
  needsServerHint: "Fixture mode has no review data. Open the console from pnpm console.",
  loadFailed: "The review state could not be read",
  retry: "Try again",
  sections: "Review sections",
} as const;

export const commonRu: Widen<typeof commonEn> = {
  title: "Таймлайн",
  identity: "{project} · ревизия {revision} · кадров: {frames}",
  identityUninitialized: "{project} · журнала таймлайна нет",
  refresh: "Обновить",
  nonApproval: "Локальное редактирование. Выбор снимка не одобряет сдачу в производство.",
  statusLabel: "Статус проверки",
  status: { idle: "Не загружено", working: "Выполняется…", ready: "Готово" },
  conflict: "Ревизия изменилась. Посмотрите обновлённый клип и проверьте снова; автоматического повтора нет.",
  uninitializedTitle: "Журнала таймлайна ещё нет",
  uninitializedHint:
    "Сначала выполните pnpm timeline:edit --project {project} --init. Правкам и главам нужен инициализированный таймлайн; остальная проверка ниже работает.",
  needsServer: "Проверке таймлайна нужен локальный сервер консоли",
  needsServerHint: "В режиме фикстур данных проверки нет. Откройте консоль через pnpm console.",
  loadFailed: "Не удалось прочитать состояние проверки",
  retry: "Повторить",
  sections: "Разделы проверки",
};

export const commonZhHans: Widen<typeof commonEn> = {
  title: "时间线",
  identity: "{project} · 修订 {revision} · {frames} 帧",
  identityUninitialized: "{project} · 尚无时间线日志",
  refresh: "刷新",
  nonApproval: "本地编辑。快照选择不代表批准生产交付。",
  statusLabel: "审阅状态",
  status: { idle: "未加载", working: "处理中…", ready: "就绪" },
  conflict: "修订已变化。请查看刷新后的片段并重新验证；不会自动重放。",
  uninitializedTitle: "尚无时间线日志",
  uninitializedHint:
    "请先运行 pnpm timeline:edit --project {project} --init。编辑和章节需要已初始化的时间线；下方其余审阅仍可使用。",
  needsServer: "时间线审阅需要本地控制台服务器",
  needsServerHint: "夹具模式没有审阅数据。请通过 pnpm console 打开控制台。",
  loadFailed: "无法读取审阅状态",
  retry: "重试",
  sections: "审阅分区",
};
