import { NextRequest, NextResponse } from "next/server";

const PUBLIC_FILE = /\.(?:png|jpg|jpeg|webp|gif|svg|ico|css|js|txt|xml|webmanifest)$/i;
import { STUDIO_SESSION_COOKIE, getSessionFromToken, isAuthRequired } from "@/lib/server/auth";
const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/system/readiness",
  "/api/uploads/library/completed",
  "/api/uploads/sources/completed",
  "/api/maintenance/cleanup",
]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    !isAuthRequired() ||
    pathname.startsWith("/_next") ||
    (!pathname.startsWith("/api/") && PUBLIC_FILE.test(pathname)) ||
    PUBLIC_API_PATHS.has(pathname)
  ) {
    return NextResponse.next();
  }

  const session = await getSessionFromToken(request.cookies.get(STUDIO_SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
