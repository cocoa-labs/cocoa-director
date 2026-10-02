import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const options = process.argv.slice(2);
const mode = options.find((option) => option.startsWith("--mode="))?.slice(7) ?? "demo";
if (!["demo", "live"].includes(mode) || options.some((option) => !/^--mode=(demo|live)$/.test(option))) {
  console.error("Usage: npm run setup -- --mode=demo|live"); process.exitCode = 1;
} else {
  const destination = join(process.cwd(), ".env");
  let existing = false;
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"]) {
    try { await access(join(process.cwd(), file)); existing = true; } catch { /* Missing is normal. */ }
  }
  if (existing) console.log("Existing environment files preserved. Edit your own configuration to switch modes; see docs/setup.md.");
  else {
    let template = await readFile(new URL(mode === "live" ? "../.env.live.example" : "../.env.example", import.meta.url), "utf8");
    if (mode === "live") for (const key of ["AUTH_SECRET", "ADMIN_INVITE_CODES", "CRON_SECRET"]) template = template.replace(`${key}=\n`, `${key}=${randomBytes(32).toString("hex")}\n`);
    try { await writeFile(destination, template, { flag: "wx", mode: 0o600 }); console.log(`Created .env for ${mode} mode. Credentials remain in your local file; setup does not print or send them.`); }
    catch (error) { if (error.code !== "EEXIST") throw error; console.log("Existing .env preserved."); }
  }
  console.log("Next: npm run doctor, then npm run dev. Live mode also needs your keys, storage, database initialization, and explicit provider enablement.");
}
