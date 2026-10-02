import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

import { sourceBodyText } from "@/lib/source-content";

/** Parse inert HTML. Scripts and subresources are never executed or fetched. */
export function extractArticle(html: string, sourceUrl = "https://source.invalid/") {
  const { document } = parseHTML(html);
  const meta = (name: string) => document.querySelector(`meta[name="${name}"],meta[property="${name}"]`)?.getAttribute("content")?.trim();
  const title = meta("citation_title") || meta("og:title") || document.querySelector("title")?.textContent?.trim();
  const date = meta("article:published_time") || meta("citation_publication_date") || meta("datePublished") || meta("date")
    || /"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1];
  const publishedAt = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : undefined;
  const canonicalUrl = httpUrl(document.querySelector('link[rel="canonical"]')?.getAttribute("href"), sourceUrl) ?? sourceUrl;
  const fullTextUrls: string[] = [];
  const url = new URL(sourceUrl);
  const arxiv = /^(?:www\.|export\.)?arxiv\.org$/i.test(url.hostname);
  const paperId = arxiv ? /^\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\/?$/i.exec(url.pathname)?.[1] : undefined;
  if (paperId) {
    const htmlLink = [...document.querySelectorAll('a[href]')].map((link) => httpUrl(link.getAttribute("href"), sourceUrl))
      .find((link) => link && new URL(link).hostname === url.hostname && new URL(link).pathname.startsWith(`/html/${paperId.replace(/v\d+$/, "")}`));
    fullTextUrls.push(htmlLink ?? `https://arxiv.org/html/${paperId}`);
    fullTextUrls.push(httpUrl(meta("citation_pdf_url"), sourceUrl) ?? `https://arxiv.org/pdf/${paperId}`);
  } else {
    const pdf = httpUrl(meta("citation_pdf_url") || document.querySelector('link[type="application/pdf"][rel="alternate"]')?.getAttribute("href"), sourceUrl);
    // Full HTML articles need no PDF detour. Follow publisher-declared full text
    // only for an abstract/landing page, never arbitrary links in the article.
    if (pdf && !document.querySelector("article section, .ltx_section, [itemprop='articleBody'], .article-body")) fullTextUrls.push(pdf);
  }

  document.querySelectorAll("script,style,noscript,svg,canvas,template,nav,footer,aside,form,button,[hidden],[aria-hidden='true'],.ltx_authors,.ltx_bibliography,.ltx_acknowledgements,.authors,.dateline,.submission-history,.extra-services,.metatable,.download").forEach((node) => node.remove());
  const articles = [...document.querySelectorAll("article")].filter((node) => !node.parentElement?.closest("article"));
  let root = document.querySelector("[itemprop='articleBody'],.article-body") ?? (articles.length === 1 ? articles[0] : document.querySelector("main"));
  if (!root && articles.length > 1) root = document.body;
  if (!root) {
    const readable = new Readability(document.cloneNode(true) as unknown as Document, { charThreshold: 100, maxElemsToParse: 30_000 }).parse();
    if (readable?.content) root = parseHTML(`<html><body>${readable.content}</body></html>`).document.body;
  }
  root ??= document.body;
  root.querySelectorAll("header").forEach((node) => node.remove());
  const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  // Block boundaries matter for sections, evidence locators and sentence selection.
  root.querySelectorAll("p,div,section,h1,h2,h3,h4,h5,h6,li,blockquote,tr,br").forEach((node) => node.appendChild(document.createTextNode("\n")));
  const text = sourceBodyText(root.textContent ?? "").replace(/[\t\f\v ]+/g, " ").replace(/ *\n */g, "\n").trim();
  return { text, headings, title: title?.replace(/\s+/g, " ").slice(0, 200), publishedAt, canonicalUrl, fullTextUrls: [...new Set(fullTextUrls)].filter((link) => link !== sourceUrl) };
}

function httpUrl(value: string | null | undefined, base: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
