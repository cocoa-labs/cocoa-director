# Development and verification

Use Node 24 and npm 11. Install with `npm ci`; retain the lockfile. Read `AGENTS.md` before editing. Generated media, credentials, build caches and personal configuration do not belong in Git.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
# The four commands above:
npm run check
```

Unit/integration tests use mock providers. Real FFmpeg integrity tests generate temporary synthetic clips and inspect output duration and A/V alignment. No paid provider tests run by default. The existing opt-in live contracts must remain opt-in and require separate informed authorization and budgeting.

For real transaction and upgrade coverage, start your own isolated Postgres 17 instance and export `TEST_DATABASE_URL` before `npm run check`. Tests create a random schema, load the prior-format fixture, apply migrations repeatedly, test concurrent requests/budgets/cancellation/ownership and remove their own schema. Never point tests at a production database. Without the variable, Postgres integration coverage is explicitly skipped.

The GitHub validation workflow provisions its own Postgres service. It uses no project secrets, audits dependencies, checks the application and exercises the browser demo.

## Browser tests

```sh
npx playwright install chromium
npm run test:e2e
```

The browser suite starts a loopback server on port 3100, uses mock providers and isolated local data, and covers playable downloads and core studio interactions. Its output goes to ignored `test-results` and `playwright-report` directories. Install browser system dependencies on Linux with `npx playwright install --with-deps chromium`.

Verify changed workflows at desktop and narrow widths, including keyboard focus, loading and error states. Keep tests focused on user-visible behavior and security boundaries. Do not weaken assertions simply to make the release pass.

## Updating media tooling

The pinned tool artifact is a GPL build without nonfree components. Review upstream provenance, checksum, license and required codecs before changing it. Run the real rendering tests and synthetic Sandbox verification after a change; local success alone does not establish cloud compatibility. Media tools and fonts keep their own licenses.

## Working on your fork

This upstream is an archived handoff. Create branches, enable your own issue tracker and CI, and establish your own maintenance policy in your fork. Provider pricing, SDK contracts and hosting behavior evolve; keep configuration and tests in step with your changes. The original creator does not review pull requests or operate other installations.
