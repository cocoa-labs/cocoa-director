import { authorizeVideoRequest } from "@/lib/server/videos";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const { job } = auth;
  const sources = await getStore().listProductionSources(job.projectId);
  const manifest = {
    version: 1,
    productionId: job.id,
    asOf: job.sourceBundle?.asOf,
    sources: sources.map((source) => ({
      ...source,
      blobUrl: undefined,
      downloadPath: source.kind === "document" ? `/api/projects/${job.projectId}/sources/${source.id}/download` : undefined,
    })),
    claims: job.sourceBundle?.claims ?? [],
    sceneCitations: job.storyboard?.scenes.map((scene) => ({ sceneId: scene.id, sourceIds: scene.sourceIds, labels: scene.citationLabels })) ?? [],
  };
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  if (format === "text") {
    const body = [
      "Cocoa Director source manifest",
      `Production: ${job.id}`,
      `As of: ${manifest.asOf ?? "not supplied"}`,
      "",
      ...manifest.sources.map((source, index) => `${index + 1}. ${source.title}${source.url ? `\n   ${source.url}` : ""}\n   Rights: ${source.rights}`),
    ].join("\n");
    return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="cocoa-${id}-sources.txt"`, "Cache-Control": "private, no-store" } });
  }
  return new Response(JSON.stringify(manifest, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="cocoa-${id}-sources.json"`, "Cache-Control": "private, no-store" } });
}
