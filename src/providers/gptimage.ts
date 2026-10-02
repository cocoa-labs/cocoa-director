import { reserveProviderAttempt } from "@/lib/server/budget-ledger";
import { ApiRequestError } from "@/lib/server/api-error";
import { fingerprint } from "@/lib/server/action-request";
import { estimateMediaGenerationCost, cents } from "@/lib/cost";
import sharp from "sharp";

import type { AnchorAsset, AnchorProviderControls } from "@/lib/schemas";
import {
  getOpenAiImageModel,
  getOpenAiImageQuality,
  getOpenAiImageRetryAttempts,
  getOpenAiImageSize,
  getOpenAiImageTimeoutMs,
  requireEnv,
} from "@/lib/server/config";
import { base64ToBuffer, copyRemoteFileToBlob, fetchBlobUrl, uploadPublicBlob } from "@/lib/server/blob";
import type { AnchorReferenceInput, ImageProvider, ProviderContext, ProviderResult } from "@/providers/types";

export function buildGptImageRequest(
  role: AnchorAsset["role"],
  prompt: string,
  options: AnchorProviderControls = {},
) {
  return {
    model: options.model ?? getOpenAiImageModel(),
    prompt,
    size: options.size ?? getOpenAiImageSize(),
    quality: options.quality ?? getOpenAiImageQuality(),
    output_format: options.outputFormat ?? "png",
    moderation: "auto",
    n: options.variantCount ?? 1,
    user: `anchor:${role}`,
  };
}

export type EditReferenceFile = { bytes: Uint8Array; mimeType: string };

// Pure builder for the OpenAI image-EDITS (image-to-image) multipart body. Kept a pure
// function of its inputs so the request body stays byte-deterministic across the
// quality-ladder retries (idempotency keys depend on request determinism).
export function buildGptImageEditForm(
  role: AnchorAsset["role"],
  prompt: string,
  options: AnchorProviderControls = {},
  files: EditReferenceFile[] = [],
): FormData {
  const form = new FormData();
  form.set("model", options.model ?? getOpenAiImageModel());
  form.set("prompt", prompt);
  form.set("size", options.size ?? getOpenAiImageSize());
  form.set("quality", options.quality ?? getOpenAiImageQuality());
  form.set("output_format", options.outputFormat ?? "png");
  form.set("n", String(options.variantCount ?? 1));
  form.set("user", `anchor:${role}`);
  files.forEach((file, index) => {
    const ext = file.mimeType === "image/jpeg" ? "jpg" : file.mimeType === "image/webp" ? "webp" : "png";
    form.append("image[]", new Blob([toArrayBuffer(file.bytes)], { type: file.mimeType }), `reference-${index}.${ext}`);
  });
  return form;
}

// Copy into a fresh, exact-length ArrayBuffer so the bytes are a valid BlobPart
// regardless of the source view's backing buffer (pooled Buffer, offset view, etc.).
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

