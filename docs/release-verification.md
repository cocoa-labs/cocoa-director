# v0.1.0 verification record

Verified on October 2, 2026 (UTC). This is a one-time source release, not a promise of continuing compatibility.

## Local and automated checks

- Clean source checkout with no personal environment files: locked installation, lint, TypeScript, unit/integration tests and production build.
- 318 unit/integration tests pass, including real Postgres 17 transactions, additive schema upgrade fixtures, idempotency, concurrent reservations, ownership, cancellation, upload validation, archive extraction and SSRF regressions.
- Four browser scenarios cover music creation/playback/download and reload recovery; standalone image/video/music generation, versions and restore; narrow layout/keyboard navigation/library upload/curation and rejected private-network imports; and editorial text/PDF sources, versioned approvals, real FFmpeg export, captions and citations.
- New live-mode configuration tests fail closed for missing provider keys, authentication, database, storage or budget settings. The local demo media test forbids network fetches.
- Dependency audit: zero reported vulnerabilities. The license inventory has no unidentified license entries. Full public Git history is scanned for secrets before publication.
- The [Validate workflow](https://github.com/cocoa-labs/cocoa-director/actions/workflows/validate.yml) repeats installation, Postgres tests, build, audit and browser checks in an isolated Linux runner. The release is published only after the release commit passes.

## Isolated cloud checks

A separate test project, restricted test database and test Blob stores were used. The checks verified authenticated project/source persistence, unauthenticated API rejection, a 6,302,635-byte multipart public upload, private PDF processing and authenticated download, rejection of unsigned callbacks, and harmless replay of signed callbacks.

Vercel Functions produced an actual two-second H.264/AAC synthetic clip using the checksum-pinned FFmpeg build. A separate Node 24 Sandbox produced and downloaded a three-second H.264/AAC clip with the same tools. The Sandbox was stopped after each attempt. The cloud checks caught and corrected missing archive utilities in the hosting images.

## Scope and limitations

No new paid AI generation was performed for this release. The attached two-minute “Let It Fly” film is an existing live output, not a mock result or a fresh provider-contract test. Operators must verify their own account/model access, pricing and service limits before authorizing live calls.

Cloud verification covered storage callbacks, source processing and synthetic rendering. A new complete paid production, every live model combination, production promotion, Windows, and long-term hosted load/recovery were not tested in this release pass. Existing local security and recovery regressions are included in the suite.

The $5 infrastructure verification ceiling includes retries. Cost allowances were reserved before testing; final provider invoices were not available during the release pass. No operator credentials, test deployment URLs, private data, databases, generated test projects or previous private Git history are included in this repository.

The archived repository supplies no hosted service or ongoing maintenance. Fork operators own their dependencies, credentials, deployments, media rights and bills.
