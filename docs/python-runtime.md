# Python alongside Node

Last updated: 2026-11-20

Node owns the public commands, validation, budgets, files and workflow state. Python is a private computation layer: TypeScript launches workers with literal argument arrays and validates their JSON responses. It is not a second application server.

The host runtime is **CPython 3.13.18**, pinned in `.python-version`; `pyproject.toml` accepts Python 3.12–3.13 so the `offset` group can retain Python 3.12.16: audio-offset-finder still requires NumPy 1.x. `pythonVersion(profile)` selects this exception; other host workers use the primary pin. All uv worker dependencies live in its dependency groups, including the former Earshot requirements. `uv.lock` records the complete resolved dependency graph. CPU PyTorch routing is explicit in `tool.uv.torch-backend`. The default `dev` group installs only Ruff, ty and pytest, without models or ML runtimes.

## Setup and checks

Install uv 0.13.9 or newer, then run from the repository root:

```bash
uv python install
uv sync --locked
uv run --locked python --version
pnpm python:check
pnpm python:audit
uv run --locked pnpm test:fast
```

`uv run` puts the pinned Python on PATH for Node tests that invoke `python3`. Normal production commands remain the existing `pnpm` aliases. No shell activation or global Python replacement is needed. CI installs uv and prepares this environment on both Node runtimes on Linux.

`uv lock --check --offline` checks manifest/lock agreement. Change dependency declarations in `pyproject.toml`, run `uv lock`, and review both files. Change `.python-version` deliberately when updating the Python patch. Do not use `uv sync --all-groups`: worker groups are mutually exclusive and `offset` requires the legacy interpreter. The profile checker passes the appropriate interpreter explicitly.

`pnpm python:check` is the required fast gate. It checks manifest/lock agreement, Ruff `ALL`, Ruff formatting, ty and strict pytest contracts. `pnpm check` includes it. Each subprocess has a bounded timeout; failures propagate through the normal one-line CLI JSON envelope, with diagnostics on stderr. Checks run without model downloads.

Ruff and ty cover owned Python sources throughout the repository. Vendored `.agents`/`vendor` code, immutable verification launchers, the historical rhythm test launchers and the separately pinned rhythm metadata helper retain their original bytes and runtime contracts. New code does not inherit an unrestricted lint baseline. Numerical classifier thresholds, existing positional scene/SDK interfaces and specific ordered native operations have documented, narrow style exceptions; correctness diagnostics remain enabled. Blender source targets Python 3.11 syntax because supported Blender 4.x embeds it; a syntax regression test protects that boundary.

The fast ty pass permits the explicitly declared optional package imports and native SDK names. It still checks our own control flow and types. Actual dependency compatibility is a separate check:

```bash
pnpm python:check --mode profiles                  # all compatible groups, isolated environments
pnpm python:check --mode profiles --profile stems # one group
pnpm python:check --mode native                   # installed Blender required; absence fails
pnpm python:check --mode models                   # public CPU model acceptance; permits downloads
```

Profile checks install the exact locked group, import its native extensions and check its worker against the installed packages. `cmake` and `yt-dlp` also execute their version commands. ASR is Apple Silicon only; an explicit unsupported profile fails, while a full run reports the platform skip. The fast environment never needs incomplete fabricated SDK stubs. Blender/Resolve API members themselves remain application-owned dynamic boundaries and require native execution.

The `portable-voice` profile locks the sherpa-onnx CPU runtime for Supertonic and Parakeet. Check its worker with `pnpm python:check --mode profiles --profile portable-voice`. Model preparation and offline take synthesis use the ordinary `voiceover:local` CLI.

Model acceptance exercises the owning public commands with generated temporary media: Silero on silence, a fresh Demucs split plus the reference adapter, and SHA-256-pinned BiRefNet ONNX. It checks bounded protocols, readable stems and alpha output; it makes no perceptual quality claim. It downloads public dependencies/weights, never calls paid generation, and does not accept gated model conditions. Pyannote weight inference still requires the owner's prepared access; MLX ASR inference, optional Blender extensions and live Resolve application acceptance remain separate opt-ins.

`pnpm python:audit` uses uv's locked audit across every dependency group, including groups mutually exclusive at installation, for Apple Silicon, Intel macOS, Linux x64 and Windows x64. Host groups use the primary pin; the offset audit uses an isolated copy of the unchanged manifest and lock with its legacy interpreter pin. Neither audit suppresses advisories. It requires network access and fails on advisory or adverse package status; there is no vulnerability ignore list. Dependency updates must pass the relevant profile and model/native checks. Torch 2.15.0, torchaudio 2.11.0 and torchcodec 0.17.0 (all from the PyTorch CPU index, so Linux x64 gets no CUDA build), Pillow 13.0.0 and pytest 9.2.0 are checked together in this migration. Both Demucs consumers use the shared `soundfile` worker: the newer torchaudio WAV writer otherwise requires an additional TorchCodec stack.

OpenCV 5 moved the HOG detector to contrib; the multicam profile uses `opencv-contrib-python-headless` to preserve person detection. Demucs 4.1.0 is selected except on Intel macOS, where its NumPy/PyTorch constraints require retaining 4.0.1. Earshot retains mpmath 1.3.0 because SymPy 1.14 requires `<1.4`; other declared packages use the latest compatible stable versions.

