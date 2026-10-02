import { createHash } from "node:crypto";
import type { GraphicSpecV2, HybridVisualPlanV2, SourceBundle, SourceVisualArtifact, VisualBeat } from "@/lib/schemas";

export function attachAuthenticSourceVisuals(plan: HybridVisualPlanV2, sourceBundle: SourceBundle): HybridVisualPlanV2 {
  const claims = new Map(sourceBundle.claims.map((claim) => [claim.id, claim]));
  const sources = new Map(sourceBundle.inputs.map((source) => [source.id, source]));
  const sceneEvidenceCounts = new Map<string, number>();
  const beats = plan.beats.map((beat) => {
    if (!isInformationBeat(beat)) return beat;
    const references = [...new Map(beat.evidenceIds.flatMap((claimId) => claims.get(claimId)?.evidenceRefs ?? [])
      .filter((reference) => beat.sourceIds.length === 0 || beat.sourceIds.includes(reference.sourceId))
      .map((reference) => [`${reference.sourceId}:${reference.excerptHash}`, reference])).values()];
    const evidenceIndex = sceneEvidenceCounts.get(beat.sceneId) ?? 0;
    const evidence = references[evidenceIndex % Math.max(1, references.length)];
    sceneEvidenceCounts.set(beat.sceneId, evidenceIndex + 1);
    const source = evidence ? sources.get(evidence.sourceId) : undefined;
    if (!evidence || !source) return { ...beat, graphicSpec: undefined, sourceVisual: undefined };
    const excerptHash = evidence.excerptHash.toLowerCase();
    const fragmentId = evidence.fragmentId ?? `fragment-${excerptHash.slice(0, 16)}`;
    const locator = evidence.pageNumber ? `Page ${evidence.pageNumber}` : evidence.section || "Article excerpt";
    const sourceVisual: SourceVisualArtifact = {
      id: `source-visual-${beat.id}`,
      sourceId: source.id,
      fragmentId,
      kind: source.kind === "document"
        ? evidence.extractionMethod === "ocr" || evidence.extractionMethod === "mixed" ? "ocr_page_card" : evidence.pageNumber ? "pdf_page" : "ocr_page_card"
        : "url_excerpt_card",
      title: source.title || (source.kind === "url" ? domainFor(source.url) : "Source document"),
      domain: source.kind === "url" ? domainFor(source.canonicalUrl ?? source.url) : undefined,
      publishedAt: source.kind === "url" ? source.publishedAt : undefined,
      pageNumber: evidence.pageNumber,
      locator,
      excerpt: evidence.excerpt,
      excerptHash,
      sourceUrl: source.kind === "url" ? source.canonicalUrl ?? source.url : evidence.sourceUrl,
      extractionMethod: evidence.extractionMethod === "plain_text" ? undefined
        : evidence.extractionMethod ?? (source.kind === "document" ? evidence.pageNumber ? "digital" : "ocr" : "html"),
    };
    const sourceExcerptSpec: GraphicSpecV2 = {
      version: 2,
      family: "source_excerpt",
      title: sourceVisual.title,
      fragmentId,
      excerptHash,
      excerpt: evidence.excerpt,
      locator,
      overlayPlacement: beat.graphicSpec?.overlayPlacement ?? "left",
    };
    const graphicSpec = beat.kind === "data_visualization"
      ? quantitativeGraphicSpec(evidence.excerpt, beat.evidenceIds, sourceVisual.title, sourceExcerptSpec.overlayPlacement) ?? sourceExcerptSpec
      : sourceExcerptSpec;
    const fullScreenLimit = sourceVisual.kind === "pdf_page" || sourceVisual.kind === "pdf_highlight_crop" ? 4_000 : 3_000;
    return { ...beat, sourceVisual, graphicSpec, fullScreen: graphicSpec.family === "source_excerpt" && beat.kind !== "composite" && beat.endMs - beat.startMs <= fullScreenLimit };
  });
  return { ...plan, version: 4, beats };
}

export function validateGraphicPayload(beat: VisualBeat) {
  const spec = beat.graphicSpec;
  if (!spec || !("version" in spec) || spec.version !== 2) return { valid: false, reason: "A V2 evidence payload is required." };
  if (spec.family === "source_excerpt") {
    if (!beat.sourceVisual) return { valid: false, reason: "Source excerpt has no authentic source visual." };
    if (spec.fragmentId !== beat.sourceVisual.fragmentId || spec.excerptHash !== beat.sourceVisual.excerptHash) return { valid: false, reason: "Source excerpt identity does not match the source artifact." };
    if (normalizeHash(spec.excerptHash, spec.excerpt) !== spec.excerptHash) return { valid: false, reason: "Source excerpt hash does not match its exact text." };
    return { valid: true };
  }
  if (["hero_number", "magnitude_comparison", "change_over_time", "ranking", "part_to_whole"].includes(spec.family)) {
    return "values" in spec && spec.values.length > 0 && spec.values.every((value) => value.evidenceId && value.unit)
      ? { valid: true }
      : { valid: false, reason: "Chart values require cited units and context." };
  }
  if (spec.family === "geographic_map") return spec.entities.length > 0 ? { valid: true } : { valid: false, reason: "Map has no supported geographic entities." };
  if (spec.family === "timeline") return spec.events.length >= 2 ? { valid: true } : { valid: false, reason: "Timeline needs at least two cited dates." };
  return "nodes" in spec && "edges" in spec && spec.nodes.length >= 2 && spec.edges.length >= 1 ? { valid: true } : { valid: false, reason: "Diagram lacks evidence-backed nodes or relationships." };
}

export function exactExcerptHash(excerpt: string) {
  return createHash("sha256").update(excerpt.trim()).digest("hex");
}

function normalizeHash(candidate: string, excerpt: string) {
  const exact = exactExcerptHash(excerpt);
  return candidate.toLowerCase() === exact ? candidate.toLowerCase() : exact;
}

function isInformationBeat(beat: VisualBeat) {
  return beat.kind === "documentary_source" || beat.kind === "document_excerpt" || beat.kind === "data_visualization" || beat.kind === "composite";
}

function quantitativeGraphicSpec(excerpt: string, evidenceIds: string[], title: string, overlayPlacement: GraphicSpecV2["overlayPlacement"]): GraphicSpecV2 | undefined {
  const matches = [...excerpt.matchAll(/(?:([$£€])\s*)?(\d[\d,]*(?:\.\d+)?)\s*(%|percent|percentage points?|thousand|million|billion|trillion|years?|months?|days?|hours?)/gi)].slice(0, 5);
  const values = matches.map((match, index) => {
    const value = Number((match[2] ?? "").replaceAll(",", ""));
    const currency = match[1] ?? "";
    const unit = `${currency}${match[3] ?? ""}`.trim();
    return {
      label: index === 0 ? "Reported figure" : `Reported figure ${index + 1}`,
      value,
      unit,
      baseline: "As stated in the cited source excerpt",
      evidenceId: evidenceIds[Math.min(index, Math.max(0, evidenceIds.length - 1))] ?? "source-evidence",
    };
  }).filter((value) => Number.isFinite(value.value) && Boolean(value.unit));
  if (values.length === 0) return undefined;
  return { version: 2, family: values.length === 1 ? "hero_number" : "magnitude_comparison", title, values, overlayPlacement };
}

function domainFor(url?: string) {
  if (!url) return "Source";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Source"; }
}
