import { uploadCompletion } from "@/lib/server/upload-callback";
export const runtime = "nodejs";
export async function POST(request: Request) { return uploadCompletion(request, "sources"); }
