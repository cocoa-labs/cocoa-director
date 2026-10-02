import { providerFetch } from "@/lib/server/provider-execution";
import type { AnchorAsset, AnchorAudit, CreativeBrief } from "@/lib/schemas";
import { visionAuditModel } from "@/lib/model-routing";
import { getProviderMode } from "@/lib/server/config";
import { nowIso } from "@/lib/trace";

const OVERUSED_UNREQUESTED = [
  { pattern: /cassette|tape loop/i, label: "cassette tape" },
  { pattern: /microphone|\bmic\b/i, label: "microphone" },
  { pattern: /\bheart|paper heart/i, label: "heart" },
];

export async function auditAnchorAssets(brief: CreativeBrief, anchors: AnchorAsset[]) {
  const audited = [];
  for (const anchor of anchors) {
    audited.push({ ...anchor, audit: await auditAnchorAsset(brief, anchor) });
  }
  return audited;
}

export async function auditAnchorAsset(brief: CreativeBrief, anchor: AnchorAsset): Promise<AnchorAudit> {
  if (getProviderMode() === "live" && process.env.OPENAI_API_KEY) {
    const audit = await visionAuditAnchor(brief, anchor).catch(() => null);
    if (audit) return audit;
  }
  return promptAuditAnchor(brief, anchor);
}

function promptAuditAnchor(brief: CreativeBrief, anchor: AnchorAsset): AnchorAudit {
  const requestedMotifs = brief.visualSignature?.recurringMotifs ?? [];
  const prompt = `${anchor.promptUsed} ${brief.visualWorld}`;
  const unexpected = OVERUSED_UNREQUESTED
    .filter(({ pattern, label }) => pattern.test(prompt) && !requestedMotifs.some((motif) => pattern.test(motif) || motif.toLowerCase().includes(label)))
    .map(({ label }) => label);
  const aligned = unexpected.length === 0;
  return {
    role: anchor.role,
    status: aligned ? "aligned" : "excluded",
    dominantObjects: requestedMotifs.slice(0, 5),
    styleAlignment: aligned ? 0.86 : 0.24,
    reuseEligible: aligned,
    notes: aligned
      ? ["Prompt audit found no unrequested overused motif language."]
      : [`Excluded from Seedance references because prompt text includes unrequested ${unexpected.join(", ")}.`],
    source: "prompt",
    auditedAt: nowIso(),
  };
}

async function visionAuditAnchor(brief: CreativeBrief, anchor: AnchorAsset): Promise<AnchorAudit | null> {
  const requestedMotifs = brief.visualSignature?.recurringMotifs ?? [];
  const response = await providerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: visionAuditModel(),
      input: [
        {
          role: "system",
          content: [
            "You audit generated anchor images for Cocoa Director before they are reused as video references.",
            "Return only JSON matching the schema.",
            "Flag cassette tapes, microphones, hearts, and generic music props as unexpected unless explicitly listed as requested motifs.",
            "A low-alignment anchor should not be reused as a Seedance reference.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                role: anchor.role,
                requestedMotifs,
                musicIntent: brief.styleContract?.musicIntent,
                visualIntent: brief.styleContract?.visualIntent,
                promptUsed: anchor.promptUsed.slice(0, 1800),
              }),
            },
            { type: "input_image", image_url: anchor.url, detail: "low" },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "anchor_audit",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["dominantObjects", "styleAlignment", "reuseEligible", "notes"],
            properties: {
              dominantObjects: { type: "array", items: { type: "string" } },
              styleAlignment: { type: "number" },
              reuseEligible: { type: "boolean" },
              notes: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    }),
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { id?: string; output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = json.output_text ?? json.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
  if (!text) return null;
  const parsed = JSON.parse(text) as {
    dominantObjects?: string[];
    styleAlignment?: number;
    reuseEligible?: boolean;
    notes?: string[];
  };
  const styleAlignment = clamp01(parsed.styleAlignment ?? 0.5);
  const reuseEligible = Boolean(parsed.reuseEligible) && styleAlignment >= 0.55;
  return {
    role: anchor.role,
    status: reuseEligible ? "aligned" : "low_alignment",
    dominantObjects: (parsed.dominantObjects ?? []).slice(0, 8),
    styleAlignment,
    reuseEligible,
    notes: (parsed.notes ?? []).slice(0, 5),
    source: "vision",
    providerRequestId: json.id,
    auditedAt: nowIso(),
  };
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
