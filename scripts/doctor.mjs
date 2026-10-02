import "./env.mjs";
import pg from "pg";
import { findMediaTools, mediaCommand, MEDIA_TOOLS_RELEASE } from "../src/lib/server/media-tools.ts";
const live = process.env.PROVIDER_MODE === "live";
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });
check("node", process.versions.node.split(".")[0] === "24", "Node 24 required");
check("providerMode", !process.env.PROVIDER_MODE || ["mock", "live"].includes(process.env.PROVIDER_MODE), live ? "live" : "mock");
try {
  const tools = await findMediaTools();
  if (tools) {
    const version = await mediaCommand(tools.ffmpeg, ["-version"], { timeout: 5000 });
    const probe = await mediaCommand(tools.ffprobe, ["-version"], { timeout: 5000 });
    check("mediaTools", !version.includes("--enable-nonfree") && probe.startsWith("ffprobe version"), version.includes("--enable-nonfree") ? "Use a GPL/LGPL build without nonfree components" : version.split("\n")[0]);
    const encoders = await mediaCommand(tools.ffmpeg, ["-encoders"], { timeout: 5000 });
    const filters = await mediaCommand(tools.ffmpeg, ["-filters"], { timeout: 5000 });
    check("captionRenderer", /\bass\s/.test(filters), "Requires libass captions; on macOS install ffmpeg-full");
    check("mediaCodecs", ["libx264", "aac", "libmp3lame", "png"].every((name) => encoders.includes(name)), "Requires H.264, AAC, MP3 and PNG encoders");
  } else check("mediaTools", process.env.VERCEL === "1", process.env.VERCEL === "1" ? `Pinned FFmpeg ${MEDIA_TOOLS_RELEASE.version} downloads on first media operation` : "Install FFmpeg or run npm run media:setup on Linux x64");
} catch { check("mediaTools", false, "Media tools unavailable; check FFMPEG_PATH and FFPROBE_PATH"); }
if (live) {
  const keys = ["AUTH_SECRET", "ADMIN_INVITE_CODES", "OPENAI_API_KEY", "FAL_KEY", "ELEVENLABS_API_KEY", "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", ...(process.env.NEWS_DIGEST_V2_ENABLED === "false" ? [] : ["PRIVATE_BLOB_READ_WRITE_TOKEN"])];
  for (const key of keys) check(key, Boolean(process.env[key]?.trim()), "Required in live mode");
  for (const key of ["DAILY_BUDGET_CAP_USD_GLOBAL", "DAILY_BUDGET_CAP_USD_PER_USER"]) check(key, Number.isFinite(Number(process.env[key])) && Number(process.env[key]) > 0, "Set a positive USD limit");
  check("providerEnablement", process.env.PROVIDER_CALLS_ENABLED === "true", "Live calls remain paused until PROVIDER_CALLS_ENABLED=true");
} else check("mockEnablement", process.env.PROVIDER_CALLS_ENABLED !== "false", "Mock operations accept an empty provider enablement setting");
if (process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    const { rows } = await client.query("select to_regclass('public.action_requests') as requests, to_regclass('public.provider_reservations') as reservations, to_regclass('public.upload_authorizations') as uploads, to_regclass('public.login_attempts') as logins");
    check("databaseSchema", Object.values(rows[0]).every(Boolean), "Run npm run db:migrate on your own database if tables are missing");
  } catch { check("databaseSchema", false, "Database unavailable or schema initialization required"); }
  finally { await client.end().catch(() => {}); }
}
const result = { ready: checks.every((item) => item.ok), mode: live ? "live" : "mock", readOnly: true, paidCalls: 0, checks };
if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
else for (const item of checks) console.log(`${item.ok ? "OK" : "MISSING"} ${item.name}: ${item.detail}`);
process.exitCode = result.ready ? 0 : 1;
