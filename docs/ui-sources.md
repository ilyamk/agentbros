# UI sources: pulling real components into the motion library

Last updated: 2026-11-15

Library `ui` blocks look like real products because they port real component systems (shadcn/ui tokens, Geist type, 1px borders, layered shadows) at reading scale. This guide is how an agent pulls a component from a registry and turns it into a frame-driven block. Real screens of a real product come from [capture:app](capture-app.md) instead; a block then only frames them (`ui-camera-read`).

## Where things live

| Path | Role |
|---|---|
| `ui-sources/components.json` | shadcn config with the third-party registries. Committed |
| `ui-sources/pulled/` | What `shadcn add` writes. Git-ignored scratch, outside `tsc` and `pnpm lint`: pulled code imports `motion`, `tw-animate-css` and Radix, which break both |
| `ui-sources/node_modules/` | The pulled components' own dependencies. Git-ignored; never added to the root `package.json` |
| `src/motion/library/ui/surface.tsx` | The ported kit: `surface(tone, accent)` light and dark tokens, `Window`, `Ground`, `Caret`, `useTyping`, `streamWords`, `Badge`, `Kbd`, `Toggle`, `Status`, `Pointer`, `ClickRing`, Geist and Geist Mono |
| `src/motion/library/ui/<Block>.tsx` | Ported blocks, one per file, registered in `ui/index.ts` |

The scratch manifest shares the root project's exact primary/reserve Node and pnpm pins; runtime tests reject drift. Select and check the [project runtime](node-runtime.md) from the repository root before invoking registry tools. Pulled dependencies remain isolated from production rendering.

## Pull a component

From the repository root:

```bash
npx -y shadcn@latest add table command switch -c ui-sources        # shadcn/ui itself
npx -y shadcn@latest add @magicui/animated-list -c ui-sources      # a namespaced registry
npx -y shadcn@latest view @aceternity/placeholders-and-vanish-input -c ui-sources   # read without writing
```

Registries in `ui-sources/components.json`, each tried with one item on 2026-11-11:

| Namespace | URL template | Checked with | Result |
|---|---|---|---|
| shadcn/ui (default) | built in | `switch`, `command`, `table`, `input` | works |
| `@magicui` | `https://magicui.design/r/{name}.json` | `animated-list`, `terminal` | works |
| `@aceternity` | `https://ui.aceternity.com/registry/{name}.json` | `placeholders-and-vanish-input` | works |
| `@cult-ui` | `https://www.cult-ui.com/r/{name}.json` | `text-animate` | works |
| `@motion-primitives` | `https://motion-primitives.com/c/{name}.json` | `text-effect` | works |
| `@reactbits` | `https://reactbits.dev/r/{name}.json` | `CountUp-TS-TW` | works with the `<Name>-TS-TW` variant names; `count-up` is not found |
| `@originui` | `https://originui.com/r/{name}.json` | `comp-01` | **fails**: the site now redirects to coss.com and returns HTML. Pull from the MIT `origin-space/originui` repository at a pinned commit instead |

## MCP servers

`.mcp.json` at the root gives Claude Code two servers:

- **shadcn** (`npx shadcn@4.23.0 mcp --cwd ui-sources`): browse, search and install from every registry above in plain language ("add the animated list from magicui"). It reads `ui-sources/components.json`, so installs land in the scratch area.
- **21st** (HTTP, `https://21st.dev/api/mcp`, the entry `npx @21st-dev/cli@latest init --client claude` prints): the 21st.dev component search. It needs a key: create one in the 21st.dev console, then `export API_KEY_21ST=...` before starting Claude Code, which expands `${API_KEY_21ST:-}` from the environment. Without the key the server is listed but its calls are refused (not tested here). Use only this MCP or the 21st CLI, never a scraper: the site terms forbid automated collection.

Codex reads its own config: add the same two commands under `[mcp_servers]` in `~/.codex/config.toml` if you need them there.

## Port a component to frame time

Pulled code is a reference, never a runtime. What to keep and what to replace:

1. **Keep the look.** Copy the token values (colours, radius, border, shadow, font sizes, spacing) into `surface.tsx` or the block's inline styles. shadcn's `new-york` neutral tokens are already there.
2. **Scale to reading size.** Web components are sized for a page: `text-sm` is 14 px, which is 1.3% of a 1080 frame. Blocks design for a 1080 px short side (`useUnit().u`) with body text at 26-32 px and hero text at 40-52 px. A screen the viewer must read fills the frame or is cropped by `CameraRead` at 2-3x.
3. **Replace every clock.** `motion`/framer-motion, `tw-animate-css`, `animate-*` classes, CSS `transition`, `@keyframes`, `useEffect` timers and `IntersectionObserver` triggers all run on the wall clock and are banned by `pnpm lint` in `src/motion/**`. Rewrite each as a function of `useCurrentFrame()`:
   - a spring entrance (`initial`/`animate`) becomes `progress(frame, at, frames, "expoOut")` or `spring({ frame: frame - at, fps })`;
   - a stagger (`staggerChildren`) becomes `at + index * step`;
   - typing (`setInterval`) becomes `useTyping(text, at, pace, seed)`, which uses the seeded human rhythm of `typingSchedule`;
   - streamed text becomes `streamWords(text, frame, at, wordsPerFrame)`;
   - a hover or click state becomes a frame window (`frame >= clickAt`), with `Pointer` and `ClickRing` when the cursor should show;
   - scroll becomes an eased offset with `VelocityBlur` along the scroll axis (`ui-data-table`).
4. **Drop the behaviour.** Radix state, focus rings, keyboard handling and portals do nothing in a render. Draw the state the shot needs.
5. **Expose the moments.** Every block computes `cues(props)`: one `type` cue at the first key (not one per character), `click` on the press, `reveal` when content lands, `stop`/`land` when a camera or scroll settles.
6. **Record provenance.** Put the source, its URL and licence in `inspiredBy`, for example `shadcn/ui switch on Radix (MIT, https://ui.shadcn.com/docs/components/switch, ported)`. React Bits (MIT + Commons Clause), Magic UI Pro, Aceternity Pro and 21st marketplace items without an OSS licence may be used inside one film but not ported into this library.

Then `pnpm -s library:preview --id <id>`, open the sheet and compare it with a real product screenshot at the same size: if the cell text cannot be read in the thumbnail, it is too small.

## Real product screens

Recreated UI is an impression. For proof beats, capture the real app:

```bash
pnpm capture:app --url https://app.example.com --script steps.json --duration 6 --output out/<id>/capture/hero
```

and frame the PNGs with `CameraRead` (`stage` = the capture's pixel size). See [capture-app.md](capture-app.md); for apps that cannot be put on the injected clock, record with the aiscreen MCP and import the take as footage.
