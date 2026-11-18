/** Strings of the timeline's budget and liability section (RU-B); keys and placeholders as in `budgetEn`. */
import type { Widen } from "@/i18n/types";

export const budgetEn = {
  title: "Budget and liability",
  description: "Durable job reservations and receipts; unknown billing stays unknown.",
  liability: "Unknown billing remains unknown. Reservations are planning bounds; actual amounts require receipts.",
  jobs: "Durable operations",
  job: "{id} · {state} · reserved ${reserved} · actual {actual}",
  actualUnknown: "unknown (no receipt)",
  actualKnown: "${amount}",
  noJobs: "No durable operations recorded. This does not imply asset billing is free.",
  uninitialized: "No operation ledger in this project yet (uninitialized).",
  summary: "Ledger summary",
  noControls: "Read-only: this view has no generation, provider, retry or credential controls.",
} as const;

export const budgetRu: Widen<typeof budgetEn> = {
  title: "Бюджет и ответственность",
  description: "Резервы и квитанции задач; неизвестная оплата остаётся неизвестной.",
  liability:
    "Неизвестная оплата остаётся неизвестной. Резервы — это границы планирования; фактические суммы требуют квитанций.",
  jobs: "Долговременные операции",
  job: "{id} · {state} · резерв ${reserved} · факт {actual}",
  actualUnknown: "неизвестно (нет квитанции)",
  actualKnown: "${amount}",
  noJobs: "Долговременных операций нет. Это не значит, что ассеты были бесплатными.",
  uninitialized: "В проекте ещё нет журнала операций (не инициализирован).",
  summary: "Сводка журнала",
  noControls: "Только чтение: здесь нет генерации, провайдеров, повторов и учётных данных.",
};

export const budgetZhHans: Widen<typeof budgetEn> = {
  title: "预算与责任",
  description: "持久任务的预留和收据；未知计费保持未知。",
  liability: "未知计费保持未知。预留只是规划上限；实际金额需要收据。",
  jobs: "持久操作",
  job: "{id} · {state} · 预留 ${reserved} · 实际 {actual}",
  actualUnknown: "未知（无收据）",
  actualKnown: "${amount}",
  noJobs: "没有记录持久操作。这并不意味着素材计费为零。",
  uninitialized: "本项目尚无操作账本（未初始化）。",
  summary: "账本摘要",
  noControls: "只读：此视图没有生成、供应商、重试或凭据控件。",
};
