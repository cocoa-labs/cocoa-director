import { providerFetch } from "@/lib/server/provider-execution";
import { PROVIDER_CAPABILITIES } from "@/lib/provider-capabilities";
import { editorialModel } from "@/lib/model-routing";
import {
  AgentActionProposal,
  type AgentActionProposal as AgentActionProposalType,
  type MediaAsset,
  type MediaKind,
  type MediaProvider,
  type MediaSession,
  type MediaSessionMessage,
  type MediaSessionVersion,
  type VideoJob,
} from "@/lib/schemas";
import { getProviderMode } from "@/lib/server/config";
import { getStore } from "@/lib/server/store";

export type ProjectMedia = Awaited<ReturnType<ReturnType<typeof getStore>["listProjectMedia"]>>;
export type SessionWithDetails = MediaSession & { versions: MediaSessionVersion[]; messages: MediaSessionMessage[] };

export type CocoaDirectorAgentContext = {
  workspace?: string;
  selectedAssetIds?: string[];
  shotIndex?: number;
};

export async function createCocoaDirectorResponse({
  projectId,
  message,
  session,
  job,
  media,
  context = {},
}: {
  projectId: string;
  message: string;
  session?: SessionWithDetails | null;
  job: VideoJob | null;
  media: ProjectMedia;
  context?: CocoaDirectorAgentContext;
}): Promise<{ reply: string; proposal?: AgentActionProposalType }> {
  if (getProviderMode() !== "live" || !process.env.OPENAI_API_KEY) {
    return heuristicCocoaDirectorResponse(message, session ?? null, job, media, context);
  }

  try {
    const response = await providerFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: editorialModel(),
        input: [
          {
            role: "system",
            content:
              "You are Cocoa Director, the single embedded agentic interface for this AI music video studio. Return only JSON. You may propose media_generation, pipeline_directive, pipeline_regeneration, or media_injection actions. Never claim a provider call, regeneration, injection, or pipeline mutation has already run. Prefer one clear confirmable proposal when the user asks to create, edit, render, regenerate, or inject media. If the user asks for a video or clip with audio, music, soundtrack, or sound, classify it as kind video with Seedance controls.generateAudio true. Only classify as kind music when the user primarily asks to compose or create a song, track, score, or audio asset.",
          },
          {
            role: "user",
            content: JSON.stringify({
              projectId,
              userMessage: message,
              surfaceContext: context,
              currentSession: session ? summarizeSession(session, media) : null,
              recentSessionMessages: session
                ? session.messages.slice(-12).map((item) => ({
                    role: item.role,
                    content: item.content,
                    proposalType: item.proposal?.actionType,
                  }))
                : [],
              currentJob: job ? summarizeJob(job) : null,
              mediaLibrary: {
                generationCount: media.generations.length,
                assetCount: media.assets.length,
                latestAssets: media.assets.slice(0, 10).map((asset) => ({
                  id: asset.id,
                  kind: asset.kind,
                  role: asset.role,
                  mimeType: asset.mimeType,
                  generationId: asset.generationId,
                })),
              },
              capabilities: PROVIDER_CAPABILITIES,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "cocoa_director_agent_response",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["reply", "proposal"],
              properties: {
                reply: { type: "string" },
                proposal: {
                  anyOf: [
                    { type: "null" },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["actionType", "title", "rationale", "costRisk"],
                      properties: {
                        actionType: {
                          type: "string",
                          enum: ["media_generation", "pipeline_directive", "pipeline_regeneration", "media_injection"],
                        },
                        title: { type: "string" },
                        rationale: { type: "string" },
                        costRisk: { type: "string" },
                        kind: { type: "string", enum: ["image", "video", "music", "render"] },
                        provider: { type: "string", enum: ["openai", "fal", "elevenlabs", "vercel-render", "mock"] },
                        prompt: { type: "string" },
                        controls: { type: "object", additionalProperties: true },
                        inputAssetIds: { type: "array", items: { type: "string" } },
                        label: { type: "string" },
                        scope: { type: "string", enum: ["preview", "treatment", "music", "anchors", "shots", "render", "phase"] },
                        phase: { type: "number", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
                        targetId: { type: "string" },
                        strategy: { type: "string", enum: ["edit_current", "regenerate_replacement", "extend_continue"] },
                        directiveText: { type: "string" },
                        providerControls: { type: "object", additionalProperties: true },
                        generationId: { type: "string" },
                        injectionAction: {
                          type: "string",
                          enum: ["use_as_anchor", "use_as_shot_reference", "replace_selected_shot", "use_as_music_track", "use_in_render_manifest"],
                        },
                        role: { type: "string", enum: ["character", "style", "environment", "palette", "title"] },
                        shotIndex: { type: "number" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    });

    if (!response.ok) throw new Error(`OpenAI Cocoa Director request failed: ${response.status}`);
    const json = (await response.json()) as { output?: Array<{ content?: Array<{ text?: string }> }>; output_text?: string };
    const text = json.output_text ?? json.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
    if (!text) throw new Error("OpenAI Cocoa Director response was empty");
    const parsed = JSON.parse(text) as { reply: string; proposal?: unknown };
    const proposal = parsed.proposal ? AgentActionProposal.parse(removeNullish(parsed.proposal)) : undefined;
    return { reply: parsed.reply, proposal };
  } catch (error) {
    console.warn("Cocoa Director OpenAI fallback", error);
    return heuristicCocoaDirectorResponse(message, session ?? null, job, media, context);
  }
}

function heuristicCocoaDirectorResponse(
  message: string,
  session: SessionWithDetails | null,
  job: VideoJob | null,
  media: ProjectMedia,
  context: CocoaDirectorAgentContext,
): { reply: string; proposal?: AgentActionProposalType } {
  const lower = message.toLowerCase();
  const wantsPipeline = /\b(pipeline|director|treatment|anchor|anchors|shot|shots|render|music system|beat grid|qa)\b/.test(lower);
  const wantsRegeneration = /\b(regenerate|rerun|redo|replace|rebuild)\b/.test(lower);
  const wantsInjection = /\b(inject|promote|use this|send this|put this|use current)\b/.test(lower);

  if ((wantsPipeline || wantsRegeneration || wantsInjection) && !job && !session) {
    return {
      reply:
        "I can create standalone image, video, and music assets here now. Pipeline edits unlock once a director run exists.",
    };
  }

  if (job && wantsInjection) {
    const sessionAsset = session ? currentSessionAsset(session, media.assets) : undefined;
    const selectedAsset = media.assets.find((asset) => context.selectedAssetIds?.includes(asset.id));
    const asset = sessionAsset ?? selectedAsset;
    const generationId = asset?.generationId ?? session?.versions.find((version) => version.assetId === asset?.id)?.generationId;
    if (generationId) {
      return {
        reply:
          "I staged this as a pipeline injection proposal. It will not touch the current run unless you confirm it.",
        proposal: {
          actionType: "media_injection",
          title: "Inject selected media",
          rationale: "The selected media can be promoted into the active director job using the guarded injection endpoint.",
          costRisk: "No provider generation is started by this proposal; it only changes the pipeline after confirmation.",
          controls: {},
          inputAssetIds: context.selectedAssetIds ?? [],
          generationId,
          kind: asset?.kind ?? sessionKindToMediaKind(session?.kind) ?? "image",
          injectionAction: injectionActionForKind(asset?.kind ?? sessionKindToMediaKind(session?.kind) ?? "image"),
          role: asset?.kind === "image" ? "style" : undefined,
          shotIndex: asset?.kind === "video" ? context.shotIndex ?? 0 : undefined,
        },
      };
    }
  }

  if (job && wantsRegeneration) {
    const target = pipelineTargetForMessage(lower, job, context);
    return {
      reply:
        "I staged this as a pipeline regeneration proposal. Confirming it will use the existing regenerate path and preserve artifact history.",
      proposal: {
        actionType: "pipeline_regeneration",
        title: `Regenerate ${proposalScopeLabel(target.scope, target.phase)}`,
        rationale: "This request changes an existing director artifact, so the proposal targets the guarded regeneration workflow.",
        costRisk: "Can trigger downstream provider calls after confirmation depending on phase and strategy.",
        controls: {},
        inputAssetIds: context.selectedAssetIds ?? [],
        scope: target.scope,
        phase: target.phase,
        targetId: target.targetId,
        strategy: "regenerate_replacement",
        directiveText: message,
      },
    };
  }

  if (job && wantsPipeline && !standaloneCreationRequested(lower)) {
    const target = pipelineTargetForMessage(lower, job, context);
    return {
      reply:
        "I captured this as a scoped pipeline directive. Confirm it to save the direction without executing a provider call yet.",
      proposal: {
        actionType: "pipeline_directive",
        title: `Save ${proposalScopeLabel(target.scope, target.phase)} direction`,
        rationale: "This is best handled as a durable edit instruction that can be applied when you regenerate or advance the relevant phase.",
        costRisk: "No provider spend. This only saves an instruction after confirmation.",
        controls: {},
        inputAssetIds: context.selectedAssetIds ?? [],
        scope: target.scope,
        phase: target.phase,
        targetId: target.targetId,
        strategy: "regenerate_replacement",
        directiveText: message,
      },
    };
  }

  const mediaKind = requestedMediaKind(lower, session?.kind);
  const proposal = mediaGenerationProposal(message, session, mediaKind, job, context);
  return {
    reply:
      session
        ? "I staged a session version proposal with provider-aware controls. Confirm it here and I will create the new version."
        : "I staged a standalone media creation proposal. Confirm it here and I will create the asset in this project.",
    proposal,
  };
}

function mediaGenerationProposal(
  message: string,
  session: SessionWithDetails | null,
  kind: MediaKind,
  job: VideoJob | null,
  context: CocoaDirectorAgentContext,
): AgentActionProposalType {
  const provider = providerForMediaKind(kind);
  const inputAssetIds = session
    ? [session.currentAssetId, session.sourceAssetId].filter(Boolean) as string[]
    : context.selectedAssetIds ?? [];
  return {
    actionType: "media_generation",
    title: session ? `Create ${kind} session version` : `Create ${kind} asset`,
    rationale: session
      ? "This creates a new version in the selected media session and leaves the director pipeline unchanged."
      : "This creates a standalone project media asset before you decide whether to use it in the pipeline.",
    costRisk: generationCostRisk(kind),
    kind,
    provider,
    prompt: message,
    controls: defaultControlsForKind(kind, job, message, inputAssetIds.length > 0),
    inputAssetIds,
    label: session ? `${kind} Cocoa Director version` : `${kind} Cocoa Director asset`,
    targetId: kind === "video" && context.shotIndex !== undefined ? String(context.shotIndex) : undefined,
    injectionAction: injectionActionForKind(kind),
  };
}

function summarizeSession(session: SessionWithDetails, media: ProjectMedia) {
  const asset = currentSessionAsset(session, media.assets);
  return {
    id: session.id,
    kind: session.kind,
    title: session.title,
    status: session.status,
    goal: session.goal,
    currentAsset: asset ? { id: asset.id, kind: asset.kind, role: asset.role, generationId: asset.generationId } : null,
    versionCount: session.versions.length,
    latestVersions: session.versions.slice(0, 6).map((version) => ({
      id: version.id,
      label: version.label,
      prompt: version.prompt,
      generationId: version.generationId,
    })),
  };
}

function summarizeJob(job: VideoJob) {
  return {
    id: job.id,
    status: job.status,
    currentPhase: job.currentPhase,
    prompt: job.prompt,
    aspectRatio: job.aspectRatio,
    visualMode: job.visualMode,
    anchorCount: job.anchorAssets.length,
    shotCount: job.generatedShots.length,
    plannedShotCount: job.shotPlan?.shots.length ?? 0,
    hasMusic: Boolean(job.musicTrack),
    hasRender: Boolean(job.finalVideoUrl),
    editDirectives: job.editDirectives.slice(-8).map((directive) => ({
      scope: directive.scope,
      phase: directive.phase,
      targetId: directive.targetId,
      text: directive.text,
    })),
  };
}

function currentSessionAsset(session: SessionWithDetails, assets: MediaAsset[]) {
  return session.currentAssetId ? assets.find((asset) => asset.id === session.currentAssetId) : undefined;
}

function standaloneCreationRequested(message: string) {
  return /\b(create|make|generate|draft|compose|write|produce)\b/.test(message);
}

function requestedMediaKind(message: string, sessionKind?: MediaSession["kind"]): MediaKind {
  if (/\b(video|clip|seedance|motion|animation|movie|scene|b-roll|broll)\b/.test(message)) return "video";
  if (/\b(music|song|audio|track|score|soundtrack|beat|compose)\b/.test(message)) return "music";
  if (message.includes("render") || message.includes("manifest") || message.includes("export")) return "render";
  return sessionKindToMediaKind(sessionKind) ?? "image";
}

function sessionKindToMediaKind(kind?: MediaSession["kind"]): MediaKind | null {
  if (kind === "image" || kind === "video" || kind === "music" || kind === "render") return kind;
  return null;
}

function providerForMediaKind(kind: MediaKind): MediaProvider {
  if (getProviderMode() !== "live") return "mock";
  if (kind === "image") return "openai";
  if (kind === "video") return "fal";
  if (kind === "music") return "elevenlabs";
  return "vercel-render";
}

function defaultControlsForKind(kind: MediaKind, job: VideoJob | null, message: string, hasInputAssets = false) {
  const requestedSeconds = requestedDurationSeconds(message);
  if (kind === "image") return { model: "gpt-image-2", size: "1024x1536", quality: "high", outputFormat: "png", role: "style" };
  if (kind === "video") {
    return {
      seedanceMode: hasInputAssets ? "reference-to-video" : "text-to-video",
      seedanceTier: "standard",
      durationSeconds: requestedSeconds ? clamp(requestedSeconds, 4, 15) : 8,
      resolution: "720p",
      aspectRatio: job?.aspectRatio ?? "9:16",
      generateAudio: wantsSeedanceAudio(message),
    };
  }
  if (kind === "music") {
    return {
      outputFormat: "mp3_44100_192",
      durationSeconds: requestedSeconds ? clamp(requestedSeconds, 12, 120) : job?.durationSeconds ?? 60,
      respectSectionDurations: true,
      requestStems: false,
    };
  }
  return {};
}

function wantsSeedanceAudio(message: string) {
  return /\b(audio|sound|soundtrack|score|music|musical|song|dialogue|ambient|ambience|background)\b/i.test(message);
}

function requestedDurationSeconds(message: string) {
  const match = message.match(/\b(\d{1,3})[\s-]*(?:second|seconds|sec|secs|s)\b/i);
  return match ? Number(match[1]) : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function generationCostRisk(kind: MediaKind) {
  if (kind === "image") return "Runs one image generation only after confirmation.";
  if (kind === "video") return "Runs one Seedance video generation only after confirmation.";
  if (kind === "music") return "Runs one music generation only after confirmation.";
  return "Stages render work only after confirmation.";
}

function injectionActionForKind(kind: MediaKind) {
  if (kind === "image") return "use_as_anchor" as const;
  if (kind === "video") return "replace_selected_shot" as const;
  if (kind === "music") return "use_as_music_track" as const;
  return "use_in_render_manifest" as const;
}

function pipelineTargetForMessage(message: string, job: VideoJob, context: CocoaDirectorAgentContext) {
  if (message.includes("anchor")) return { scope: "anchors" as const, phase: 5 as const };
  if (message.includes("shot")) return { scope: "shots" as const, phase: 7 as const, targetId: String(context.shotIndex ?? 0) };
  if (message.includes("music") || message.includes("beat")) return { scope: "music" as const, phase: 2 as const };
  if (message.includes("render") || message.includes("export")) return { scope: "render" as const, phase: 9 as const };
  if (message.includes("treatment")) return { scope: "treatment" as const, phase: 1 as const };
  const currentPhase = Math.min(9, Math.max(1, job.currentPhase));
  return { scope: "phase" as const, phase: currentPhase as AgentActionProposalType["phase"] };
}

function proposalScopeLabel(scope?: string, phase?: number) {
  if (scope && scope !== "phase") return scope;
  return phase ? `phase ${phase}` : "pipeline";
}

function removeNullish(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removeNullish);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, removeNullish(entry)]),
  );
}
