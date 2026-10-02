import { NextResponse } from "next/server";

import { getUserContext, type UserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";
import type { VideoJob } from "@/lib/schemas";

type AuthorizedVideo =
  | {
      job: VideoJob;
      response?: never;
      user: UserContext;
    }
  | {
      job?: never;
      response: Response;
      user?: never;
    };

export async function authorizeVideoRequest(
  request: Request,
  videoId: string,
): Promise<AuthorizedVideo> {
  try {
    const user = await getUserContext(request);
    const job = await getStore().getJob(videoId);
    if (!job || job.userId !== user.id) {
      return { response: NextResponse.json({ error: "Video not found" }, { status: 404 }) };
    }
    return { user, job };
  } catch (error) {
    if (error instanceof Response) return { response: error };
    throw error;
  }
}

export function idempotencyKeyFromRequest(request: Request, body?: unknown) {
  const bodyKey = typeof body === "object" &&
    body !== null &&
    "idempotencyKey" in body &&
    typeof body.idempotencyKey === "string"
    ? body.idempotencyKey
    : undefined;
  return request.headers.get("idempotency-key") ?? bodyKey;
}
