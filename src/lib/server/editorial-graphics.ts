import { createCanvas } from "@napi-rs/canvas";

import type { SourceVisualArtifact } from "@/lib/schemas";
import { ensureRenderFonts } from "@/lib/server/render-fonts";

/** Measure actual glyph widths; character counts clip wide words and long titles. */
export function fitEditorialText(value: string, width: number, fontSize: number, maxLines: number, weight = 400) {
  ensureRenderFonts();
  const context = createCanvas(1, 1).getContext("2d");
  context.font = `${weight} ${fontSize}px Arial`;
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (context.measureText(`${line} ${word}`.trim()).width <= width) {
      line = `${line} ${word}`.trim();
    } else {
      if (line) lines.push(line);
      line = "";
      for (const character of word) {
        if (context.measureText(line + character).width > width && line) { lines.push(line); line = ""; }
        line += character;
      }
    }
  }
  if (line) lines.push(line);
  const truncated = lines.length > maxLines;
  const fitted = lines.slice(0, maxLines);
  if (truncated) {
    let last = fitted[maxLines - 1];
    while (last && context.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    fitted[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return { lines: fitted, fontSize, truncated };
}

export function editorialTextSvg(text: ReturnType<typeof fitEditorialText>, x: number, y: number, fill: string, weight = 400, leading = 1.25) {
  return text.lines.map((line, index) => `<text x="${x}" y="${y + index * text.fontSize * leading}" font-family="Arial" font-size="${text.fontSize}" font-weight="${weight}" fill="${escapeXml(fill)}">${escapeXml(line)}</text>`).join("");
}

export function sourceCardSvg(source: SourceVisualArtifact, title: string, width: number, height: number, palette: string[], metric?: { value: number; unit?: string; label: string }) {
  const portrait = height > width;
  const scale = Math.min(width, height);
  const { background, surface: secondary } = editorialSurfaceColors(palette);
  const accent = safeColor(palette[2], "#75eaa5");
  const x = width * .1;
  const textWidth = width * .8;
  const heading = fitEditorialText(title, textWidth, scale * .068, 2, 700);
  const quote = fitEditorialText(source.excerpt, textWidth - scale * .045, scale * (metric ? .032 : .043), metric ? 2 : portrait ? 8 : 5);
  const metricText = metric ? fitEditorialText(`${metric.value.toLocaleString("en-US")} ${metric.unit ?? ""}`, textWidth, scale * .10, 1, 700) : undefined;
  const metricLabel = metric ? fitEditorialText(metric.label, textWidth - scale * .045, scale * .027, 1) : undefined;
  const publisher = fitEditorialText(source.domain ?? "SUPPLIED SOURCE", textWidth, scale * .023, 1, 700);
  const sourceTitle = fitEditorialText(source.title, textWidth, scale * .024, 1);
  const locator = fitEditorialText(source.locator === source.title ? "" : source.locator, textWidth, scale * .021, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="source-bg" x2="1" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="${secondary}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#source-bg)"/>
    <ellipse cx="${width * .9}" cy="${height * .1}" rx="${width * .5}" ry="${height * .7}" fill="${accent}" opacity=".025"/>
    <path d="M ${x} ${height * .16} H ${width * .9}" stroke="${accent}" stroke-opacity=".35"/>
    ${editorialTextSvg(publisher, x, height * .12, accent, 700)}
    ${editorialTextSvg(heading, x, height * .27, "#f4f7f5", 700, 1.12)}
    <rect x="${x}" y="${height * .42}" width="${scale * .004}" height="${height * .27}" fill="${accent}" opacity=".8"/>
    ${metricText ? editorialTextSvg(metricText, x + scale * .045, height * .51, accent, 700) : ""}
    ${metricLabel ? editorialTextSvg(metricLabel, x + scale * .045, height * .565, "#f4f7f5") : ""}
    ${editorialTextSvg(quote, x + scale * .045, height * (metric ? .62 : .45), "#d9e3dd")}
    <path d="M ${x} ${height * .745} H ${width * .9}" stroke="#ffffff" stroke-opacity=".13"/>
    ${editorialTextSvg(sourceTitle, x, height * .79, "#b8c7c0")}
    ${editorialTextSvg(locator, x, height * .83, "#b8c7c0")}
  </svg>`;
}

/** Palette slot 1 is foreground text, not a second background color. */
export function editorialSurfaceColors(palette: string[]) {
  const background = safeColor(palette[0], "#07110e");
  const accent = safeColor(palette[2], "#75eaa5");
  const rgb = (hex: string) => {
    const value = hex.length === 4 ? hex.slice(1).split("").map((digit) => digit + digit).join("") : hex.slice(1);
    return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
  };
  const base = rgb(background);
  const tint = rgb(accent);
  const surface = `#${base.map((channel, index) => Math.round(channel * .86 + tint[index] * .14).toString(16).padStart(2, "0")).join("")}`;
  return { background, surface };
}

function safeColor(value: string | undefined, fallback: string) { return value && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : fallback; }
function escapeXml(value: string) { return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!); }
