import assert from "node:assert/strict";
import test from "node:test";
import {
  chatListCues,
  chatListOrders,
  chatListState,
  typingText,
  type ChatListProps,
} from "../src/motion/library/ui/ChatList";
import { settingsListCues, settingsRowFrames, type SettingsListProps } from "../src/motion/library/ui/SettingsList";

const chat: ChatListProps = {
  tone: "light",
  accent: "#2F80ED",
  title: "Чаты",
  rows: [
    { name: "Мая", preview: "До встречи", time: "09:41", unread: 0 },
    { name: "Команда", preview: "Новые макеты", time: "09:30", unread: 3 },
    { name: "Лев", preview: "Спасибо", time: "09:12", unread: 0 },
  ],
  events: [
    { at: 40, row: 2, preview: "Ещё одно", time: "09:43", typingFrames: 10 },
    { at: 20, row: 1, preview: "Готово", unread: 2 },
  ],
  marks: [{ row: 1, at: 60, kind: "read" }],
  typingLabel: "печатает…",
};

test("chat list rows move to the top in event order, whatever order the events are given in", () => {
  assert.deepEqual(chatListOrders(3, chat.events), [
    [0, 1, 2],
    [1, 0, 2],
    [2, 1, 0],
  ]);
});

test("chat list state is a pure function of the frame: typing, landing, unread and read", () => {
  const before = chatListState(chat, 10);
  assert.deepEqual(before.to, [0, 1, 2]);
  assert.equal(before.states[1]!.unread, 3);
  const typing = chatListState(chat, 32);
  assert.equal(typing.states[2]!.typing, true);
  assert.equal(typing.states[1]!.unread, 5);
  assert.equal(typing.states[1]!.preview, "Готово");
  const landed = chatListState(chat, 40);
  assert.equal(landed.states[2]!.typing, false);
  assert.equal(landed.states[2]!.preview, "Ещё одно");
  assert.deepEqual([landed.from, landed.to, landed.moving], [[1, 0, 2], [2, 1, 0], 0]);
  assert.equal(chatListState(chat, 80).moving, 1);
  assert.equal(chatListState(chat, 60).states[1]!.unread, 0);
  assert.deepEqual(chatListState(chat, 33), chatListState(chat, 33));
});

test("typing dots cycle on frame time and keep the film's own label", () => {
  assert.equal(typingText("печатает…", 0), "печатает.");
  assert.equal(typingText("печатает…", 8), "печатает..");
  assert.equal(typingText("typing", 16), "typing...");
});

test("chat list cues: typing start, a hero pop per message, marks", () => {
  const cues = chatListCues(chat);
  assert.ok(cues.some((cue) => cue.frame === 30 && cue.kind === "type"));
  assert.equal(cues.filter((cue) => cue.weight === "hero").length, 2);
  assert.ok(cues.some((cue) => cue.frame === 60 && cue.kind === "reveal"));
});

const settings: SettingsListProps = {
  tone: "dark",
  accent: "#2F80ED",
  title: "Настройки",
  sections: [
    {
      header: "Аккаунт",
      rows: [
        { icon: "users", title: "Профиль", control: "chevron" },
        { icon: "bell", title: "Уведомления", control: "toggle", on: true },
      ],
    },
    { header: "Общие", rows: [{ icon: "home", title: "Язык", value: "Русский", control: "chevron" }] },
  ],
  start: 6,
  step: 3.5,
  flips: [{ section: 0, row: 1, at: 40 }],
  select: { section: 1, row: 0, at: 50, options: ["Русский", "English"], from: 0, chosen: 1, chooseAt: 70 },
};

test("settings rows land one by one across sections", () => {
  assert.deepEqual(settingsRowFrames(settings), [[6, 10], [13]]);
});

test("settings cues: rows, the switch and the checkmark", () => {
  const cues = settingsListCues(settings);
  assert.ok(cues.some((cue) => cue.frame === 40 && cue.kind === "click"));
  assert.ok(cues.some((cue) => cue.frame === 70 && cue.kind === "click" && /English/.test(cue.label ?? "")));
  assert.ok(cues.some((cue) => cue.frame === 13 && cue.kind === "land"));
});
