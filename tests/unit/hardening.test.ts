import { beforeEach } from "vitest";
import { resetInMemoryStoreForDev } from "@/lib/server/store";
import { hardeningContract } from "../helpers/hardening-contract";
beforeEach(() => {
  delete process.env.DATABASE_URL;
  process.env.PROVIDER_MODE = "mock";
  process.env.DISABLE_BETA_AUTH = "true";
  process.env.PROVIDER_CALLS_ENABLED = "true";
  process.env.DAILY_BUDGET_CAP_USD_GLOBAL = "50";
  resetInMemoryStoreForDev();
});
hardeningContract();
