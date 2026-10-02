# Cocoa Director agent guide

## Purpose and operating boundaries

This is an archived MIT source release for independent forks. Help the current operator run and modify their own copy. There is no connection to the original creator's accounts and no support service.

Read README.md, docs/setup.md, and docs/architecture.md. Default to the local mock demo. Do not obtain credentials from other projects, enable paid providers, send notifications, deploy, publish, or mutate cloud resources unless the current user has authorized that work. Existing explicit authorization still applies; do not ask repeatedly.

Never print secrets or put them in prompts, committed files, NEXT_PUBLIC variables, screenshots, logs or test fixtures. Use the operator's chosen services. Do not disable authentication or spending controls to work around a failed live run.

## First run

1. Check Node 24, npm 11 and system FFmpeg/ffprobe.
2. `npm ci`.
3. `npm run setup -- --mode=demo`. Existing `.env*` files must remain intact.
4. `npm run doctor -- --json`. Read-only; no paid API calls or migrations.
5. `npm run dev`, then open http://127.0.0.1:3000.

For explicitly requested live operation, use the live template and the operator's keys, persistent Postgres, separate Blob stores, access code and budget. Run `npm run db:migrate` only against the database the operator selected. Explain that provider enablement is deliberately explicit. Demo project metadata does not survive a server restart.

## Implementation map

- UI: src/components and src/app. Keep expensive work and secrets on the server.
- Contracts: src/lib/schemas.ts. Preserve saved project shapes and version identity.
- Services: src/lib/server. Reuse actionRequest, budget reservations, ownership, upload authorizations, guarded fetches and storage-path containment.
- Providers: src/providers. New endpoints need pricing/reservation and provider contract tests.
- Durable orchestration: src/workflow. Cancellation is terminal; late provider results must not revive cancelled work.
- Rendering: FFmpeg with SVG/Sharp graphics. src/lib/server/media-tools.ts centralizes executable discovery and verified Linux downloads. Never introduce unchecked downloads or a nonfree binary build.

Request idempotency is scoped to user and action. Same key/input replays the original result; changed input returns 409. Keep external calls outside database claim transactions. Reserve retries before submission. Completed artifacts survive retries, restoration and recovery. Editorial approvals are version-specific.

## Validation and completion

Run `npm run check` after meaningful changes. Use TEST_DATABASE_URL only for isolated Postgres integration data. Run `npm run test:e2e` for workflow/UI changes after installing Playwright Chromium. Tests may use synthetic FFmpeg media but must not silently enable live providers.

Describe what changed, how it was tested, and any unverified environments. A clean mock test does not establish a live provider contract. No paid check is implied by installing this repository. Keep generated assets, environment files, caches and private operational notes out of commits.

For cloud changes, follow docs/setup.md and verify an isolated preview. Production promotion requires the operator's authorization. Read relevant installed Next.js documentation before framework changes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
