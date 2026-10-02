/**
 * Root-relative URL prefix for media served from `public/dev-blob` during local
 * development, when Vercel Blob is not configured. Local-dev media URLs look like
 * `/dev-blob/videos/<id>/shot-01.mp4`.
 *
 * Lives in this dependency-free module so it can be the single source of truth for
 * both client-safe code (`schemas.ts`) and server-only modules (`blob.ts`,
 * `render.ts`, `seedance.ts`) without pulling server-only deps into client code.
 *
 * The trailing slash is part of the prefix — match with
 * `url.startsWith(DEV_BLOB_URL_PREFIX)` and strip with `url.slice(DEV_BLOB_URL_PREFIX.length)`.
 */
export const DEV_BLOB_URL_PREFIX = "/dev-blob/";
