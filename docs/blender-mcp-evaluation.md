# Blender MCP integration boundary

The supported automated route is the repository’s minimal `pnpm blender:live` bridge. This document records the adoption boundary; package/source pins and attribution live in `credits/`, while installation guidance lives in [MCP routes](../.agents/skills/blender-3d/references/mcp-routes.md). Individual research sessions and trial logs are ignored output.

## Supported bridge

The options were (a) adopt a pinned, reviewed third-party server, (b) build our own minimal bridge, or (c) a hybrid. We chose (b).

The deciding constraint is the token: no candidate authenticates its socket. The next is reproducibility. With `exec` as the main tool, a session is a pile of one-off snippets, not a scene `blender:run` can replay. The repository already has what a bridge needs: the headless runner flags, `avc_export`, the shot kit in `scripts/blender/`, the MCP bridge with path scoping, and the JSON contract. So the minimal bridge is small.

What we built (`scripts/blender-live.ts`, `scripts/workers/blender/avc_live*.py`):

- **Launch.** Blender runs in the background with `--factory-startup --disable-autoexec --offline-mode`. The server binds `127.0.0.1` on an OS-assigned port, exits after an idle timeout, and requires a 256-bit token. The token is passed by environment, kept in a mode-0600 session file under `.cache/blender-live/`, and compared in constant time.
- **No `exec`.** The tools are typed: `inspect`, `add`, `delete`, `material`, `set` (a strict property-path grammar over allowlisted datablocks that refuses file paths, drivers, expressions, scripts and private names), `run-kit` (only `scripts/blender/*.py`, with a JSON object as params), `still`, `strip`, `save`, `export`.
- **Contained outputs.** Callers pass names, never paths. Renders go to `out/<project|qa>/blender-live/<session>/`, saves to the project's `assets/blender/`. Node and Python each check containment.
- **No downloads.** No op fetches anything, and Online Access stays off. Third-party files arrive only through `pnpm assets:sync` or `asset:import`, with their licences recorded.
- **Replayable.** Every change is journaled. `export` writes a recipe JSON and the exact `pnpm blender:run --script scripts/workers/blender/avc_live_replay.py` command, which rebuilds the same scene through the same op code.
- **MCP.** One tool, `avc_blender_live`, scoped like every other tool.

The hybrid part is only advice. A user who wants the GUI, such as screenshots of the real UI, can install the Blender Lab server themselves, pinned to a tag. We never register it, and its work must still end as a script or recipe that `blender:run` can replay.


## Sources

- https://projects.blender.org/lab/blender_mcp, its API (`/api/v1/repos/lab/blender_mcp`, `/releases`, `/raw/...?ref=v1.0.3`) and `readme.md`
- https://www.blender.org/lab/mcp-server/ and https://www.blender.org/development/blender-lab-activity-report-q1-2026/ (403 to automated fetches; facts via search summaries only)
- https://www.blender.org/news/introducing-blender-lab/
- https://github.com/ahujasid/mcp-for-blender at `8f40787`; issues #201, #202, #203, #257, #306; PRs #205, #258, #395
- https://cveawg.mitre.org/api/cve/CVE-2026-10688, CVE-2026-10662, CVE-2026-10661, CVE-2026-66004 (CVE records)
- https://www.vulncheck.com/advisories/blendermcp-path-traversal-via-download-polyhaven-asset-api
- https://github.com/dcc-mcp/dcc-mcp-blender (README at `c445c47`)
- https://github.com/dhakalnirajan/blender-open-mcp at `30338db`
- https://github.com/gd3kr/BlenderGPT at `3fbc3bd`
- Secondary, used only to locate the claim: https://chatforest.com/reviews/blender-mcp-server/, https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026
