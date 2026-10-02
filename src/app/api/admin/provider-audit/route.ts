import { NextResponse } from "next/server";

import { requireAdminContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdminContext(request);
    const events = await getStore().listProviderAuditEvents(100);
    return NextResponse.json({ events });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Provider audit lookup failed" }, { status: 500 });
  }
}
