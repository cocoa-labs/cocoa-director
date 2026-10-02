import { dirname, join } from "node:path";
import { convertSVGTextToPath, GlobalFonts } from "@napi-rs/canvas";

export const renderFontFiles = ["Regular", "Bold", "Italic", "BoldItalic"].map((style) => ({
  name: `LiberationSans-${style}.ttf`,
  path: join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts", `LiberationSans-${style}.ttf`),
}));
export const pdfStandardFontDirectory = `${dirname(renderFontFiles[0].path)}/`;
let registered = false;

export function ensureRenderFonts() {
  if (registered) return;
  for (const font of renderFontFiles) {
    if (!GlobalFonts.registerFromPath(font.path, "Arial")) throw new Error("Bundled render font could not be loaded.");
    GlobalFonts.registerFromPath(font.path, "Liberation Sans");
  }
  registered = true;
}

/** Outline text using bundled fonts; SVG rasterization then needs no host fonts. */
export function outlineEditorialText(svg: string) {
  ensureRenderFonts();
  return convertSVGTextToPath(svg);
}
