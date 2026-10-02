import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { createEditDirective } from "@/lib/editor";
import { EditDirectiveCreateRequest } from "@/lib/schemas";
import { getStore } from "@/lib/server/store";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/videos/[id]/edit-directives">,
) {
  try {
    const { id } = await context.params;
    const store = getStore();
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const job = auth.job;

    const body = EditDirectiveCreateRequest.parse(await request.json());
    const directive = createEditDirective(body);
    const updated = await store.updateJob(id, {
      editDirectives: [...job.editDirectives, directive],
    });

    return NextResponse.json({ videoId: updated.id, directive });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Edit directive failed";
    console.error("POST /api/videos/[id]/edit-directives failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/videos/[id]/edit-directives">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
