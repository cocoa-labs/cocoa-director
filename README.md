# Cocoa Director

**Turn a creative brief into a music video.** Plan the treatment, compose the soundtrack, direct the shots, and assemble the final film in one studio. Or build a source-backed editorial video, work on an image, explore music, and collect the results in your library.

[![Cocoa Director](public/cocoa-preview.png)](https://github.com/cocoa-labs/cocoa-director/releases/tag/v0.1.0)

[Watch “Let It Fly,” made with Cocoa Director](https://github.com/cocoa-labs/cocoa-director/releases/download/v0.1.0/let-it-fly.mp4) · [Release and verification](https://github.com/cocoa-labs/cocoa-director/releases/tag/v0.1.0) · [Live setup](docs/setup.md) · [Architecture](docs/architecture.md)

> **An archived, unsupported release.** This is a complete source handoff for you to fork and make your own. There is no hosted service, support inbox, promised maintenance, or future update schedule. Your installation uses your accounts, keys, infrastructure, and budget. The original creator's studio and data are not included.

## Try it without API keys

You need **Node 24**, npm 11, and **FFmpeg with ffprobe**. On macOS, install FFmpeg with `brew install ffmpeg-full`. On Linux x64, `npm run media:setup` installs the verified tool build after npm dependencies are installed. [Other installation details](docs/setup.md#media-tools).

```sh
git clone https://github.com/cocoa-labs/cocoa-director.git
cd cocoa-director
npm ci
npm run setup -- --mode=demo
npm run doctor
npm run dev
```

Open **http://127.0.0.1:3000**. No sign-in, database, cloud account, or provider key is needed for the local demo. On Linux x64 without FFmpeg, run `npm run media:setup` before `doctor`.

Try: “A paper lantern leaves a quiet workshop and drifts into a city waking before sunrise. Warm cinematic light, hopeful electronic soul, a feeling of letting something go so it can become something new.”

Demo mode runs the studio with deterministic planning, synthetic images, a generated test track, and moving test-pattern footage. Playback and downloads work. It does **not** generate AI artwork or speech; costs are simulated. Projects are stored in memory and reset when the server restarts. Keep downloaded files you want to retain.

## What you can do

- **Music videos:** a brief, treatment, soundtrack, visual anchors, shot direction, beat timing, and final MP4. Review stages or use autopilot.
- **Editorial productions:** supply notes, links, or PDFs; review scripts and storyboards; render graphics, narration, captions, and citation manifests.
- **Media Lab:** generate and revise images, music, and short videos independently. Keep versions and restore earlier results.
- **Library:** upload, import, organize, reuse, and export assets across projects.
- **Creative control:** regenerate a shot, revise direction, cancel a run, or recover a failed production while retaining completed work.

Creative output in live mode depends on your providers' model access, policies, quotas, and service availability. Demo results do not predict live quality. Provider access can change after this archived release.

## Run your own live studio

[Follow the live setup guide](docs/setup.md#live-installation). The documented cloud path uses **Vercel, Postgres, public and private Vercel Blob stores, Workflow, and Sandbox**. Generation uses your **OpenAI, fal, and ElevenLabs** accounts.

Start a separate checkout or preserve your demo configuration before switching modes:

```sh
npm run setup -- --mode=live
# Fill in your own keys and service configuration in .env.
npm run db:migrate
npm run doctor
```

Setup never overwrites existing environment files. It generates local authentication secrets for a new live configuration and leaves paid calls paused. Enable `PROVIDER_CALLS_ENABLED=true` only after reviewing your settings and budget. Do not use local development without durable storage as a production server.

The default global and personal daily limits are **$50**. Owner accounts have no automatic spending exemption. Reservations include pending attempts and retries; provider invoices are authoritative, and platform/storage charges have separate billing. Set limits in your provider and hosting dashboards too. Never put credentials in `NEXT_PUBLIC_*` variables.

## Give it to your coding agent

Yes—give your agent this repository URL and the following prompt. The repository includes a practical [AGENTS.md](AGENTS.md), with architecture, commands, constraints, and validation instructions. You can also follow every step yourself.

> Clone this repository into a new directory and read README.md and AGENTS.md. Set up the local no-cost demo using Node 24. Preserve any existing environment files. Run setup, doctor, and the applicable validation checks, then open the studio. Do not enable paid providers, read credentials from unrelated projects, deploy, or change cloud resources unless I explicitly request that work. Explain any missing tools or accounts. If I later request live mode, walk me through supplying my own keys and choosing my budget.

## Validate and extend

```sh
npm run check       # lint, types, unit/integration tests, production build
npm run test:e2e    # browser workflows; see docs/development.md
```

[Release verification](docs/release-verification.md) · [Development and tests](docs/development.md) · [Configuration and troubleshooting](docs/setup.md) · [API and data model](docs/architecture.md) · [Security and maintenance](SECURITY.md)

Fork this repository to make changes. The archived upstream does not accept issues or pull requests. Maintain your own fork, upgrade dependencies, and revalidate providers before using it for production work.

## License

Cocoa Director's original source is [MIT licensed](LICENSE). Dependencies, media tooling, and fonts retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). Provider accounts and generated media are subject to the terms of those services. The repository includes no private user projects or API keys.
