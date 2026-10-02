# Explainer hardening

The explainer path previously selected sentences from the beginning of the supplied page and skipped the source-analysis and script-writing passes. An arXiv abstract URL could therefore produce narration about categories, submission dates, authors and download links. Source graphics also used bright document panels that broke continuity with the surrounding imagery.

## Changes

- Parse article bodies with inert HTML parsing and Mozilla Readability, excluding page chrome and paper front matter.
- Resolve arXiv abstract URLs to the full HTML paper, falling back to its PDF. Accept direct PDF URLs and publisher-declared PDF links through the existing guarded fetch.
- Report an inaccessible full paper instead of silently treating its landing page as the paper.
- Preserve later sections when compacting documents with more than 300 text blocks. Keep PDF line boundaries and page references.
- Analyze live explainer sources for substantive claims across the body, then write a connected explanation of the question, mechanism, evidence and supported limitations. Keep provider inputs and narration length bounded.
- Preserve exact supporting excerpts when linking claims, and carry their citations into the storyboard and visual plan. Keep existing editable explainer script formats and versioned approvals.
- Use the continuity palette for source cards and PDF surroundings. Measure headline and excerpt widths, label quantitative callouts, avoid duplicate source footers, use visible ellipses for shortened text, and keep verification hashes in the data rather than the rendered frame.
- Support explainer draft regeneration with new artifact versions. Existing saved sources require extraction retry or re-import to pick up the new source text.

Music-video planning, providers, prompts, timing and rendering files are unchanged. The music branch of the production endpoint retains its existing behavior.

## Verification — October 2, 2026

- Node 24: lint and TypeScript checks passed without warnings.
- Unit/integration suite: 322 passed; 15 database-dependent tests skipped without an isolated Postgres connection.
- Browser suite: all 5 workflows passed, including music autopilot, media versions, library/error handling, news/PDF export, and a complete explainer approval/render/export flow at desktop and narrow widths.
- Production Webpack build passed. The default Turbopack build was blocked by this execution environment's build-worker port restriction (`EPERM`); no application build configuration was changed to work around it.
- Runtime dependency audit: no reported vulnerabilities. Dependency versions are locked and the license inventory includes the added parser libraries.
- A read-only import of [Attention Is All You Need](https://arxiv.org/abs/1706.03762) resolved to its full HTML rendition and extracted approximately 30.6k characters. Mechanism, results and conclusion survived both extraction and fragment compaction.
- Evidence cards were rendered and inspected at 1280×720, 720×1280 and 1080×1080. Mock export exercised the real FFmpeg compositor.

Provider responses in automated drafting tests are mocked. No paid narration, image or video generation, live database migration, deployment or public release was performed by these checks.

## Narration timing recovery

Before speech is recorded, the approval screen labels its word-count timing as an estimate. Once narration is available, the screen uses the measured audio for that saved script. An overrun pauses the production and offers **Condense to duration**; an underfilled recording offers **Fit to duration**. The recovery writer uses the recorded voice pace and reserves room for scene transitions.

Refresh an already-paused production to reveal the recovery action; its sources do not need to be imported again. Review the revised script and storyboard before approving generation. Revised scripts receive new version IDs, so recordings from older versions cannot be reused accidentally. Music-video behavior is unchanged.

## URL draft evidence recovery

Live source analysis selects bounded passage IDs through a strict structured response. The server resolves those IDs to the original source and exact quotation, including its punctuation and evidence hash. It no longer depends on the model copying source UUIDs and quotations perfectly. Later document sections remain represented, and invented passage IDs are rejected.

Source-analysis failures report whether the source is empty, lacks supported claims, or needs another analysis attempt. A deliberate retry gets a new request key only when analysis failed before any production was created; ambiguous errors retain duplicate protection. Logs contain counts and error types without article bodies or provider credentials. Provider guards remain authoritative even when the SDK wraps their errors.

Regression coverage exercises URL extraction, the real OpenAI SDK and structured format, HTTP draft creation, citations, invalid evidence, spending guards and idempotent retries with substituted network responses. The browser regression covers failure-to-retry recovery with saved sources. These tests do not establish a live provider result.

## Editorial pacing and recovery allowances

New editorial scripts use a conservative 120-word-per-minute estimate and include scene-transition capacity in their word limits. Recorded narration remains authoritative. Fitting shows its own progress state and keeps version-specific approvals; it does not start a new production. Fit requests carry an idempotency key and charge the existing production allowance.

Storyboard approval reserves the remaining work on top of earlier submitted calls. Recovery reserves provider headroom and the final render, keeps completed assets, and still enforces daily spending caps. The displayed maximum now comes from the reservation ledger. Submitted-call reservations can exceed the currently recorded charges; the UI exposes the remaining allowance instead of implying that every unbilled cent is free to spend.

A failed visual remains recoverable while visual QA has not started. Approved productions show their downstream blocker, with a recovery action in the main review panel, rather than asking for their script to be approved again.

Regression coverage includes the 117-word initial narration estimate, completed timing recovery, the exhausted 200-cent allowance with 195 cents already committed, a blocked top-up at the daily cap, recovery through the render allowance, and browser checks for fitting and pending-QA recovery. Paid provider output is not established by these mocked tests. Music-video behavior is unchanged.

## Recorded narration fit

Measured editorial audio can now use a pitch-preserving pace adjustment between 0.92× and 1.08× to reach the nearest valid speech window. The planner, saved schema, renderer, and delivery checks share these bounds. Coverage and 1.5-second transition limits remain enforced, and larger mismatches still require a source-grounded script revision. Integer scene durations are allocated cumulatively to avoid rounding failures at the coverage boundaries.

For previously paused productions, Fit recording retains the script version, citations, and recorded assets instead of issuing another writer or voice request. Reapproving the same storyboard reuses its existing generation allowance. New versions, increased estimates, and provider attempts still go through the spending guards. Regression coverage includes the observed 47,917 ms and 57,856 ms recordings, both pacing boundaries, unchanged stored media, and recovery near the daily cap. Music-video orchestration is unchanged.

## Draft image recovery

Recovery recognizes failed images as well as failed video clips. It rejects stale or successful selections before changing the allowance or workflow state, retains approved artifacts and measured narration, and resumes the existing waiting workflow when available. Image retries receive distinct attempt keys while completed images remain untouched.

The HTTP regression uses a production with three completed images and one budget-blocked image. It verifies resumption within the saved allowance, request replay, unchanged approvals and assets, restoration of valid narration progress, and rejection at the daily cap. A provider-boundary test exercises a failed image retry followed by a successful retry. These checks use synthetic stored data and mocked provider/workflow dispatch.
