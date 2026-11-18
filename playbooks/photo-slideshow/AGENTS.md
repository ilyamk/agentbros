# Photo slideshow playbook

Last updated: 2026-11-15

Choose it for a film made from the user's photos (and a few short clips) to music: a memory or holiday slideshow, an anniversary or team montage, a portfolio or catalogue reel, a carousel turned into a video, a real-estate photo tour. Video footage of an event is [event-recap](../event-recap/AGENTS.md); stock or b-roll is [stock-montage](../stock-montage/AGENTS.md); an ad selling a product is [product-promo](../product-promo/AGENTS.md); type and shapes with no photos are [motion-design](../motion-design/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type footage --playbook photo-slideshow --product <notes.md>
pnpm asset:import --project <id> --input <photo.jpg> --origin manual --metadata <rights.json>   # every photo and clip
pnpm film:next --project <id>          # repeat: do what it says
```

`--product` takes a notes file only (who, where, when, the order, names and dates to show); never the photos, which would go to the truth step as product sources, and never clips, which make film:init suggest the own-footage route. `--profile promo` for a reel of 45 s or less. A scrapbook or paper look, or a portfolio laid out as a board: `--type collage`, same flags. Template recipes put one photo on each of five beats, so they do not fit a slideshow.

## What good looks like

- An order a viewer can follow: chronology, a journey through a place, or a story (arrival, the best day, the people, the last evening); each photo earns its place.
- Every move starts and ends on something: a face, a hand, a detail, a doorway, never a random zoom to the centre.
- Holds vary with content: a portrait or the key photo holds longer, a run of similar shots goes fast on the beat; cuts sit on the music's grid.
- Mixed orientations are decided per photo (crop, move across, or a blurred fill behind), and no face is cropped through.
- One grade across phones and years; dates and captions small, consistent and readable.
- The last photo is complete and still on the final downbeat.

## Method

1. **Intake.** brief-collector asks this playbook's `intake` questions. Who may appear and whether the music is cleared decide the platform (YouTube blocks a Short over 1 minute with any copyright claim).
2. **Import.** `asset:import` converts iPhone HEIC to JPEG itself (sips on macOS, else ffmpeg) and keeps the original name; where neither can, it refuses with the exact command. Rights sidecar: the user's own photos `{"rights":{"licence":"owner","commercialAllowed":true}}` only when they confirm they took them; otherwise ask. Clips: `pnpm footage:shots --input <clip> --output-dir <dir> --strips` to choose 2-4 s selects.
3. **Select and order** (asset-planner, material step). Drop near-duplicates, blur and closed eyes; keep the best of each burst. Order by the story the user named; capture dates set chronology only when the user confirms them. Real estate: a walk from the street through the front door, living spaces, kitchen, bedrooms, bathrooms, outside, ending on the best exterior or view (house rule).
4. **Find each subject.** After step 3, `pnpm photo:focus --input <a.jpg,b.jpg,...> --output <focus.json>` with the imported files in film order (names map back through the asset registry's `originalFilename`; local YuNet, free): per photo its displayed size, faces, and a start and end crop per format that keep every face whole, with `fill: "blur"` where a cover crop would cut one; neighbours alternate push in and pull out. `--duration` is the hold, `--easing` the curve. With no face (a room, a dish), the motion-director names the subject by eye from a `motion:still`.
5. **Music first.** The user chooses the track (`pnpm music`, sound-director). `pnpm audio:map --input <track> --output <map.json>`; slots with `pnpm edit:plan --map <map.json> --style calm` for memories and tours, `punchy` for a portfolio or carousel reel; `music:backtime` fits the end.
6. **Set the targets for a slideshow.** A photo film holds longer than the craft rules' montage averages, so set them by hand: `pnpm film:targets --project <id> --manual --reason "photo slideshow" --median-shot 2.5:5 --longest-still :2 --cuts-per-minute 10:25` (house rule, starting point; the portfolio variant has its own). `:2` leaves room for the final photo to settle still; every other photo keeps moving. The last shot declares `readingHoldSec` for its settle, so `plan:check` does not count it as a held still.
7. **Plan each photo's move** (motion-director, motion-plan). Every photo shot names a moving `camera`, or `plan:check` fails it as a held still. The move follows the subject: push in to a face, pan from one person to the one the moment is about (the [Ken Burns effect](https://en.wikipedia.org/wiki/Ken_Burns_effect)), pull out to reveal a place, tilt up a building. Alternate direction between neighbours; no two photos in a row with the same move. Holds (house rules): 3-5 s for a memory photo, up to 6 s for the key photo (craft rules: a treatment goes stale after about 6 s), 1-2 s for a beat run, 3-4 s per room.
8. **Move fast enough to read as motion.** `measure` counts a stretch as frozen when under 0.2% of pixels change (`STILL_CHANGED_SHARE` in `src/lib/film/readings.ts`). Measured on one portrait with `film:targets --video`: a zoom of 1% a second left a third of a 4 s shot frozen; 2% a second left none. `photo-move` keeps at least 2% a second (`minSpeed`) and an eased curve a third of its speed at the ends; renders of both measured no frozen stretch.
9. **Fill per photo and format** (design-director, look step). Start from `photo:focus`'s `fill`: a crop and move when the subject allows, otherwise the photo whole over a blurred, darkened copy (blur-fill), never black bars. A clip of the other orientation: `clip-fill`.
10. **Build** (motion-engineer). One `photo-move` per photo inside `film-finish`: `src`, `imageWidth`, `imageHeight`, `from`, `to`, `fill` from `focus.json` for the format; edit a crop only to aim the move at what the moment is about. Transitions: a cut on the beat by default; `slice-panels`, `whip-pan` or `light-burn` only where the music changes section. Collage boards: `scene-bento-collage` (photos via `src`) or `paper-collage-assemble` (vertical, cut-outs from `pnpm matte`). A title behind the person in a portrait: `subject-occlusion`.
11. **Grade and type.** One grade across all photos, applied in the build. Captions and dates small (craft rules' caption scale, about 10% of the width), placed off faces, each held for its reading time. Real estate: rooms named only if the user asks; Zillow Showcase allows branding only in the introduction.
12. **Prove it.** `pnpm motion:strip --input <mp4> --output <jpg> --phone` for faces and text; `plan:check`, `motion:check`, then the chain's measure and critic.

## Tools

- `asset:import`, `footage:shots`: photos and clips in, with rights. `matte`: subject or person cut-outs, free and local ([matte](../../docs/matte.md)); `rmbg` (or `upscale`; both take a verified `--endpoint`) only when the user approves paying for it.
- `photo:focus`, `reframe:track`: crops; [native detector](../../docs/local-macos.md) when available.
- `audio:map`, `edit:plan`, `edit:snap`, `music:backtime`: the grid.
- `film:targets --manual`, `plan:check`, `motion:still`, `motion:strip`, `motion:check`: the slideshow-specific pace and proof.
- Blocks: `photo-move`, `clip-fill`, `film-finish`, `scene-bento-collage`, `paper-collage-assemble`, `parallax-rig` (2.5D depth from a photo cut into layers with `matte`), `subject-occlusion` (a title behind the subject), `slice-panels`, `whip-pan`, `light-burn`, `type-hero-word` for a title card.
- Skills: `cinematography` (framing, grade), `editorial-storytelling` (order, holds), `harness-asset-import`.

## Anti-patterns

- Every photo the same length with the same centre zoom: the template slideshow.
- A move that ends on empty wall or cuts through a face; a pan against the direction the people look.
- Crossfades on every join; a page-turn or cube transition.
- Black bars in a vertical feed; a blurred fill so bright it competes with the photo.
- Twenty near-identical shots of one moment; a closed-eye or blurred photo kept because it is the only one.
- A slow eased zoom that measures as frozen; an unlicensed chart song on a Short over a minute.

## References

- [Ken Burns effect](https://en.wikipedia.org/wiki/Ken_Burns_effect): zoom in on subjects of interest and pan from one subject to another.
- [YouTube Help, Shorts up to 3 minutes](https://support.google.com/youtube/answer/15424877): square or vertical up to 3 minutes; a Short over 1 minute with an active copyright claim is blocked worldwide.
- [Instagram for Creators](https://creators.instagram.com/blog/the-latest-with-instagram): reels up to 3 minutes eligible for non-followers; photos and carousels with audio may appear in the Reels tab.
- [Zillow Showcase video, Aryeo help](https://support.aryeo.com/en/articles/12510693-what-is-showcase-video): 120 s or less, horizontal or vertical, listing only, branding only in the introduction, no unlicensed music.
- YouTube loudness reference about -14 LUFS, measured, not stated by YouTube (practitioner): [Meterplugs](https://www.meterplugs.com/blog/2019/09/18/youtube-changes-loudness-reference-to-14-lufs.html).
- Frozen-motion measurement: `src/lib/film/readings.ts`, `src/lib/film/evidence.ts`; this playbook's 1% and 2% a second figures were measured with `film:targets --video` on renders of one public-domain portrait (2026-11-13).
- Hold times per photo are house rules; editor defaults (5 s a still) are practitioner conventions, not platform rules.

## Done when

- Every photo and clip is imported with rights the user confirmed; the order and captions are the user's.
- `plan:check` passes with every photo shot moving; the sync map has no `miss`; `measure` shows no frozen stretch beyond `--longest-still`, and only the final settle is still.
- A phone strip of every format shows no face cropped and every caption readable.
- The last frame is complete and still on the music's end.
- The user approved the music and the film; the [strict delivery](../../docs/delivery.md) check succeeds.
