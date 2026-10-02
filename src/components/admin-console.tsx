"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import type { ProviderAuditEvent } from "@/lib/schemas";

export function AdminConsole({ initialEvents }: { initialEvents: ProviderAuditEvent[] }) {
  const [events, setEvents] = useState<ProviderAuditEvent[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/provider-audit");
      if (!response.ok) throw new Error("Provider audit could not be loaded.");
      const result = await response.json() as { events: ProviderAuditEvent[] };
      setEvents(result.events); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Audit unavailable."); }
  }, []);
  return <main className="admin-shell">
    <header className="admin-header"><div><p className="eyebrow">Your installation</p><h1>Provider audit</h1></div><Link href="/">Studio</Link><button type="button" onClick={refresh}>Refresh</button></header>
    {error ? <p role="alert">{error}</p> : null}
    <section className="admin-panel"><div className="admin-table">{events.map((event) => <article className="admin-row audit" key={event.id}>
      <div><strong>{event.status}</strong><span>{event.userId} · {event.provider} · {event.model}</span></div>
      <span className="admin-pill">${(Math.max(event.actualCostCents, event.estimatedCostCents) / 100).toFixed(2)}</span><time>{new Date(event.createdAt).toLocaleString()}</time>
    </article>)}{events.length === 0 ? <p>No provider audit events yet.</p> : null}</div></section>
  </main>;
}
