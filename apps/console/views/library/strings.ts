/**
 * Library page and static snapshot strings (RFC 0004 WP15, US21, US22, D18), mounted as `library` and `snapshot` in
 * every console dictionary so i18n.test.ts checks them. Block titles, descriptions and credits are shown as written.
 */
import type { Widen } from "@/i18n/types";

export const libraryEn = {
  nav: "Library",
  title: "Motion library",
  intro: "Ready motion-design blocks to build scenes from. Read-only: agents pick blocks with pnpm library:list.",
  search: "Search the library",
  searchPlaceholder: "Title, tag or description",
  categories: "Categories",
  all: "All",
  count: { one: "{n} block", other: "{n} blocks" },
  noMatch: "No block matches the search.",
  empty: "The catalogue has no blocks.",
  loadFailed: "The library could not be read",
  retry: "Try again",
  unavailable: "The library is served by the console server; this page has no server.",
  formats: "Formats",
  frames: "{n} frames",
  importPath: "Import",
  credits: "Learned from",
  tags: "Tags",
  usage: "Usage",
  noPreview: "No preview still",
  previewOf: "Preview of {title}",
};

export const libraryRu: Widen<typeof libraryEn> = {
  nav: "Библиотека",
  title: "Библиотека моушн-блоков",
  intro: "Готовые блоки моушн-дизайна для сцен. Только чтение: агенты выбирают блоки через pnpm library:list.",
  search: "Поиск по библиотеке",
  searchPlaceholder: "Название, тег или описание",
  categories: "Категории",
  all: "Все",
  count: { one: "{n} блок", few: "{n} блока", many: "{n} блоков", other: "{n} блока" },
  noMatch: "Ни один блок не подходит под поиск.",
  empty: "В каталоге нет блоков.",
  loadFailed: "Не удалось прочитать библиотеку",
  retry: "Повторить",
  unavailable: "Библиотеку отдаёт сервер консоли; у этой страницы сервера нет.",
  formats: "Форматы",
  frames: "{n} кадров",
  importPath: "Импорт",
  credits: "Чему научились у",
  tags: "Теги",
  usage: "Применение",
  noPreview: "Нет превью",
  previewOf: "Превью: {title}",
};

export const libraryZhHans: Widen<typeof libraryEn> = {
  nav: "素材库",
  title: "动效模块库",
  intro: "用于搭建场景的现成动效设计模块。只读：智能体通过 pnpm library:list 选择模块。",
  search: "搜索模块库",
  searchPlaceholder: "标题、标签或描述",
  categories: "类别",
  all: "全部",
  count: { other: "{n} 个模块" },
  noMatch: "没有符合搜索的模块。",
  empty: "目录中没有模块。",
  loadFailed: "无法读取模块库",
  retry: "重试",
  unavailable: "模块库由控制台服务器提供；此页面没有服务器。",
  formats: "画幅",
  frames: "{n} 帧",
  importPath: "导入",
  credits: "借鉴自",
  tags: "标签",
  usage: "用法",
  noPreview: "没有预览图",
  previewOf: "{title} 的预览",
};

export const snapshotEn = {
  mode: "Snapshot",
  banner: "Read-only snapshot of {project}, taken {time}. Nothing on this page changes the project.",
  readOnly: "This is a static snapshot: decisions, cards and controls are off.",
  mediaOmitted: "Media not included in the snapshot",
  openLocal: "Open the local file (works next to the checkout only)",
};

export const snapshotRu: Widen<typeof snapshotEn> = {
  mode: "Снимок",
  banner: "Снимок {project} только для чтения, сделан {time}. Ничто на этой странице не меняет проект.",
  readOnly: "Это статичный снимок: решения, карточки и управление отключены.",
  mediaOmitted: "Медиа в снимок не включены",
  openLocal: "Открыть локальный файл (работает только рядом с репозиторием)",
};

export const snapshotZhHans: Widen<typeof snapshotEn> = {
  mode: "快照",
  banner: "{project} 的只读快照，生成于 {time}。此页面上的任何操作都不会更改项目。",
  readOnly: "这是静态快照：决策、卡片和控制均已关闭。",
  mediaOmitted: "快照中不包含媒体",
  openLocal: "打开本地文件（仅在仓库旁可用）",
};
