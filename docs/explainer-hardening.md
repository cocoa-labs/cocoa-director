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