## Execution and placement

| Location | Responsibility | Runtime |
|---|---|---|
| `src/lib/python.ts` | Root/version selection, locked uv arguments, profile environments and dependency identity | Node |
| `scripts/workers/*.py` | Audio analysis, reference measurements, shots, speech, matte, tracking | Python pin through the TypeScript owner |
| `scripts/workers/blender/*.py` | Blender integration; inert catalogue, archive and plan helpers also work outside Blender | Blender for `bpy`; pinned host Python for inert helpers |
| `scripts/blender/` | Scene kit, recipes, materials and shot scripts | Blender's bundled Python |
| `workers/resolve_worker.py` | Optional Resolve SDK clone/import/readback bridge | Explicit SDK-compatible interpreter (`python` adapter option); existing system default remains |
| `src/lib/audio/rhythm-artifact-metadata.py` | Historical measured metadata mechanism | Its separately pinned Apple/Xcode runtime; not a general Python launcher |
| `tests/*.py` | Pure maths, protocol, archive and visualisation tests | Pinned dev environment / pytest |
| `examples/vork/` | Fixture/scene examples | Host `vork` group for tracking; Blender for `bpy` |

The [worker map](../scripts/workers/AGENTS.md) lists the owning TypeScript module and public command for each worker. Moving these files into a Python package would not improve their current subprocess contract; their placement and JSON protocols remain intact.

Every ordinary launch uses `uv run --project <absolute-repository-root> --locked --exact --no-default-groups --group <profile> --python <pin> python -I ...`. Standard-library helpers omit `--group`. The absolute project and explicit Python request also work when the caller's current directory belongs to another project. For `offset`, `<pin>` is 3.12.16. `-I` isolates Python imports from user site packages and `PYTHONPATH`.

Environments live in `.cache/python/<profile>`, separate from the default developer `.venv`. Different workers cannot remove each other's NumPy or PyTorch dependencies while synchronising. First use installs packages; `--locked` refuses manifest drift. `AGENTBROS_UV` selects a uv executable. Historical `*_UVX` test overrides remain accepted but must now name a **uv-compatible** executable/shim, because the arguments use `uv run`.

| Groups | Used for |
|---|---|
| `reference`, `reference-audio`, `transnet` | Scene boundaries, reference motion/audio, TransNetV2 |
| `audio-map`, `stems`, `offset`, `multicam` | Rhythm maps, Demucs, coarse offsets and refinement/detection |
| `asr`, `vad`, `diarize` | Parakeet (Apple Silicon only), Silero, pyannote |
| `sfx-index`, `clap`, `earshot` | SFX measurements, embeddings and explicitly prepared Earshot |
| `matte`, `vork`, `cmake`, `yt-dlp` | ONNX matte, tracking, whisper.cpp build tool and reference downloads |

Models retain their own hashes, download policy and caches. Earshot still installs only through explicit `media:prepare` and runs its prepared environment offline; its manifest includes the Python/project/lock identity. Prepared whisper.cpp engines using the former Python version need explicit preparation again. Both Demucs callers now use the existing `stems` dependency profile instead of retaining a second Python 3.11/PyTorch environment.

Dependency resolution on Python 3.13 does not establish perceptual quality or every GPU/SDK combination. Public CPU model checks and installed Blender acceptance are explicit modes; live Resolve and gated model access retain their existing opt-ins. Blender's bundled interpreter and application-specific SDK/historical evidence runtimes are deliberate exceptions to the host pin.

The group isolation and conflict declarations follow [uv's dependency-group settings](https://docs.astral.sh/uv/reference/settings/#conflicts); Python selection follows [uv's version-file rules](https://docs.astral.sh/uv/concepts/python-versions/).

## GitHub checks

`.github/workflows/ci.yml` runs the fast Python gate and complete lock audit on Linux for every PR, main push and merge group. Profile jobs run only when their worker/domain, the shared Python launcher, quality runner, CI configuration or dependency lock changes. The required `ci` aggregator includes both Python jobs, so their failures cannot be silently skipped. Cache entries contain uv downloads, not shared mutable virtual environments.

All GitHub jobs use Linux. Apple Silicon/MLX ASR and Swift type checks are local checks; there are no macOS jobs. `python-native.yml` runs weekly and on manual dispatch: exact Blender 4.5.14 with a checked archive SHA-256, plus public VAD, stems and matte model contracts. These jobs have read-only repository permissions and no provider credentials. Neither workflow promises GPU or proprietary SDK coverage.

On macOS, run `pnpm python:check --mode profiles --profile asr` and the existing Swift type checks locally:

```bash
for worker in scripts/workers/*.swift; do
  swiftc -typecheck "$worker"
done
for worker in scripts/workers/apple/*.swift; do
  if [ "$(basename "$worker")" != Support.swift ]; then
    swiftc -parse-as-library -typecheck scripts/workers/apple/Support.swift "$worker"
  fi
done
```

Prepared environments and source-addressed caches made before the dependency lock changes must be explicitly prepared again through their owning command. Historical evidence launchers and their recorded source hashes are not rewritten to imply new acceptance.
