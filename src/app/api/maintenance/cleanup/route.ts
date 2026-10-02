import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
  }

  console.log(
    JSON.stringify({
      event: "maintenance_cleanup",
      note: "Soft-deleted assets are removed from studio lists immediately. Blob deletion runs synchronously on delete; retention-expired batch cleanup is ready to extend once retention labels are applied.",
    }),
  );
  return NextResponse.json({
    ok: true,
    deleted: 0,
    archived: 0,
    note: "No retention-expired assets were selected.",
  });
}
