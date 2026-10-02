import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { ProjectCreateRequest } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await getUserContext(request);
    const projects = await getStore().listProjects(user.id);
    return NextResponse.json({ projects });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project lookup failed";
    console.error("GET /api/projects failed", error);
    return apiErrorResponse(error, message);
  }
}

async function handlePOST(request: Request) {
  try {
    const user = await getUserContext(request);
    const body = ProjectCreateRequest.parse(await request.json());
    const project = await getStore().createProject({
      userId: user.id,
      name: body.name,
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project creation failed";
    console.error("POST /api/projects failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request) {
  return actionRequest(request, () => handlePOST(request));
}
