---
id: prompt-scale-jump
name: The query jumps in scale
intent: A typed question becomes the title of the film on one frame, without a transition.
route: remotion
timing: "bar creeps for 0.7 s (power2.out); typing a character every 1-2 f; on one frame the bar drops and the text re-sets at about 3.5x, centred, caret kept"
curve: steps(1)
primitive: progress
demo: src/motion/library/ui/PromptBar.tsx
sources: ["design-reference/library/ugc-app/techniques.json", "design-reference/library/context-dev/techniques.json", "src/motion/library/ui/PromptBar.tsx"]
status: confirmed
---

**What it does.** A prompt bar grows in and creeps, the query types, and on one frame the bar vanishes and the same text re-sets about 3.5 times larger, centred, with its caret still blinking. Library block: `ui-prompt-bar` with `entrance: "creep"`, `jumpAt` and `jumpScale`.

**When it fits.** Hooks that start from a search or prompt; the question is the headline.

**When it does not.** When the answer must follow in the same bar.

**Timing.** ugc-app: the bar widens fast to F9 then creeps to F23 (power2.out, about 0.77 s); characters every 1-2 frames from 1.1 s; F46 to F47 a one-frame jump, text box 0.03 to about 0.10 of frame height; caret blinks; grain at F60, cut at F63. context-dev t05-punch-in-on-typing-word 4.333-4.767 s (30 fps): a section label typing beside a profile card at top right (cap height 0.037 of frame height at F130) is re-set on the next frame, F131, at about 4.4 times that height (0.165), left-set at x 0.21 rather than centred, with the card and the rest of the interface gone; the hero word restarts about two letters behind the label ("Summar" with the "y" arriving at F130, "Summ" with the "a" arriving at F131) and types on, a glyph about every two frames, each arriving blurred and sharpening over 2-3 frames, with a light-grey body line typing under it. No bar there: the jump works on any typed text, not only a prompt.

**Read.** `src/motion/library/ui/PromptBar.tsx`, `jumpFontSize` in `src/motion/library/ui/ui-plan.ts`.

**Pitfalls.** The re-set is fitted to 88% of the frame width, so a long query lands smaller than 3.5x rather than off stage. Two references (ugc-app, context-dev): confirmed. context-dev's re-set is left-set and its new glyphs blur in; the block centres and does not blur.
