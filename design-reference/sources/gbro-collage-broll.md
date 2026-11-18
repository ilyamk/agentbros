# gbro-collage-broll

- **URL:** https://github.com/pyang5166/gbro-collage-broll
- **Commit studied:** `a1a4ee2e2abf7d44e460026b706d0c72c2cf8a91` (shallow clone, 2026-11-11). Read only; none of its scripts were run and none of its dependencies installed.
- **Licence as stated:** Apache-2.0 (`LICENSE`).
- **What it is:** one agent skill in Chinese (`SKILL.md`, a Codex `agents/openai.yaml`, four gate evals) that turns a ~5 s voiceover line into a 9:16 halftone paper-collage B-roll clip: metaphor approval → image-gen still approval → Gemini Omni Flash first/last-frame video, with ffmpeg QA. No reusable rendering code; its Python scripts only call Google's video API.

## Taken

| What | Where it lives | Why |
|---|---|---|
| The look (flat colour field, black-and-white halftone photo cut-outs, cardstock accents, cream keylines, soft paper shadows, grain) and the motion (assemble from empty, piece by piece, snap into place, hold the finished frame), rebuilt as frame-driven layers with stop-motion on twos | Block `paper-collage-assemble`, `src/motion/library/effects/PaperCollage.tsx` (exports `Halftone`, `KeylineFilter`) | The library had no collage, cut-out or halftone treatment. Layers give exact timing and editability that their single animated still cannot (their own "when not to use" points to layered tools for this) |
| Metaphor compression (meaning, feeling, verb, one-sentence metaphor, 3–6 objects, assembly order), colour-field-by-meaning table, style signature and avoid list, first/last-frame prompt and its failure fixes, QA (empty first frame, per-second strip, end frame against approved still, regenerate stills with fake glyphs) | `.agents/skills/motion-library/references/paper-collage.md`; linked from `.agents/skills/motion-library/SKILL.md` | Craft knowledge for writing and directing metaphor B-roll; translated into British English and tightened |
| The layered asset route (one object per generated image → `scripts/rmbg.ts` → `src`) | Same reference, section 4 | Reuses our generation, budget and background-removal path instead of a new CLI |

The sample cut-out `public/shared/collage/phone-cutout.png` is derived from the iPhone 16 Pro Black Titanium portrait mockup (screen filled with a grey gradient); it shares that mockup's provenance gap (likely Apple Design Resources, see CREDITS.md section 3). Nothing visual was copied from gbro-collage-broll.

## Rejected

- **Three-gate approval protocol and partial batch approval as a workflow**: our film chain already gates concept, look and build with user approvals; a second protocol would conflict. The idea is kept as one sentence in the reference.
- **`generate_video.py`, `upload_file.py`, `generate_veo_first_last.py`, `check_setup.sh`**: direct Google SDK calls and a shared venv outside `providers/`, `jobs/` and `budget/`. The first/last-frame route goes through `scripts/generate-video.ts` (`end_image_url`).
- **Fixed model choice (`gemini-omni-flash-preview`), 720×1280 at 24 fps delivery, `~/hyperframes-projects` layout, Beijing-time folder naming**: specific to their setup; our formats and project paths apply.
- **Demo GIFs** (about 7 MB): reference only, not needed in the repo.
- **Evals and `agents/openai.yaml`**: test their gate behaviour and Codex packaging, not craft.
