import { describe, expect, it } from "vitest";

import {
  AgentActionProposal,
  ArtifactVersion,
  CreativeStyleContract,
  CreativeBrief,
  EditDirective,
  MediaAsset,
  MediaGeneration,
  MediaGenerationCreateRequest,
  MediaGenerationInjectRequest,
  MediaSession,
  MediaSessionCreateRequest,
  MediaSessionGenerationRequest,
  MediaSessionAgentMessageRequest,
  MediaSessionMessage,
  MediaSessionVersion,
  LibraryAsset,
  LibraryAssetCreateRequest,
  LibraryCollection,
  LibraryUrlImportRequest,
  Project,
  RenderAgentMessageRequest,
  RenderAgentProposal,
  MusicPlan,
  PromptTrace,
  RegenerateRequest,
  ShotRegenerateRequest,
  VideoCreateRequest,
  VisualSignature,
} from "@/lib/schemas";

describe("schemas", () => {
  it("defaults to vertical 9:16 and validates launch duration", () => {
    const request = VideoCreateRequest.parse({
      prompt: "A crystalline city wakes up inside a neon storm.",
    });

    expect(request.aspectRatio).toBe("9:16");
    expect(request.durationSeconds).toBe(75);
    expect(request.visualMode).toBe("conceptual");
  });

  it("round trips core phase artifacts", () => {
    const visualSignature = VisualSignature.parse({
      id: "surreal_domestic",
      paletteFamily: "porcelain white, soap blue, butter yellow, tomato red, and chrome",
      palette: ["porcelain white", "soap blue", "butter yellow"],
      medium: "surreal practical-object cinema",
      worldGrammar: "kitchens, sinks, steam, bubbles, glassware, and impossible household scale shifts",
      recurringMotifs: ["soap bubbles", "spinning plates", "rinsing water"],
      texture: "wet ceramic, suds, soft steam, and polished metal",
      cameraLanguage: ["macro push-in", "overhead choreography", "waterline glide"],
      avoidMotifs: ["teal cyberpunk skyline"],
    });
    const brief = CreativeBrief.parse({
      videoId: "00000000-0000-4000-8000-000000000000",
      durationSeconds: 75,
      aspectRatio: "9:16",
      visualMode: "conceptual",
      storySpine: "A lead figure crosses a city and transforms the skyline into signal and light.",
      visualWorld: "Neon rain, cyan practical lights, hard silhouettes, and graphite concrete.",
      visualSignature,
      subject: { type: "character", description: "A courier with a clean silhouette" },
      energyArc: ["build", "calm", "peak"],
      mood: "urgent",
      genre: "electronic",
    });
    const plan = MusicPlan.parse({
      videoId: brief.videoId,
      vocal: true,
      voiceFamily: "female",
      language: "en",
      bpm: 132,
      key: "A minor",
      sections: [
        { id: "intro", durationSeconds: 10, energy: 0.2, instrumentation: "pulse", lyrics: "wake up" },
        { id: "verse", durationSeconds: 20, energy: 0.5, instrumentation: "drums", lyrics: "move through" },
        { id: "chorus", durationSeconds: 45, energy: 0.9, instrumentation: "hook", lyrics: "turn the lights up" },
      ],
    });

    expect(plan.sections).toHaveLength(3);
    expect(plan.voiceFamily).toBe("female");
    expect(brief.subject.type).toBe("character");
    expect(brief.visualSignature?.recurringMotifs).toContain("soap bubbles");
  });

  it("allows visual signatures without a fixed motif layer", () => {
    const visualSignature = VisualSignature.parse({
      id: "live_band_performance",
      paletteFamily: "stage tungsten, road-case black, denim blue, and warm white",
      palette: ["stage tungsten", "road-case black", "denim blue"],
      medium: "grounded live-band music-video cinema",
      worldGrammar: "rehearsal rooms, small stages, amplifier walls, drum risers, and raw studio floors",
      texture: "amp cloth, stage wood, cymbal shimmer, denim, and haze",
      cameraLanguage: ["low guitar tracking", "drum-riser push", "handheld stage orbit"],
    });

    expect(visualSignature.recurringMotifs).toEqual([]);
  });

  it("validates creative style contracts and prompt traces", () => {
    const contract = CreativeStyleContract.parse({
      source: "deterministic",
      confidence: 0.82,
      musicIntent: {
        primaryGenre: "guitar-driven rock and roll",
        secondaryGenres: [],
        requestedInstruments: ["electric guitar", "live drums", "bass guitar"],
        vocalMode: "instrumental",
        lyricsPolicy: "instrumental only",
        tempoFeel: "driving live-band pulse",
        positiveStyle: ["electric guitars", "live drums", "bass guitar"],
      },
      visualIntent: {
        primaryStyle: "cyberpunk noir city cinema",
        secondaryStyles: [],
        setting: "future city streets",
        palette: ["electric cyan", "rain black", "warning red"],
        materials: ["wet concrete", "glass", "steel"],
        camera: ["low wet-street dolly", "hard backlight reveal", "noir silhouette track"],
        positiveVocabulary: ["guitar performance detail", "wet pavement reflections"],
      },
      userMotifs: [],
      routing: { musicProfile: "rock", visualLane: "cyberpunk_noir" },
      conflicts: ["Music and visual worlds are intentionally separated."],
    });
    const trace = PromptTrace.parse({
      styleContract: contract,
      promptSummaries: { treatment: "rock/cyberpunk split" },
      selectedReferences: [{ shotIndex: 0, roles: ["style"], urlCount: 1 }],
      anchorAudits: [{
        role: "style",
        status: "aligned",
        dominantObjects: ["guitar"],
        styleAlignment: 0.9,
        reuseEligible: true,
        notes: [],
        source: "vision",
      }],
    });

    expect(contract.userMotifs).toEqual([]);
    expect(trace.anchorAudits[0].reuseEligible).toBe(true);
  });

  it("validates persisted media-session agent messages and proposals", () => {
    const proposal = AgentActionProposal.parse({
      actionType: "media_generation",
      title: "Stage guitar wall image",
      rationale: "Creates a versioned session asset without touching the director pipeline.",
      costRisk: "Runs one image generation only after confirmation.",
      kind: "image",
      provider: "openai",
      prompt: "A wall of guitar amps under white stage light.",
      controls: { model: "gpt-image-2", quality: "high" },
      inputAssetIds: ["00000000-0000-4000-8000-000000000030"],
      label: "Guitar amp wall",
    });
    const message = MediaSessionMessage.parse({
      id: "00000000-0000-4000-8000-000000000031",
      sessionId: "00000000-0000-4000-8000-000000000032",
      role: "agent",
      content: "I staged this for confirmation.",
      proposal,
      createdAt: "2026-05-05T00:00:00.000Z",
    });
    const request = MediaSessionAgentMessageRequest.parse({
      message: "Make a version with guitar amps.",
    });

    expect(message.proposal?.actionType).toBe("media_generation");
    expect(message.proposal?.inputAssetIds).toHaveLength(1);
    expect(request.mode).toBe("compose");
  });

  it("validates editor directives and artifact versions", () => {
    const directive = EditDirective.parse({
      id: "00000000-0000-4000-8000-000000000001",
      scope: "shots",
      phase: 7,
      targetId: "3",
      text: "Make this shot more graphic and high contrast.",
      strategy: "regenerate_replacement",
      providerControls: {
        shots: {
          seedanceTier: "fast",
          durationSeconds: 8,
          resolution: "720p",
          seedMode: "lock",
          seed: 123,
        },
      },
      createdAt: "2026-05-02T00:00:00.000Z",
    });
    const version = ArtifactVersion.parse({
      id: "00000000-0000-4000-8000-000000000002",
      scope: "shots",
      phase: 7,
      targetId: "3",
      label: "Before shot regeneration",
      payload: { generatedShot: { shotIndex: 3 } },
      urls: { shot: "https://example.com/shot-3.mp4" },
      createdAt: "2026-05-02T00:00:00.000Z",
    });

    expect(directive.status).toBe("active");
    expect(directive.providerControls?.shots?.seedanceTier).toBe("fast");
    expect(version.urls.shot).toContain("shot-3.mp4");
  });

  it("validates provider controls on regenerate requests", () => {
    const phaseRequest = RegenerateRequest.parse({
      phase: 5,
      strategy: "regenerate_replacement",
      directiveText: "Make the reference images more ink-wash and monochrome.",
      target: { scope: "anchors", phase: 5 },
      providerControls: {
        anchors: {
          model: "gpt-image-2",
          size: "2048x2048",
          quality: "high",
          outputFormat: "webp",
          variantCount: 2,
        },
      },
    });
    const shotRequest = ShotRegenerateRequest.parse({
      strategy: "extend_continue",
      providerControls: {
        shots: {
          seedanceMode: "reference-to-video",
          seedanceTier: "standard",
          durationSeconds: 12,
          aspectRatio: "9:16",
          resolution: "720p",
          seedMode: "randomize",
          referenceImageLimit: 3,
          generateAudio: false,
        },
      },
    });
    const musicRequest = RegenerateRequest.parse({
      phase: 2,
      strategy: "regenerate_replacement",
      providerControls: {
        music: {
          outputFormat: "mp3_44100_192",
          seed: 808,
          respectSectionDurations: true,
          globalStyle: "cleaner synth pulse and wider low end",
          negativeStyle: "no muddy mix",
          sectionEdits: [
            {
              id: "pre_chorus",
              durationSeconds: 14,
              localStyle: "rising pads and syncopated percussion",
              negativeStyle: "no long silence",
            },
          ],
        },
      },
    });

    expect(phaseRequest.providerControls?.anchors?.outputFormat).toBe("webp");
    expect(shotRequest.providerControls?.shots?.durationSeconds).toBe(12);
    expect(musicRequest.providerControls?.music?.sectionEdits?.[0].durationSeconds).toBe(14);
  });

  it("validates project media generation and injection schemas", () => {
    const generation = MediaGeneration.parse({
      id: "00000000-0000-4000-8000-000000000010",
      projectId: "00000000-0000-4000-8000-000000000011",
      videoJobId: "00000000-0000-4000-8000-000000000012",
      kind: "video",
      provider: "fal",
      model: "bytedance/seedance-2.0/reference-to-video",
      status: "success",
      prompt: "A slow ink-shadow camera move through a paper stage.",
      controls: { durationSeconds: 8, resolution: "720p" },
      inputAssetIds: ["00000000-0000-4000-8000-000000000013"],
      outputUrls: { video: "https://example.com/media.mp4" },
      metadata: { assetId: "00000000-0000-4000-8000-000000000014" },
      costCents: 243,
      requestId: "fal_req_1",
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });
    const asset = MediaAsset.parse({
      id: "00000000-0000-4000-8000-000000000014",
      projectId: generation.projectId,
      videoJobId: generation.videoJobId,
      generationId: generation.id,
      kind: "video",
      role: "seedance_clip",
      url: "https://example.com/media.mp4",
      mimeType: "video/mp4",
      createdAt: "2026-05-03T00:00:00.000Z",
    });
    const request = MediaGenerationCreateRequest.parse({
      videoJobId: generation.videoJobId,
      kind: "image",
      provider: "openai",
      prompt: "Monochrome red sun anchor image.",
      controls: { role: "style", size: "1024x1536", quality: "high" },
    });
    const inject = MediaGenerationInjectRequest.parse({
      videoJobId: generation.videoJobId,
      action: "replace_selected_shot",
      shotIndex: 2,
    });

    expect(generation.status).toBe("success");
    expect(asset.generationId).toBe(generation.id);
    expect(request.execute).toBe(true);
    expect(inject.action).toBe("replace_selected_shot");
  });

  it("validates legacy media proposal messages without provider execution", () => {
    const message = RenderAgentMessageRequest.parse({
      videoJobId: "00000000-0000-4000-8000-000000000012",
      message: "Draft a darker bridge section with cleaner drums.",
    });
    const proposal = RenderAgentProposal.parse({
      title: "Draft ElevenLabs bridge render",
      rationale: "Creates a standalone track before injection.",
      kind: "music",
      provider: "elevenlabs",
      prompt: "Darker bridge section with cleaner drums.",
      controls: { outputFormat: "mp3_44100_192" },
      inputAssetIds: [],
      injectionAction: "use_as_music_track",
      costRisk: "One music call after confirmation.",
    });

    expect(message.mode).toBe("compose");
    expect(proposal.provider).toBe("elevenlabs");
    expect(proposal.costRisk).toContain("confirmation");
  });

  it("validates projects, library assets, and granular media session schemas", () => {
    const project = Project.parse({
      id: "00000000-0000-4000-8000-000000000101",
      userId: "media-session-user",
      name: "Granular media lab",
      createdAt: "2026-05-03T00:00:00.000Z",
    });
    const libraryAsset = LibraryAsset.parse({
      id: "00000000-0000-4000-8000-000000000102",
      userId: project.userId,
      kind: "music",
      name: "Bridge texture",
      role: "music_reference",
      url: "https://example.com/bridge.mp3",
      mimeType: "audio/mpeg",
      source: "upload",
      tags: ["bridge", "reference"],
      metadata: { bpm: 132 },
      favoriteAt: "2026-05-03T00:01:30.000Z",
      createdAt: "2026-05-03T00:01:00.000Z",
    });
    const collection = LibraryCollection.parse({
      id: "00000000-0000-4000-8000-000000000112",
      userId: project.userId,
      name: "Bridge reference pack",
      metadata: { purpose: "chorus texture" },
      assetIds: [libraryAsset.id],
      createdAt: "2026-05-03T00:01:40.000Z",
      updatedAt: "2026-05-03T00:01:45.000Z",
    });
    const session = MediaSession.parse({
      id: "00000000-0000-4000-8000-000000000103",
      projectId: project.id,
      kind: "music",
      title: "Bridge audio iteration",
      status: "active",
      sourceAssetId: "00000000-0000-4000-8000-000000000104",
      currentAssetId: "00000000-0000-4000-8000-000000000105",
      goal: "Make the bridge darker with cleaner drums.",
      settings: { requestStems: true, outputFormat: "mp3_44100_192" },
      createdAt: "2026-05-03T00:02:00.000Z",
      updatedAt: "2026-05-03T00:03:00.000Z",
    });
    const version = MediaSessionVersion.parse({
      id: "00000000-0000-4000-8000-000000000106",
      sessionId: session.id,
      assetId: session.currentAssetId,
      generationId: "00000000-0000-4000-8000-000000000107",
      label: "Darker bridge v2",
      prompt: "Darker bridge with cleaner drums.",
      controls: { requestStems: true },
      parentVersionId: "00000000-0000-4000-8000-000000000108",
      notes: "Session version keeps lineage.",
      createdAt: "2026-05-03T00:04:00.000Z",
    });
    const createRequest = MediaSessionCreateRequest.parse({
      kind: "video",
      sourceAssetId: "00000000-0000-4000-8000-000000000104",
      goal: "One Seedance clip with slower dolly motion.",
      settings: { durationSeconds: 8, resolution: "720p" },
    });
    const generationRequest = MediaSessionGenerationRequest.parse({
      prompt: "Make this clip slower and more graphic.",
      provider: "fal",
      controls: { durationSeconds: 8, seedMode: "lock" },
      inputAssetIds: ["00000000-0000-4000-8000-000000000105"],
      label: "Slower dolly",
    });

    expect(libraryAsset.kind).toBe("music");
    expect(libraryAsset.favoriteAt).toBeDefined();
    expect(collection.assetIds).toEqual([libraryAsset.id]);
    expect(session.kind).toBe("music");
    expect(version.parentVersionId).toBeDefined();
    expect(createRequest.kind).toBe("video");
    expect(generationRequest.execute).toBe(true);
  });
});

