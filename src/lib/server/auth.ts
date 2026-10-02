import { getDailyBudgetCapUsd } from "@/lib/server/config";
import { cents } from "@/lib/cost";

export const STUDIO_SESSION_COOKIE = "studio_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type UserContext = {
  id: string;
  email: string;
  planTier: "dev" | "starter" | "pro";
  dailyBudgetCents: number;
  spendCapExempt?: boolean;
};

export async function getUserContext(request: Request): Promise<UserContext> {
  const headerUserId = request.headers.get("x-user-id");

  if (isAuthRequired()) {
    const session = await getSessionFromRequest(request);
    if (!session) {
      throw Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    return {
      id: session.uid,
      email: session.email ?? `${session.uid}@beta.local`,
      planTier: session.admin ? "pro" : "dev",
      dailyBudgetCents: cents(getDailyBudgetCapUsd()),
      spendCapExempt: isSpendCapExemptSession(session),
    };
  }

  return {
    id: headerUserId ?? "dev-user",
    email: request.headers.get("x-user-email") ?? "dev@local.test",
    planTier: "dev",
    dailyBudgetCents: cents(getDailyBudgetCapUsd()),
    spendCapExempt: process.env.DEV_SPEND_CAP_EXEMPT === "true",
  };
}

export type StudioSession = {
  admin?: boolean;
  email?: string;
  exp: number;
  uid: string;
};

export function isAuthRequired() {
  return process.env.REQUIRE_AUTH === "true" || process.env.PROVIDER_MODE === "live";
}

export function getAuthReadiness() {
  const configured = Boolean(process.env.AUTH_SECRET) && adminInviteCodes().length > 0;
  return {
    required: isAuthRequired(),
    configured,
    missing: [
      ...(!process.env.AUTH_SECRET ? ["AUTH_SECRET"] : []),
      ...(adminInviteCodes().length === 0 ? ["ADMIN_INVITE_CODES"] : []),
    ],
  };
}

export async function createSessionForInviteCode(code: string) {
  const trimmed = code.trim();
  const staticCodes = allInviteCodes();
  if (!process.env.AUTH_SECRET || (staticCodes.length === 0 && adminInviteCodes().length === 0)) {
    throw new Error("Studio access is not configured");
  }

  const uid = `beta_${(await sha256Hex(trimmed)).slice(0, 12)}`;
  if (!staticCodes.includes(trimmed)) return null;

  return signSession({
    admin: adminInviteCodes().includes(trimmed),
    uid,
    email: `${uid}@beta.local`,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
}

export async function hashInviteCode(code: string) {
  return sha256Hex(`invite:${code.trim()}`);
}

export async function requireAdminContext(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session?.admin) {
    throw Response.json({ error: "not_found" }, { status: 404 });
  }
  return session;
}

export async function getSessionFromRequest(request: Request) {
  return getSessionFromToken(getCookieValue(request.headers.get("cookie"), STUDIO_SESSION_COOKIE));
}

export async function getSessionFromToken(token?: string | null): Promise<StudioSession | null> {
  if (!token || !process.env.AUTH_SECRET) return null;
  if (token.length > 4096 || token.split(".").length !== 2) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expectedSignature = await hmacBase64Url(payload, process.env.AUTH_SECRET);
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  try {
    const session = JSON.parse(base64UrlDecode(payload)) as StudioSession;
    if (typeof session.uid !== "string" || !session.uid || typeof session.exp !== "number" ||
      !Number.isFinite(session.exp) || session.exp <= Math.floor(Date.now() / 1000) ||
      (session.admin !== undefined && typeof session.admin !== "boolean") ||
      (session.email !== undefined && typeof session.email !== "string")) return null;
    return session;
  } catch {
    return null;
  }
}

export function studioSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

function inviteCodes() {
  return (process.env.INVITE_CODES ?? process.env.BETA_INVITE_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function adminInviteCodes() {
  return (process.env.ADMIN_INVITE_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function allInviteCodes() {
  return [...new Set([...inviteCodes(), ...adminInviteCodes()])];
}

function isSpendCapExemptSession(session: StudioSession) {
  const exemptUserIds = envList("SPEND_CAP_EXEMPT_USER_IDS");
  const exemptEmails = envList("SPEND_CAP_EXEMPT_EMAILS");
  return exemptUserIds.includes(session.uid) || Boolean(session.email && exemptEmails.includes(session.email.toLowerCase()));
}

function envList(key: string) {
  return (process.env[key] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function getCookieValue(cookieHeader: string | null, name: string) {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function signSession(session: StudioSession) {
  const payload = base64UrlEncode(JSON.stringify(session));
  const signature = await hmacBase64Url(payload, process.env.AUTH_SECRET!);
  return `${payload}.${signature}`;
}

async function hmacBase64Url(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(value: string) {
  return bytesToBase64Url(encoder.encode(value));
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return decoder.decode(bytes);
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
