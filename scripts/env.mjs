import nextEnv from "@next/env";
// Match the app's environment precedence; never print configuration values.
nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", { info() {}, error() {} });
