# Setup and operation

## Local demo

Use Node 24 and npm 11. `npm ci` installs the locked dependencies. `npm run setup -- --mode=demo` creates `.env` only when no environment file already exists. `npm run doctor` checks configuration without making paid calls or altering the database. `npm run dev` listens on loopback at http://127.0.0.1:3000.

Demo mode is `PROVIDER_MODE=mock`. Leave `PROVIDER_CALLS_ENABLED` empty to permit mock operations. Setting it to `false` pauses them too. The studio labels synthetic media and simulated costs. Editorial narration is silent with simulated word timings, not speech synthesis. Local project metadata is held in memory. Restarting the server clears it; generated files in `public/dev-blob` and `.cocoa-private` are ignored by Git but remain on disk until removed or cleaned up.

Use the demo locally. If exposing any installation to others, configure access control, persistent storage, and resource limits; synthetic rendering still consumes CPU and disk. Do not expose a development server to the internet.

## Media tools

The application invokes FFmpeg and ffprobe as separate executables. It requires H.264 (`libx264`), AAC, MP3 (`libmp3lame`), PNG, libass captions (the `ass` filter), and the standard audio/video filters. Both tools should come from the same installation.

- **macOS:** `brew install ffmpeg-full`; then run `npm run doctor`. A system upgrade may change render behavior, so re-run the tests afterward.
- **Linux x64:** `npm run media:setup` downloads a fixed GPL FFmpeg build, checks its SHA-256, and rejects `--enable-nonfree`. The cache is under the OS temporary directory. Re-run setup if temporary files are cleared.
- **Other Linux architectures:** install a system FFmpeg/ffprobe pair from your distribution, then run doctor. Those architectures are not part of the release verification matrix.
- **Custom paths:** set absolute `FFMPEG_PATH` and `FFPROBE_PATH` values. No shell expression or command-line arguments belong in these variables.

Discovery checks explicit paths, `.cocoa-tools/bin`, the pinned temporary cache, Homebrew ffmpeg-full on macOS, then `PATH`. Vercel Functions download and cache the pinned Linux tools on their first media operation to avoid oversized function bundles. Sandbox downloads the same verified build in its isolated VM. The first render therefore needs outbound access to GitHub releases and takes longer. A checksum mismatch fails closed.

The pinned build and hash are recorded in `src/lib/server/media-tools.ts`. Upstream binary retention is finite. If the artifact disappears, install your own supported tools locally or update the pin and hash in your fork, review its licensing, and rerun render tests. Never replace the checksum with an unchecked floating download. No FFmpeg executable is distributed in this repository.

## Live installation

Use your own accounts and a separate environment from the demo. Setup refuses to overwrite `.env*`; when switching, back up or edit your existing configuration yourself. The `.env.live.example` template lists supported settings. Node, CLI tools, and Next.js load `.env*` with Next.js precedence; exported environment variables win.

1. Run `npm run setup -- --mode=live` in a checkout without existing environment files. It creates `.env` with fresh `AUTH_SECRET`, `ADMIN_INVITE_CODES`, and `CRON_SECRET`. Read the owner access code from your local file; setup never prints it.
2. Supply `OPENAI_API_KEY`, `FAL_KEY`, and `ELEVENLABS_API_KEY`. Confirm your accounts can access the configured model IDs. Optional model overrides are listed in the template; this release keeps its existing creative defaults.
3. Create a Postgres database and restricted application role. Set `DATABASE_URL`, then explicitly run `npm run db:migrate`. This applies additive, repeatable schema changes. Back up existing databases before upgrading your own fork. Readiness never initializes the schema.
4. Create **two separate Vercel Blob stores**. Set `BLOB_READ_WRITE_TOKEN` for public generated assets and `PRIVATE_BLOB_READ_WRITE_TOKEN` for authenticated source PDFs. Public output URLs are shareable with anyone who has them; private source downloads check project ownership. Do not upload confidential material as public library media.
5. Keep `REQUIRE_AUTH=true`. The owner code is configured through `ADMIN_INVITE_CODES`; optional comma-separated `INVITE_CODES` create separate user identities. There is no access-request service or contact with the original creator. Changing a code changes its derived user identity; retain codes needed to access existing projects and rotate `AUTH_SECRET` to invalidate sessions.
6. Choose daily limits. Defaults are `DAILY_BUDGET_CAP_USD_GLOBAL=50` and `DAILY_BUDGET_CAP_USD_PER_USER=50`. Explicit personal exemptions are possible through `SPEND_CAP_EXEMPT_EMAILS` or `SPEND_CAP_EXEMPT_USER_IDS`; global caps always apply. Leave exemptions empty for the default behavior.
7. Set `PROVIDER_CALLS_ENABLED=true` only when ready to authorize charges. Run `npm run doctor`, then deploy or start your studio. Disable it to pause new provider submissions; already submitted provider work may still finish and bill.

