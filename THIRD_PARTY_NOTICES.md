# Third-party notices

The MIT license applies to original Cocoa Director source, not to independently licensed dependencies. `package-lock.json` records exact npm versions. Installed package license files remain authoritative. `docs/dependency-licenses.json` is the release inventory; retain upstream copyright/license notices when redistributing dependency code.

| Component | License / notice |
| --- | --- |
| Next.js, React, TypeScript, OpenAI SDK, fal client, ElevenLabs SDK, pg, Undici, Zod | MIT; see each installed package |
| Vercel Workflow, Vercel Sandbox, PDF.js, Sharp | Apache-2.0; see each installed package and any NOTICE files |
| Sharp's platform-specific libvips libraries | LGPL-3.0-or-later and bundled-library notices; installed separately by npm, not relicensed under MIT |
| Lightning CSS and axe-core | MPL-2.0; preserve the upstream file licenses and applicable source availability when redistributing |
| `@vercel/cli-auth` | npm metadata omits the license; the declared [Vercel source repository](https://github.com/vercel/vercel/blob/main/LICENSE) supplies Apache-2.0 |
| xz-decompress and tar-stream | MIT; portable extraction of the verified FFmpeg archive in Vercel Functions |
| Mozilla Readability | Apache-2.0; article-body extraction, see `@mozilla/readability` license and notices |
| LinkeDOM | ISC; inert HTML parsing, see the installed `linkedom` license |
| FFmpeg command-line tools | GPL or LGPL according to the build; independent upstream executable, not relicensed under MIT |
| Liberation fonts included by PDF.js | GPL-2.0 with the upstream font embedding exception; [complete notice](docs/licenses/LIBERATION.txt) |
| Foxit standard fonts included by PDF.js | Upstream permission and copyright notice; [complete notice](docs/licenses/FOXIT.txt) |

Cocoa Director invokes FFmpeg as a separate command-line process. The automated Linux installation uses a checksum-pinned **GPL** build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), without `--enable-nonfree`, as recorded in the media-tools module. The repository and GitHub release do not contain FFmpeg executables. Users install/download the tools directly. Keep applicable binary/source notices and obligations when redistributing a deployment or image containing them. [FFmpeg license information](https://ffmpeg.org/legal.html).

Editorial rendering uses the unmodified Liberation font files shipped by PDF.js, and can outline glyphs for reliable rendering. The font embedding exception is included above; it does not relicense the fonts themselves. PDF.js's standard-font notices are retained in deployed file tracing.

The unused Remotion experiment is excluded from this release; no Remotion license is granted or required by the shipped dependency graph.

The showcase is AI-generated media created with Cocoa Director; it is not a benchmark guarantee or a representation of mock output. External AI services and their outputs remain subject to the relevant provider terms. Cocoa Director does not grant rights to users' input material or provider trademarks.
