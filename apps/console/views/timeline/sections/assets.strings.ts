/** Strings of the timeline's assets and entities section (RU-AS); keys and placeholders as in `assetsEn`. */
import type { Widen } from "@/i18n/types";

export const assetsEn = {
  title: "Assets and entities",
  description: "Registered assets with origin, licence and billing, and the entity board.",
  search: "Search",
  searchPlaceholder: "Asset ID, origin or licence",
  kind: "Kind",
  kinds: { all: "All", image: "image", video: "video", audio: "audio" },
  count: "{shown} / {total} assets",
  row: "{id} · {kind} · {origin} · licence {licence} · billing {billing}",
  details: "Hash, media and model",
  preview: "Preview original",
  hidePreview: "Hide preview",
  noAssets: "No assets match.",
  entities: "Entity board",
  entityRow: "{kind} / {id} · {name} · latest revision {latest} · canonical {canonical}",
  noCanonical: "none",
  noEntities: "No entity cards.",
} as const;

export const assetsRu: Widen<typeof assetsEn> = {
  title: "Ассеты и сущности",
  description: "Зарегистрированные ассеты с происхождением, лицензией и оплатой, и доска сущностей.",
  search: "Поиск",
  searchPlaceholder: "ID ассета, происхождение или лицензия",
  kind: "Тип",
  kinds: { all: "Все", image: "image", video: "video", audio: "audio" },
  count: "Ассетов: {shown} / {total}",
  row: "{id} · {kind} · {origin} · лицензия {licence} · оплата {billing}",
  details: "Хеш, медиа и модель",
  preview: "Посмотреть оригинал",
  hidePreview: "Скрыть просмотр",
  noAssets: "Подходящих ассетов нет.",
  entities: "Доска сущностей",
  entityRow: "{kind} / {id} · {name} · последняя ревизия {latest} · каноническая {canonical}",
  noCanonical: "нет",
  noEntities: "Карточек сущностей нет.",
};

export const assetsZhHans: Widen<typeof assetsEn> = {
  title: "素材与实体",
  description: "已登记的素材及其来源、许可和计费，以及实体看板。",
  search: "搜索",
  searchPlaceholder: "素材 ID、来源或许可",
  kind: "类型",
  kinds: { all: "全部", image: "image", video: "video", audio: "audio" },
  count: "{shown} / {total} 个素材",
  row: "{id} · {kind} · {origin} · 许可 {licence} · 计费 {billing}",
  details: "哈希、媒体和模型",
  preview: "预览原件",
  hidePreview: "隐藏预览",
  noAssets: "没有匹配的素材。",
  entities: "实体看板",
  entityRow: "{kind} / {id} · {name} · 最新修订 {latest} · 规范修订 {canonical}",
  noCanonical: "无",
  noEntities: "没有实体卡片。",
};