describe("LibraryUrlImportRequest url hardening", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(LibraryUrlImportRequest.parse({ url: "https://example.com/a.png", kind: "image" }).url).toBe(
      "https://example.com/a.png",
    );
    expect(LibraryUrlImportRequest.parse({ url: "http://example.com/a.png", kind: "image" }).url).toBe(
      "http://example.com/a.png",
    );
  });

  it("rejects /dev-blob/ paths and non-http(s) schemes the server cannot safely fetch", () => {
    for (const url of [
      "/dev-blob/foo.png",
      "file:///etc/passwd",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "ftp://host/x",
      "not a url",
    ]) {
      expect(() => LibraryUrlImportRequest.parse({ url, kind: "image" })).toThrow();
    }
  });
});

describe("LibraryAssetCreateRequest media URL hardening", () => {
  const base = { kind: "image" as const, name: "Asset", mimeType: "image/png" };

  it("accepts safe media URL schemes and /dev-blob/ paths", () => {
    for (const url of [
      "https://example.com/a.png",
      "http://example.com/a.png",
      "/dev-blob/library/a.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:https://example.com/uuid",
    ]) {
      expect(LibraryAssetCreateRequest.parse({ ...base, url }).url).toBe(url);
    }
  });

  it("rejects active-content/local schemes and non-URLs (stored values are rendered in the UI)", () => {
    for (const url of [
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "/relative/not-dev-blob.png",
      "not a url",
      "",
    ]) {
      expect(() => LibraryAssetCreateRequest.parse({ ...base, url })).toThrow();
    }
  });
});
