import { cookies } from "next/headers";

import { StudioLogin } from "@/components/studio-login";
import { StudioDashboard } from "@/components/studio-dashboard";
import { STUDIO_SESSION_COOKIE, getSessionFromToken, isAuthRequired } from "@/lib/server/auth";
import { getProviderMode, isNewsWebResearchEnabled, isProductionProgressV2Enabled } from "@/lib/server/config";

export default async function Home() {
  // Read request state before environment-dependent branches so build-time settings cannot freeze the login UI.
  const cookieStore = await cookies();
  const authRequired = isAuthRequired();
  if (authRequired) {
    const session = await getSessionFromToken(cookieStore.get(STUDIO_SESSION_COOKIE)?.value);
    if (!session) return <StudioLogin />;
  }

  return (
    <StudioDashboard
      authRequired={authRequired}
      demoMode={getProviderMode() === "mock"}
      capabilities={{ newsWebResearch: isNewsWebResearchEnabled(), productionProgressV2: isProductionProgressV2Enabled() }}
    />
  );
}
