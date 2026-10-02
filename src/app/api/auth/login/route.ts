import { throttleLogin } from "@/lib/server/login-throttle";
import { apiErrorResponse, ApiRequestError } from "@/lib/server/api-error";
import { NextResponse } from "next/server";

import {
  STUDIO_SESSION_COOKIE,
  createSessionForInviteCode,
  studioSessionCookieOptions,
} from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { code?: unknown };
    const code = body && typeof body.code === "string" ? body.code : "";
    if (!code.trim() || code.length > 256) throw new ApiRequestError("Enter a valid access code.", 400, "invalid_access_code");
    await throttleLogin(request, code);
    const token = await createSessionForInviteCode(code);
    if (!token) {
      return NextResponse.json({ error: "Invalid access code" }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(STUDIO_SESSION_COOKIE, token, studioSessionCookieOptions());
    return response;
  } catch (error) {
    return apiErrorResponse(error, "Login failed");
  }
}
