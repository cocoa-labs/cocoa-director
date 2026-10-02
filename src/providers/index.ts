import { assertLiveEnvironmentReady, getProviderMode } from "@/lib/server/config";
import { ElevenMusicProvider } from "@/providers/elevenmusic";
import { GptImageProvider } from "@/providers/gptimage";
import { MockImageProvider, MockModerationProvider, MockMusicProvider, MockVideoProvider } from "@/providers/mock";
import { OpenAiModerationProvider } from "@/providers/moderation";
import { SeedanceProvider } from "@/providers/seedance";
import type { ProviderSuite } from "@/providers/types";

let providers: ProviderSuite | null = null;

export function getProviders(): ProviderSuite {
  if (providers) return providers;

  if (getProviderMode() === "live") {
    assertLiveEnvironmentReady();
    providers = {
      images: new GptImageProvider(),
      music: new ElevenMusicProvider(),
      video: new SeedanceProvider(),
      moderation: new OpenAiModerationProvider(),
    };
  } else {
    providers = {
      images: new MockImageProvider(),
      music: new MockMusicProvider(),
      video: new MockVideoProvider(),
      moderation: new MockModerationProvider(),
    };
  }

  return providers;
}
