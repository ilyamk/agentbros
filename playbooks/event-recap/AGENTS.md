# Event recap playbook

Last updated: 2026-11-13

**Draft.** Choose it for an aftermovie or recap of an event the user held or filmed (conference, meetup, party, wedding, concert, offsite): many clips from several devices cut to music, a few soundbites, 30 s to 3 min, plus vertical cut-downs. A montage of licensed stock is [stock-montage](../stock-montage/AGENTS.md); clips cut out of one long recording are [shorts-from-long](../shorts-from-long/AGENTS.md); one speaker's recording is [footage-edit](../footage-edit/AGENTS.md); a film announcing an event still to come is [teaser-trailer](../teaser-trailer/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type footage --playbook event-recap --product <clips folder> <event-facts.md>
pnpm film:next --project <id>          # repeat: do what it says
```

The route is the bespoke chain with the `footage` type, because only it cuts many clips to a music map; `footage:next` edits one recording around its speech. `film:init` will suggest the own-footage route for supplied media: keep this project, the film is cut to music. `<event-facts.md>` holds the programme, names as published, numbers and the filming notice; the `truth` step treats the event as the product. Add `--profile promo` for a recap of 45 s or less. The method of cutting to the audio map is [stock-montage](../stock-montage/AGENTS.md) steps 4-6; this file adds what event footage needs.

## What good looks like

- A shape the viewer feels: arrival, build, peak, close. Hook in the first seconds without spending the peak (the fireworks or the headline moment belong 60-80% in, as in [craft rules](../../design-reference/craft-rules.md) Structure).
- The selects are the event's best seconds, not its schedule: every shot has a face, a movement or a reaction; static wides only to place the venue once.
- Clips from phones, cameras and drones read as one crew: one grade, one frame rate, no judder.
- Two to four soundbites at most, each a whole thought, intelligible over ducked music, captioned with the speaker's name.
- Cuts land on the music (sync map with no `miss`) but follow action inside the bar: a jump, a toast, a drop.
- No one appears who opted out, no child without a parent's consent, and every contributor's clip is cleared.

## Method

1. **Intake and consent first.** Ask the playbook's `intake` questions in one message with the brief-collector. Large events usually rely on a written filming notice and legitimate interests; small ones need consent, such as coloured lanyards (Irish DPC). Opt-outs and children are cut or blurred, never kept. The asset-planner writes a consent line per identifiable person or group in `material.md` and the basis (notice, consent, contributor) in each item's `licence`.
2. **Register every clip once.** `pnpm asset:import --project <id> --input <clip> --origin manual --metadata <sidecar.json>` with who shot it on which device; the `harness-asset-import` skill holds the sidecar. Check each clip with `ffprobe -show_entries stream=r_frame_rate,avg_frame_rate,color_transfer,width,height`: note variable rate, HDR (`arib-std-b67` or `smpte2084`) and portrait clips before selecting.
3. **Selects from hours, by sheets.** Run `pnpm footage:shots --input <clip> --output-dir <dir> --fps 30 --strips` per clip (it also normalises variable rate phone footage); read the `storyboard-NN.jpg` sheets and mark selects with in and out points in `material.json`. For a long stage recording, `media:ingest` with a transcript and `media:selects --query "<phrase>"` find a soundbite by its words. Aim for several candidates per beat and a short list the user can scan.
4. **Structure on paper.** Group selects into arrival, build, peak and close per the editorial-storytelling skill; chronology is the default, broken only for the hook. The motion-director places them on the music in `motion-plan.json`.
5. **Music and cut.** The sound-director shortlists a track with strong dynamics licensed for every placement; venue or band music under the clips is a rights question, and a YouTube Short over one minute with a claim is blocked. Then `audio:map`, `edit:plan`, `edit:snap`, `music:backtime`, as in stock-montage.
6. **Soundbites.** Transcribe candidate clips with `pnpm speech:local --input <clip> --output <json>` (free); when two devices recorded one speech, `pnpm multicam:sync --inputs <a> <b> --output <json>` lines them up so the cleaner audio is used. In the sound step, `audio:mix --duck-db` dips the music under each bite (root rule: music 0.25-0.35 under speech); keep a bed of crowd sound under the track. Captions with `caption-clean-sentence`, names as on the programme.
7. **Conform and grade.** Slow motion uses the 50-120 fps original at a reduced `playbackRate` on `<Video>`; check every clip's motion with `pnpm motion:strip --input <mp4> --output <jpg>`. The design-director sets one grade per device group (CSS filter per clip, set in `design.json`), judged on stills from `film:stills` with clips from each device side by side.
8. **Cut-downs are re-edits.** Each vertical or square version is its own composition with its own selects: portrait phone clips, or landscape clips with a crop path from `pnpm reframe:track --input <clip> --format vertical --output <json> --shots <shots.json>`; a clip of the other orientation whose subject a crop would cut plays whole in `clip-fill` (blurred, darkened, muted copy behind it), in the master too. Never a centre crop of the master; render each with `film:render --composition`.
9. **Names and numbers.** One number with `type-number-race`, the event's name and date with `type-hero-word`, each soundbite's speaker with `type-lower-third` (name and role as on the programme, `anchor: "top"` in vertical when captions hold the lower band), inside `film-finish`; small captions over picture otherwise.

## Tools

| Tool | Why here |
|---|---|
| `asset:import`, `harness-asset-import` | Each contributor's clip registered once with its origin |
| `footage:shots`, `motion:strip` | Storyboard sheets per clip for selects; frame rate conversion; judder check |
| `speech:local`, `media:ingest`, `media:selects` | Find soundbites by their words, free |
| `multicam:sync` | One moment from two devices: pick the better sound |
| `audio:map`, `edit:plan`, `edit:snap`, `music:backtime` | Cuts on the music; the end on the last downbeat |
| `audio:mix` | Music ducked under bites; crowd bed |
| `reframe:track`, `film:render`, block `clip-fill` | Vertical cut-downs from landscape clips, one composition each; portrait clips in a landscape film over a blurred fill |
| Blocks `type-hero-word`, `type-number-race`, `caption-clean-sentence`, `film-finish` | The few type moments over picture |

## Anti-patterns

- The schedule in order, every talk getting its shot: a recap is the feeling, not minutes of the agenda.
- Spending the peak in the opening seconds, or ending on a fade instead of the last downbeat.
- Phone and camera clips cut together ungraded; HDR phone clips washed out next to SDR ones.
- A soundbite cut mid-sentence to fit a bar, or music loud over it.
- The organiser's playlist left under the film, or a platform-library track reused on another platform.
- An opted-out guest, a child or a private moment kept because it was a good shot.
- A vertical version made by centre-cropping the landscape master.

## References

- Irish Data Protection Commission, promotional photos at events (large events: notice and legitimate interests; small events: consent, lanyards): [FAQ](https://dataprotection.ie/en/faqs/topical-data-protection-issues/when-i-am-attending-public-event-can-organisers-take-promotional-photographs-me-without-my-consent)
- ICO, legitimate interests test: [guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/legitimate-interests/what-is-the-legitimate-interests-basis/); personal versus public posting of event photos: [ICO](https://ico.org.uk/for-the-public/schools/photos/)
- YouTube Help, three-minute Shorts; a Short over one minute with a Content ID claim is blocked: [support page](https://support.google.com/youtube/answer/15424877?hl=en)
- TikTok, Commercial Music Library: businesses may not use the general library: [help](https://ads.tiktok.com/help/article/commercial-music-library?lang=en)
- Meta Sound Collection licensed only inside Meta's apps (third-party summary): [Cloud Cover Music](https://cloudcovermusic.com/music-licensing-guide/facebook-sound-collection)
- Instagram three-minute Reels, January 2025: [Lindsey Gamble](https://lindseygamble.com/blog/instagram-three-minute-reels)
- LinkedIn video specs, 1:2.4 to 2.4:1, up to 15 min: [help](https://www.linkedin.com/help/linkedin/answer/a548372)
- Rules of thumb from practitioners: three acts, do not open on the climax, tracks with dynamics, live crowd sound, keep it short ([Robin Piree](https://robinpiree.com/blog/how-to-make-the-perfect-music-festival-after-movie)); recaps about a minute, short interviews over visuals, chronology by default ([Canon](https://www.canon.ca/en/Pro-Inspiration/Five-steps-for-producing-engaging-event-recap-videos)).
- Duration bands in `profiles` are house rules, starting points, inside the platform limits above.

## Done when

- Every identifiable person has a consent line in `material.md`; every clip has an import record and a contributor.
- The sync map has no `miss`; frame strips across cuts show no judder; stills from each device match in grade.
- Each soundbite was approved by the user and is captioned; the user listened to the mix (agents cannot hear).
- Stage strobes and flashing lights: `pnpm flash:check --render <mp4>` reports no `FLASH_RISK`, or that stretch is recut.
- Every requested cut-down is its own render; the [strict delivery](../../docs/delivery.md) check succeeds.
- Still missing for `ready`: a benchmark project; a repo command that converts HDR phone clips to SDR (today a manual ffmpeg step); a grade-matching tool across devices; a consent field in the asset or material schema; a cross-clip selects index (`footage:shots` runs one clip at a time).
