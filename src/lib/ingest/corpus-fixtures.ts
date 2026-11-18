/** Fixed existing project originals; no network discovery or new generation. */
export const CORPUS_REFERENCES = {
  affirmations: {
    file: "public/projects/affirmations/project.json",
    hash: "5b02fc908ea1aab18ac4b176aca46edaa66c027c9c4f7b86ac2fbc41b6402ff6",
  },
  whatsapp: {
    file: "public/projects/chat-outreach/project.json",
    hash: "7a916743e86848b36cb73182a4b61fa922575bbc315e967d897dd72982c65668",
  },
  presenter: {
    file: "public/projects/btc-averaging-down/pipeline/narrator-direction.json",
    hash: "e3452d0116c842f140c70df66d7cc1dc66baafbf1009cd4c3661ead6c1187dfa",
  },
} as const;
export const EXISTING_CORPUS = [
  {
    id: "affirmations-hook",
    file: "public/projects/affirmations/voiceover/hook.mp3",
    bytes: 61902,
    hash: "7fa2769f28337d62da436dab0f680bde6b24ba65d4c5e5903c6081d8ee697ede",
    language: "en",
    reference: "affirmations",
    scene: "hook",
  },
  {
    id: "affirmations-pain",
    file: "public/projects/affirmations/voiceover/pain.mp3",
    bytes: 61902,
    hash: "c04b6020689d1c1ddd48c0e102847404a5ecb9021a23e2831a20a3fb19e1012c",
    language: "en",
    reference: "affirmations",
    scene: "pain",
  },
  {
    id: "affirmations-solution",
    file: "public/projects/affirmations/voiceover/solution.mp3",
    bytes: 56050,
    hash: "fde1a9059bb542e5ba913786a06b849b82d8f42fd86514245fc303b9c0569a83",
    language: "en",
    reference: "affirmations",
    scene: "solution",
  },
  {
    id: "whatsapp-hook",
    file: "public/projects/chat-outreach/voiceover/hook.mp3",
    bytes: 50199,
    hash: "84d70067828b9113f2ab3e71e4d71e815f824fb9d11dd95503ff8a75d430f1fc",
    language: "en",
    reference: "whatsapp",
    scene: "hook",
  },
  {
    id: "whatsapp-pain",
    file: "public/projects/chat-outreach/voiceover/pain.mp3",
    bytes: 45601,
    hash: "a22de2ee3082e1713f6d7df8769c85db5e8b0b1c5777c2670db8b2115b51adb6",
    language: "en",
    reference: "whatsapp",
    scene: "pain",
  },
  {
    id: "btc-presenter",
    file: "public/projects/btc-averaging-down/talking-head/full.mp4",
    bytes: 8193128,
    hash: "90ed8f8a0e0f321f65a47a0edd6241dfe7961af39f1d67608328ee9f0363b7b4",
    language: "ru",
    reference: "presenter",
    scene: "fullScript",
  },
] as const;
