# Cocoa Director v0.1.0

A one-time MIT-licensed source release from keef75, published through Cocoa Labs. Fork it, bring your own provider accounts, and make it yours.

Cocoa Director brings music-video direction, source-backed editorial production, standalone image/video/music creation, versioned media and an asset library into one studio. The included no-cost demo uses synthetic media with working playback and downloads. Live generation remains paused until an operator configures their own access code, keys, database, storage and budget.

Start with Node 24, npm 11 and FFmpeg/ffprobe, then run:

```sh
npm ci
npm run setup -- --mode=demo
npm run doctor
npm run dev
```

See the README, setup guide and AGENTS.md for human and coding-agent workflows. The release removes the private beta/support processes and the unused Remotion experiment. Rendering uses FFmpeg; third-party licenses remain applicable.

“Let It Fly” is the existing two-minute showcase export. Its release copy retains the original audio and video streams and contains only public release metadata. SHA256SUMS verifies the attached file.

[Verification and limitations](release-verification.md) document the tests and the deliberately untested live-provider combinations.

This upstream is archived after publication. There is no hosted service, support inbox, promised fix schedule or ongoing maintenance. Fork owners manage their own dependencies and deployments.
