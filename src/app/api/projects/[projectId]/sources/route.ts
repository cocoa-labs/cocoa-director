import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/server/api-error";
import { authorizeProjectRequest } from "@/lib/server/projects";
import {
  addTextProductionSource,
  addUrlProductionSource,
  listOwnedProductionSources,
} from "@/lib/server/production-sources";

export const runtime = "nodejs";

const SourceCreateBody = z.object({
  sources: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text"),
      title: z.string().trim().min(1).max(200).default("Pasted text"),
      text: z.string().trim().min(1).max(200_000),
    }),
    z.object({
      kind: z.literal("url"),
      title: z.string().trim().min(1).max(200).optional(),
      url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "URL must use http or https"),
    }),
  ])).min(1).max(25),
});

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;
    return NextResponse.json({ sources: await listOwnedProductionSources(projectId, auth.user) });
  } catch (error) {
    return apiErrorResponse(error, "Source lookup failed");
  }
}

async function handlePOST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;
    const body = SourceCreateBody.parse(await request.json());
    const sources = [];
    for (const source of body.sources) {
      sources.push(source.kind === "text"
        ? await addTextProductionSource({ ...source, projectId, user: auth.user })
        : await addUrlProductionSource({ ...source, projectId, user: auth.user }));
    }
    return NextResponse.json({ sources }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiErrorResponse(error, "Source creation failed");
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}
