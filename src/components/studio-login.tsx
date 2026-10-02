"use client";
import { Clapperboard, Loader2, LockKeyhole } from "lucide-react";
import { type FormEvent, useState } from "react";

export function StudioLogin() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Login failed.");
      window.location.reload();
    } catch (error) { setError(error instanceof Error ? error.message : "Login failed."); }
    finally { setBusy(false); }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-lg rounded-2xl border border-line bg-panel p-8">
        <div className="mb-8 flex items-center gap-4"><Clapperboard aria-hidden className="h-10 w-10 text-accent" /><h1 className="text-2xl font-semibold">Cocoa Director</h1></div>
        <h2 className="mb-3 text-lg font-semibold">Open your studio</h2>
        <p className="mb-6 text-muted">Enter the access code configured by the operator of this installation. Running your own copy? Set ADMIN_INVITE_CODES and AUTH_SECRET on your server.</p>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label htmlFor="access-code">Studio access code</label>
          <input id="access-code" className="rounded-lg border border-line bg-background p-3" type="password" autoComplete="current-password" value={code} onChange={(event) => setCode(event.target.value)} maxLength={256} required />
          {error ? <p role="alert" className="text-red-400">{error}</p> : null}
          <button className="primary-command" type="submit" disabled={busy || !code.trim()}>{busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <LockKeyhole aria-hidden className="h-4 w-4" />} Enter studio</button>
        </form>
      </section>
    </main>
  );
}
