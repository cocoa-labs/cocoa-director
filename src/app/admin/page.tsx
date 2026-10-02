import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { getStore } from "@/lib/server/store";
import { AdminConsole } from "@/components/admin-console";
import { STUDIO_SESSION_COOKIE, getSessionFromToken } from "@/lib/server/auth";

export default async function AdminPage() {
  const cookieStore = await cookies();
  const session = await getSessionFromToken(cookieStore.get(STUDIO_SESSION_COOKIE)?.value);
  if (!session?.admin) notFound();
  return <AdminConsole initialEvents={await getStore().listProviderAuditEvents(100)} />;
}
