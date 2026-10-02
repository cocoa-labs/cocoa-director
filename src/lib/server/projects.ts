import { NextResponse } from "next/server";

import { getUserContext, type UserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";
import type { Project } from "@/lib/schemas";

type AuthorizedProject =
  | {
      project: Project;
      response?: never;
      user: UserContext;
    }
  | {
      project?: never;
      response: Response;
      user?: never;
    };

export async function authorizeProjectRequest(
  request: Request,
  projectId: string,
): Promise<AuthorizedProject> {
  try {
    const user = await getUserContext(request);
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return { response: NextResponse.json({ error: "Project not found" }, { status: 404 }) };
    }
    return { user, project };
  } catch (error) {
    if (error instanceof Response) return { response: error };
    throw error;
  }
}
