import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@napi-rs/canvas",
    "pdfjs-dist",
    "sharp",
  ],
  // PDF.js loads its worker dynamically, so static tracing cannot discover it.
  outputFileTracingIncludes: {
    "/api/**": ["./src/lib/server/media-tools.ts", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "./node_modules/pdfjs-dist/standard_fonts/**"],
    "/.well-known/workflow/**": ["./src/lib/server/media-tools.ts", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "./node_modules/pdfjs-dist/standard_fonts/**"],
  },
};

export default withWorkflow(nextConfig);
