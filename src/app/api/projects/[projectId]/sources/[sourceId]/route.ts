import { criticalSection } from "@/lib/server/critical-section";
import { actionRequest } from "@/lib/server/action-request";
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/server/api-error";
import { getUserContext } from "@/lib/server/auth";
import { assertSourceEditable, removeProductionSource, requireOwnedSource } from "@/lib/server/production-sources";
import { invalidateNewsAfterSourceChange } from "@/lib/server/news-editorial";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

const SourceUpdate = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(200_000).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    const user = await getUserContext(request);
    const { projectId, sourceId } = await context.params;
    const source = await requireOwnedSource(sourceId, projectId, user);
    const fragments = await getStore().listSourceFragments(source.id);
    return NextResponse.json({ source, fragments });
  } catch (error) {
    return sourceError(error);
  }
}

async function handlePATCH(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    const user = await getUserContext(request);
    const { projectId, sourceId } = await context.params;
    const source = await requireOwnedSource(sourceId, projectId, user);
    const patch = SourceUpdate.parse(await request.json());
    await assertSourceEditable(source);
    if (patch.text !== undefined && source.kind !== "text") {
      return NextResponse.json({ error: "Only pasted-text sources can be edited directly." }, { status: 400 });
    }
    if (patch.text !== undefined) {
      const hash = createHash("sha256").update(patch.text).digest("hex");
      await getStore().replaceSourceFragments(source.id, [{
        sourceId: source.id,
        ordinal: 0,
        section: patch.title ?? source.title,
        text: patch.text,
        textHash: hash,
        extractionMethod: "plain_text",
      }]);
      await getStore().updateProductionSource(source.id, { sha256: hash, byteSize: Buffer.byteLength(patch.text) });
    }
    const updated = patch.title
      ? await getStore().updateProductionSource(source.id, { title: patch.title })
      : await getStore().getProductionSource(source.id);
    await invalidateNewsAfterSourceChange(source.productionId, source);
    return NextResponse.json({ source: updated, invalidated: ["claim_ledger", "script", "storyboard", "generation", "render"] });
  } catch (error) {
    return sourceError(error);
  }
}

async function handleDELETE(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    const user = await getUserContext(request);
    const { projectId, sourceId } = await context.params;
    const source = await removeProductionSource(sourceId, projectId, user);
    await invalidateNewsAfterSourceChange(source?.productionId, source ?? undefined);
    return NextResponse.json({ removed: Boolean(source), invalidated: ["claim_ledger", "script", "storyboard", "generation", "render"] });
  } catch (error) {
    return sourceError(error);
  }
}

function sourceError(error: unknown) {
  if (error instanceof Response) return error;
  const message = error instanceof Error ? error.message : "Source operation failed";
  if (message === "Source not found." || message === "Project not found.") {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  return apiErrorResponse(error, message);
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  const { projectId } = await context.params;
  return actionRequest(request, () => criticalSection(`editorial:${projectId}`, () => handlePATCH(request, context)));
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  const { projectId } = await context.params;
  return actionRequest(request, () => criticalSection(`editorial:${projectId}`, () => handleDELETE(request, context)));
}
