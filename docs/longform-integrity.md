# Chapter render integrity

Chapter media discovery follows actual media keys such as `imageUrl`, `videoUrl`, `source` and reference URL arrays. Filenames mentioned in editorial text (`package.json`, `lesson.mp4`) are not assets. Nested template/left-panel media still belongs to the chapter's checksum dependencies. Inline caption IDs are not files; caption text, source timing, trims and playback rates remain part of the complete timeline fingerprint.

`projectChapterPlan(projectId, manifest, {rootDir, codeDir})` uses `rootDir` for project/public/output data. Explicit `codeDir` selects renderer source; otherwise a source-bearing rootDir selects its own checkout, while a data-only fixture root uses the current checkout. Source identity hashes the configured `src` tree, package manifest, lock and Remotion config. Changes invalidate cached chapters even when the project timeline is unchanged.

`remotionChapterBackend(rootDir, {codeDir})` uses that source checkout for the Remotion entrypoint and working directory, and explicitly points `--public-dir` at project data. Args are passed as an array. Child output stays captured and becomes stderr progress, so the outer CLI retains a single JSON envelope.

Cached paths must be the exact `{chapterId}-{fingerprint}.mp4` under `out/{project}/chapters/{format}`. Unrelated paths are ignored before hashing; symlinks are refused. Actual publication and generic reuse paths are confined to their cache directory. Reuse still requires matching dependency fingerprint and output checksum; it does not mean QA or publication approval.

```bash
pnpm exec tsx --test tests/longform.test.ts
RUN_LONGFORM_RENDER_TESTS=1 pnpm exec tsx --test tests/longform-browser.test.ts
```

The browser fixture uses the real production Root, native Remotion renderer and local encoder. It renders a one-second chapter after trim/rate2, verifies source/output and word timestamps, probes encoded video, measures caption absence/presence at actual seeked frames and then reuses its verified cache. Font substitution is explicitly smoke-only. No provider calls or spending.
