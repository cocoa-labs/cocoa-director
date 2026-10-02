import { NextResponse } from "next/server";

import { getMissingLiveEnvKeys, getProviderMode } from "@/lib/server/config";
import { checkDatabaseSchema, hasDatabase } from "@/lib/server/db";
import { getAuthReadiness } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET() {
  const live = getProviderMode() === "live";
  const operatorConfig = getOperatorConfigReadiness();
  const checks = {
    providerMode: getProviderMode(),
    missingLiveEnvKeys: live ? getMissingLiveEnvKeys() : [],
    auth: getAuthReadiness(),
    operatorConfig,
    database: {
      configured: hasDatabase(),
      schemaReady: false,
      error: undefined as string | undefined,
    },
    blob: {
      configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    },
    privateSourceBlob: {
      required: live && process.env.NEWS_DIGEST_V2_ENABLED !== "false",
      configured: Boolean(process.env.PRIVATE_BLOB_READ_WRITE_TOKEN),
    },
  };

  if (checks.database.configured) {
    try {
      await checkDatabaseSchema();
      checks.database.schemaReady = true;
    } catch {
      checks.database.error = "database_unavailable_or_migration_required";
    }
  }

  const ready =
    checks.missingLiveEnvKeys.length === 0 &&
    (!checks.auth.required || checks.auth.configured) &&
    (!live || checks.operatorConfig.configured) &&
    (checks.database.configured ? checks.database.schemaReady : !live) &&
    (!live || checks.blob.configured) &&
    (!checks.privateSourceBlob.required || checks.privateSourceBlob.configured);

  return NextResponse.json(
    {
      ready,
      checks,
      deployment: {
        commitSha: process.env.VERCEL_GIT_COMMIT_SHA,
        commitRef: process.env.VERCEL_GIT_COMMIT_REF,
        url: process.env.VERCEL_URL,
      },
    },
    { status: ready ? 200 : 503 },
  );
}

function getOperatorConfigReadiness() {
  const requiredKeys = [
    "PROVIDER_CALLS_ENABLED",
    "DAILY_BUDGET_CAP_USD_PER_USER",
    "DAILY_BUDGET_CAP_USD_GLOBAL",
  ];
  const missing = requiredKeys.filter((key) => key === "PROVIDER_CALLS_ENABLED"
    ? !["true", "false"].includes(process.env[key] ?? "")
    : !Number.isFinite(Number(process.env[key])) || Number(process.env[key]) <= 0);
  return {
    configured: missing.length === 0,
    providerCallsEnabled: process.env.PROVIDER_CALLS_ENABLED === "true",
    missing,
  };
}