// Load the bytes for each seed reference once (reused across retries). Real seeds are
// http(s)/dev-blob URLs; `data:` URLs are decoded inline (fetchBlobUrl can't read them).
// Every seed is normalized for OpenAI before use (see normalizeSeedImage).
async function readReferenceBytes(image: { url: string; mimeType: string }): Promise<EditReferenceFile> {
  let raw: Buffer;
  if (image.url.length > 35_000_000) throw new ApiRequestError("Reference image is too large.", 413, "image_too_large");
  if (image.url.startsWith("data:")) {
    raw = Buffer.from(base64ToBuffer(image.url.split(",")[1] ?? ""));
  } else {
    const response = await fetchBlobUrl(image.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch seed reference image (${response.status})`);
    }
    raw = Buffer.from(await response.arrayBuffer());
  }
  if (raw.byteLength > 25 * 1024 * 1024) throw new ApiRequestError("Reference image is too large.", 413, "image_too_large");
  await sharp(raw, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
  return normalizeSeedImage(raw, image.mimeType);
}

// gpt-image-2 images/edits rejects small inputs ("invalid_image_file" — e.g. a 208x297 phone
// crop) and is picky about EXIF / odd encodings. Normalize every seed to a clean PNG: apply
// EXIF orientation, re-encode, and resize so the short side is ~1024 (upscale tiny photos,
// downscale huge ones), which OpenAI reliably accepts. If sharp can't read it, fall back to
// the original bytes so a still-valid image isn't blocked by the normalizer.
export async function normalizeSeedImage(raw: Buffer, fallbackMimeType: string): Promise<EditReferenceFile> {
  try {
    const png = await sharp(raw, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .resize(1024, 1024, { fit: "outside", withoutEnlargement: false })
      .png()
      .toBuffer();
    return { bytes: new Uint8Array(png), mimeType: "image/png" };
  } catch {
    return { bytes: new Uint8Array(raw), mimeType: fallbackMimeType };
  }
}

export class GptImageProvider implements ImageProvider {
  async generateAnchorAsset(
    role: AnchorAsset["role"],
    prompt: string,
    context: ProviderContext,
    options: AnchorProviderControls = {},
    references?: AnchorReferenceInput,
  ): Promise<ProviderResult<AnchorAsset>> {
    const started = Date.now();
    const outputFormat = options.outputFormat ?? "png";
    const qualityPlan = imageQualityPlan(options.quality ?? getOpenAiImageQuality());
    // Fetch the seed bytes ONCE (reused across retries) so the edit request body is
    // deterministic. Empty/absent references fall back to the text-to-image path.
    const referenceFiles = references?.images.length
      ? await Promise.all(references.images.map(readReferenceBytes))
      : null;
    let response: Response | null = null;
    let lastError: Error | null = null;

    let attemptNumber = 0;
    for (const quality of qualityPlan) {
      try {
        response = await fetchWithRetry(async () => {
          await reserveProviderAttempt({ scope: "openai:image", videoId: context.videoId,
            key: `${context.idempotencyKey}:${quality}:${++attemptNumber}`,
            costCents: cents(estimateMediaGenerationCost({ kind: "image", controls: { ...options, size: options.size ?? getOpenAiImageSize(), quality, referenceCount: referenceFiles?.length ?? 0 } })) });
          return referenceFiles
            ? fetch("https://api.openai.com/v1/images/edits", {
                method: "POST",
                headers: {
                  // No Content-Type: fetch sets the multipart/form-data boundary itself.
                  Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
                  "x-trace-id": context.traceId,
                },
                signal: AbortSignal.timeout(getOpenAiImageTimeoutMs()),
                body: buildGptImageEditForm(role, prompt, { ...options, quality }, referenceFiles),
              })
            : fetch("https://api.openai.com/v1/images/generations", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
                  "Content-Type": "application/json",
                  "x-trace-id": context.traceId,
                },
                signal: AbortSignal.timeout(getOpenAiImageTimeoutMs()),
                body: JSON.stringify(buildGptImageRequest(role, prompt, { ...options, quality })),
              });
        });
        break;
      } catch (error) {
        if (error instanceof ApiRequestError) throw error;
        lastError = error instanceof Error ? error : new Error("Image provider request failed");
        console.error(
          JSON.stringify({
            event: "gptimage_attempt_failed",
            traceId: context.traceId,
            role,
            quality,
            model: getOpenAiImageModel(),
            message: lastError.message,
            name: lastError.name,
            cause: lastError.cause instanceof Error
              ? { message: lastError.cause.message, code: (lastError.cause as { code?: string }).code }
              : String(lastError.cause ?? ""),
          }),
        );
      }
    }

    if (!response) {
      const cause = lastError?.cause;
      const detail = cause instanceof Error
        ? ` (cause: ${cause.message}${(cause as { code?: string }).code ? `, code: ${(cause as { code?: string }).code}` : ""})`
        : cause ? ` (cause: ${String(cause)})` : "";
      throw new Error(`${lastError?.message ?? "Image provider request failed"}${detail}`);
    }

    const json = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
      usage?: { input_tokens_details?: { text_tokens?: number; image_tokens?: number }; output_tokens?: number };
    };
    const first = json.data?.[0];
    if (!first?.b64_json && !first?.url) {
      throw new Error(`${getOpenAiImageModel()} did not return image data`);
    }

    const extension = imageExtension(outputFormat);
    const contentType = imageContentType(outputFormat);
    const pathname = context.outputPathPrefix
      ? `${context.outputPathPrefix}/image.${extension}`
      : `videos/${context.videoId}/anchors/${role}-${fingerprint(context.idempotencyKey).slice(0, 20)}.${extension}`;
    const blob = first.b64_json
      ? await uploadPublicBlob({
          pathname,
          body: base64ToBuffer(first.b64_json),
          contentType,
          immutable: true,
        })
      : await copyRemoteFileToBlob({
          url: first.url!,
          pathname,
          contentType,
          immutable: true,
        });

    return {
      data: {
        role,
        url: blob.url,
        promptUsed: prompt,
        c2paClaim: `openai-c2pa-${context.idempotencyKey}`,
      },
      requestId: response.headers.get("x-request-id") ?? `openai-${context.idempotencyKey}`,
      latencyMs: Date.now() - started,
      costUsd: json.usage
        ? ((json.usage.input_tokens_details?.text_tokens ?? 0) * 5 + (json.usage.input_tokens_details?.image_tokens ?? 0) * 8 + (json.usage.output_tokens ?? 0) * 30) / 1_000_000
        : estimateMediaGenerationCost({ kind: "image", controls: { ...options, size: options.size ?? getOpenAiImageSize(), quality: options.quality ?? getOpenAiImageQuality(), referenceCount: referenceFiles?.length ?? 0 } }),
    };
  }
}

async function fetchWithRetry(
  makeRequest: () => Promise<Response>,
  options: { attempts?: number; baseDelayMs?: number } = {},
) {
  const attempts = options.attempts ?? getOpenAiImageRetryAttempts();
  const baseDelayMs = options.baseDelayMs ?? 1500;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await makeRequest();
      if (response.ok) return response;

      const message = await providerErrorMessage(response);
      if (!isRetryableStatus(response.status) || attempt === attempts) {
        throw new Error(message);
      }
      lastError = new Error(message);
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      lastError = normalizeFetchError(error);
      if (isTimeoutError(lastError)) throw lastError;
      if (attempt === attempts) throw lastError;
    }

    await sleep(baseDelayMs * attempt);
  }

  throw lastError ?? new Error("Image provider request failed");
}

function normalizeFetchError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new Error(`${getOpenAiImageModel()} request timed out after ${getOpenAiImageTimeoutMs()}ms`);
    }
    return error;
  }
  return new Error("Image provider request failed");
}

function isTimeoutError(error: Error) {
  return error.message.includes("request timed out");
}

function imageQualityPlan(configuredQuality: string): Array<NonNullable<AnchorProviderControls["quality"]>> {
  const safeQuality = isImageQuality(configuredQuality) ? configuredQuality : "high";
  const plan: Array<NonNullable<AnchorProviderControls["quality"]>> = [safeQuality];
  if (safeQuality === "high") plan.push("medium");
  if (safeQuality === "medium" || safeQuality === "high") plan.push("low");
  if (safeQuality === "auto") plan.push("medium");
  return [...new Set(plan)];
}

function isImageQuality(value: string): value is NonNullable<AnchorProviderControls["quality"]> {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}

function imageExtension(outputFormat: string) {
  return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

function imageContentType(outputFormat: string) {
  if (outputFormat === "jpeg") return "image/jpeg";
  if (outputFormat === "webp") return "image/webp";
  return "image/png";
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function providerErrorMessage(response: Response) {
  const model = getOpenAiImageModel();
  const requestId = response.headers.get("x-request-id");
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } };
      const detail = json.error?.message ?? json.error?.type ?? json.error?.code;
      return `${model} failed: ${response.status}${detail ? ` ${detail}` : ""}${requestId ? ` (${requestId})` : ""}`;
    } catch {
      return `${model} failed: ${response.status}${requestId ? ` (${requestId})` : ""}`;
    }
  }

  const title = body.match(/<title>(.*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  const summary = title ? `HTML error page: ${title}` : body.slice(0, 240).replace(/\s+/g, " ").trim();
  return `${model} failed: ${response.status} ${summary}${requestId ? ` (${requestId})` : ""}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
