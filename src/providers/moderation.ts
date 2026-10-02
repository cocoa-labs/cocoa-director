import { assertProvidersEnabled } from "@/lib/server/budget-ledger";
import { requireEnv } from "@/lib/server/config";
import type { ModerationProvider, ProviderContext } from "@/providers/types";

export class OpenAiModerationProvider implements ModerationProvider {
  async checkText(input: string, _stage: string, context?: Partial<ProviderContext>) {
    assertProvidersEnabled();
    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
        "x-trace-id": context?.traceId ?? "",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input }),
    });

    if (!response.ok) {
      throw new Error(`Moderation failed: ${response.status}`);
    }

    const json = (await response.json()) as {
      results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
    };
    const result = json.results?.[0];
    const categories = Object.entries(result?.categories ?? {})
      .filter(([, value]) => value)
      .map(([key]) => key);

    return { allowed: !result?.flagged, categories };
  }
}
