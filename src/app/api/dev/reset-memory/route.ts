import { NextResponse } from "next/server";

import { resetInMemoryStoreForDev } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Memory reset is only available in development." }, { status: 404 });
  }
  return NextResponse.json(resetInMemoryStoreForDev());
}
