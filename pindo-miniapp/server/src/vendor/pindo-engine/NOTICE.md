# Vendored code notice

The files in this directory are copied from **Pindo** (https://github.com/pindo-app/pindo,
`lib/engine` and `lib/types/bead.ts`), licensed under **GPL-3.0-only**. The full license text
is in `./LICENSE`.

This code runs **only** inside the server container. It is never bundled into, imported by,
or shipped with the WeChat Mini Program (`/miniprogram`). See `docs/adr/0001-engine-runs-server-side.md`
in the project agent workspace for the rationale and the distribution boundary.

## Files copied

| Vendored file | Upstream file | Modification |
| --- | --- | --- |
| `downscaler.ts` | `lib/engine/downscaler.ts` | Added GPL header comment. |
| `color-matcher.ts` | `lib/engine/color-matcher.ts` | Added header; import path `@/lib/types/bead` → `./types`. |
| `dithering.ts` | `lib/engine/dithering.ts` | Added GPL header comment. |
| `subject-crop.ts` | `lib/engine/subject-crop.ts` | Added header; `BackgroundMode` import moved from the browser-only `image-loader.ts` to `./types`. |
| `types.ts` | `lib/types/bead.ts` | Added header; added the `BackgroundMode` type. |
| `palette-limit.ts` | `lib/engine/palette-limit.ts` | Added header; import path `@/lib/types/bead` → `./types`; comments translated to Chinese. |
| `LICENSE` | `LICENSE` | Unmodified. |

Browser-dependent upstream modules (`image-loader.ts`, `pattern-recognition.ts`,
`png-exporter.ts`) are **not** vendored. Image decoding is replaced by `sharp`, server-side.