All live installations need durable Postgres and public asset storage for reliable workflows. External video providers cannot fetch images from your machine's `localhost` URLs. A local live development server may use your own cloud database and Blob stores; localhost-only storage is for the demo.

### Vercel deployment

Create your own Vercel project from your fork. Choose the **Next.js framework preset** and Node 24, install with `npm ci`, and build with `npm run build`. Do not connect your fork to somebody else's existing project. Supply live variables separately for Preview and Production, including independent databases and Blob stores. Run migration against each intended database explicitly before use.

The Workflow SDK integrates through the Next.js configuration. Rendering runs in Sandbox with runtime `node24`; its setup installs the signed distribution `xz` package using `dnf` before unpacking the pinned FFmpeg archive. Vercel Functions use a bounded JavaScript archive reader. Deployed Sandbox authentication uses Vercel OIDC. Optional local Sandbox access requires all of `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. These are server secrets, not browser settings. Confirm current hosting/Workflow/Sandbox limits and billing in your own account.

Direct large uploads use Blob's browser upload protocol. `/api/projects/:id/library/upload` and `/api/projects/:id/sources/upload` issue authenticated, scoped tokens. `/api/uploads/library/completed` and `/api/uploads/sources/completed` receive SDK-signature-verified callbacks. If Deployment Protection blocks callbacks, configure the supported callback access for your test deployment; do not remove signature or ownership checks. Test both stores before relying on large uploads.

`/api/system/readiness` is read-only and returns sanitized configuration/schema status. Inspect it after deployment. `/api/maintenance/cleanup` is the configured daily maintenance cron and requires `CRON_SECRET`. Keep a separate database backup policy; cleanup is not a backup.

### Costs, cancellation, and recovery

Costs shown by the studio are estimates based on configured prices. The app reserves pending work and retries before submission and retains uncertain charges. Budgets use UTC daily boundaries; pending reservations carry across midnight. Model prices and platform charges can change. Review provider dashboards and set their spending limits independently.

Reusing an idempotency key with the same input returns the original resource; changing its input returns `409`. After an ambiguous network error, refresh before starting another generation. Cancel stops subsequent submissions and prevents late results from reviving the job, but cannot refund work already submitted externally.

Recovery and regeneration retain completed assets and create new versions. Inspect failed steps, current approvals, and remaining budget before retrying. Restoring a version does not erase its sibling outputs. Editorial approvals apply to a specific script/storyboard version and must be renewed after edits.

### Common problems

| Symptom | Action |
| --- | --- |
| Provider calls paused | Inspect `PROVIDER_CALLS_ENABLED`; live mode needs explicit `true`. |
| Budget reached | Review estimates, retained reservations and provider billing; adjust your own cap deliberately. |
| Login unavailable | Configure `AUTH_SECRET` and `ADMIN_INVITE_CODES`; use your installation's code. |
| Missing schema / database unavailable | Check your database URL, role/network access, then explicitly migrate. Diagnostics do not expose connection strings. |
| Video references fail | Use publicly accessible URLs from your own public Blob store. |
| Upload remains processing | Check the completion callback and source-processing state; use Retry on the source after fixing configuration. |
| Media tools missing | Install FFmpeg and ffprobe or run the Linux setup command; check executable paths and doctor. |
| Script no longer approved | Review and approve the current script and storyboard versions. |
| Demo media unavailable after switching to live | Demo assets are synthetic mode-specific fixtures; export them before switching or start a new live project. |

This is an archived source release. Provider availability, upgrades, operation, security updates, and troubleshooting belong to each fork's operator.
