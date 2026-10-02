"use client";

import { Loader2, Sparkles, Upload, UserRound, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { LibraryAsset } from "@/lib/schemas";
import { CONSENT_STATEMENT, type SeedRole } from "@/lib/seeds-payload";

const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/webp";

const ROLE_COPY: Record<SeedRole, { eyebrow: string; title: string; blurb: string; hint: string }> = {
  you: {
    eyebrow: "Cast yourself",
    title: "Add yourself",
    blurb:
      "We'll restyle you to match the video's art direction — a recognizable, stylized version of you, not a photo-real clone. Your photo's background and lighting won't carry over, only you do.",
    hint: "Upload 2–5 clear photos of your face and upper body.",
  },
  style: {
    eyebrow: "Seed the look",
    title: "Style reference",
    blurb: "We'll borrow the color grade, lensing, and mood from this image to steer the video's style — not copy it exactly.",
    hint: "Upload one image whose look you want.",
  },
  environment: {
    eyebrow: "Seed the world",
    title: "Environment reference",
    blurb: "We'll derive the setting, palette, and motifs from this image to drive the world of the video — not copy it exactly.",
    hint: "Upload one image of the place or vibe.",
  },
  palette: {
    eyebrow: "Seed the palette",
    title: "Palette reference",
    blurb: "We'll sample the colors, materials, and textures from this image to drive the palette — not copy it exactly.",
    hint: "Upload one image whose colors you want.",
  },
};

export function YouAnchorCard({ photos, onOpen }: { photos: LibraryAsset[]; onOpen: () => void }) {
  const cover = photos[0];
  return (
    <button
      type="button"
      className={`anchor-thumb seed-anchor-thumb ${cover ? "" : "is-empty"}`}
      onClick={onOpen}
      title={cover ? "Manage your photos" : "Add yourself to the video"}
      aria-label={cover ? "Manage your photos" : "Add yourself to the video"}
    >
      {cover ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cover.url} alt="Your reference" className="aspect-[9/16] w-full object-cover" />
          {photos.length > 1 ? <span className="seed-count">{photos.length}</span> : null}
          <span className="seed-flag" aria-hidden>
            <Sparkles className="h-3 w-3" />
          </span>
          <div>YOU</div>
        </>
      ) : (
        <>
          <span>
            <UserRound className="h-4 w-4" aria-hidden />
          </span>
          <div>YOU</div>
        </>
      )}
    </button>
  );
}

// A seedable aesthetic tile (style / environment / palette). Shows the seeded image when
// present, otherwise an empty call-to-action that opens the drawer.
export function SeedTile({ role, label, seed, onOpen }: { role: SeedRole; label: string; seed?: LibraryAsset; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`anchor-thumb seed-anchor-thumb ${seed ? "" : "is-empty"}`}
      onClick={onOpen}
      title={seed ? `Replace the ${role} reference` : `Seed ${role} from an image`}
      aria-label={seed ? `Replace the ${role} reference` : `Seed ${role} from an image`}
    >
      {seed ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={seed.url} alt={`${role} reference`} className="aspect-[9/16] w-full object-cover" />
          <span className="seed-flag" aria-hidden>
            <Upload className="h-3 w-3" />
          </span>
          <div>{label}</div>
        </>
      ) : (
        <>
          <span>
            <Upload className="h-4 w-4" aria-hidden />
          </span>
          <div>{label}</div>
        </>
      )}
    </button>
  );
}

export function SeedDrawer({
  role,
  photos,
  consentAccepted,
  busy,
  error,
  onConsentChange,
  onUpload,
  onRemove,
  onClose,
}: {
  role: SeedRole;
  photos: LibraryAsset[];
  consentAccepted: boolean;
  busy: boolean;
  error: string | null;
  onConsentChange: (next: boolean) => void;
  onUpload: (files: File[]) => void;
  onRemove: (assetId: string) => void;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = "seed-drawer-title";
  const copy = ROLE_COPY[role];
  const multiple = role === "you";
  const consentRequired = role === "you";
  const uploadsLocked = (consentRequired && !consentAccepted) || busy;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    onUpload(Array.from(fileList).slice(0, multiple ? 5 : 1));
  };

  return (
    <div
      ref={backdropRef}
      className="music-studio-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === backdropRef.current) onClose();
      }}
    >
      <div ref={panelRef} className="music-studio-drawer seed-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="music-studio-head">
          <div>
            <span className="field-label">{copy.eyebrow}</span>
            <h2 id={titleId}>{copy.title}</h2>
          </div>
          <button type="button" className="icon-only" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <p className="seed-blurb">{copy.blurb}</p>
        <p className="seed-hint">{copy.hint}</p>

        {consentRequired ? (
          <label className="seed-consent">
            <input type="checkbox" checked={consentAccepted} onChange={(event) => onConsentChange(event.target.checked)} />
            <span>{CONSENT_STATEMENT}</span>
          </label>
        ) : null}

        {photos.length > 0 ? (
          <div className="seed-photo-strip">
            {photos.map((photo) => (
              <div key={photo.id} className="seed-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt="Seed reference" className="aspect-square w-full object-cover" />
                <button type="button" className="seed-photo-remove" onClick={() => onRemove(photo.id)} aria-label="Remove image">
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <label className={`upload-button seed-upload ${uploadsLocked ? "is-locked" : ""}`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
          <span>{photos.length > 0 ? (multiple ? "Add more photos" : "Replace image") : multiple ? "Add photos" : "Upload image"}</span>
          <input
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            multiple={multiple}
            disabled={uploadsLocked}
            className="sr-only"
            onChange={(event) => {
              handleFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>

        {consentRequired && !consentAccepted ? <p className="seed-note">Accept the consent statement to upload.</p> : null}
        {error ? <p className="seed-error">{error}</p> : null}
      </div>
    </div>
  );
}
