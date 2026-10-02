"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Flame, Gauge, Mic2, Music2, SlidersHorizontal, X } from "lucide-react";

import type {
  MusicControls,
  MusicIntensityControl,
  MusicTempoControl,
  MusicVocalControl,
} from "@/lib/schemas";
import {
  GENRE_GROUPS,
  GENRE_PRESETS,
  GENRE_PRESETS_BY_ID,
  genrePresetsForGroup,
} from "@/lib/music-controls";

// Mixing-desk / console Music Studio. One reusable channel strip (MusicConsole) mounts three ways:
// the always-on compact card in Create, the immersive drawer, and inline in the Audio Lab workspace.

const VOCAL_OPTIONS: Array<{ id: MusicVocalControl; label: string; detail: string }> = [
  { id: "auto", label: "Auto", detail: "AI picks" },
  { id: "instrumental", label: "Instrumental", detail: "No vocals" },
  { id: "male", label: "Male", detail: "Lead" },
  { id: "female", label: "Female", detail: "Lead" },
  { id: "mixed", label: "Mixed", detail: "Duet" },
  { id: "choir", label: "Choir", detail: "Ensemble" },
];

const TEMPO_OPTIONS: Array<{ id: MusicTempoControl; label: string; detail: string }> = [
  { id: "auto", label: "Auto", detail: "AI picks" },
  { id: "slow", label: "Slow", detail: "Laid-back" },
  { id: "mid", label: "Mid", detail: "Steady" },
  { id: "fast", label: "Fast", detail: "Driving" },
];

const INTENSITY_OPTIONS: Array<{ id: MusicIntensityControl; label: string; detail: string }> = [
  { id: "auto", label: "Auto", detail: "AI picks" },
  { id: "low", label: "Low", detail: "Gentle" },
  { id: "medium", label: "Medium", detail: "Balanced" },
  { id: "high", label: "High", detail: "Intense" },
];

// Ordered ladders for the LED-meter faders (index 0 = "auto", lights nothing).
const TEMPO_LADDER: MusicTempoControl[] = ["auto", "slow", "mid", "fast"];
const INTENSITY_LADDER: MusicIntensityControl[] = ["auto", "low", "medium", "high"];
// One strong pick per group for the compact card; the drawer shows all 31.
const COMPACT_GENRE_IDS: string[] = ["rock", "trap", "house", "orchestral"];

export function isAllAuto(value: MusicControls): boolean {
  return (
    (!value.genre || value.genre === "auto") &&
    value.vocals === "auto" &&
    value.tempo === "auto" &&
    !value.bpm &&
    value.intensity === "auto"
  );
}

function titleCase(value: string) {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value;
}

function recipeTokens(value: MusicControls): { mono: string; flag: string } {
  if (isAllAuto(value)) return { mono: "Auto · the director chooses everything", flag: "" };
  const parts: string[] = [];
  if (value.genre && value.genre !== "auto") {
    parts.push(GENRE_PRESETS_BY_ID[value.genre]?.label ?? value.genre);
  }
  if (value.vocals !== "auto") parts.push(titleCase(value.vocals));
  if (value.tempo !== "auto") parts.push(titleCase(value.tempo));
  if (value.intensity !== "auto") parts.push(titleCase(value.intensity));
  const flag = value.vocals === "instrumental" ? "INSTR" : value.vocals === "auto" ? "" : "VOX";
  return { mono: `⟶ ${parts.join(" · ")}`, flag };
}

function EqBars() {
  return (
    <span className="eq-bars" aria-hidden>
      {[0, 0.18, 0.36, 0.12, 0.5].map((delay, index) => (
        <span key={index} style={{ animationDelay: `${delay}s` }} />
      ))}
    </span>
  );
}

function GenreKey({ label, detail, lit, onClick, ariaLabel }: {
  label: string;
  detail?: string;
  lit: boolean;
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={lit}
      aria-label={ariaLabel}
      className={`console-key ${lit ? "is-lit" : ""}`}
    >
      <span>{label}</span>
      {detail ? <small>{detail}</small> : null}
    </button>
  );
}

function Fader<T extends string>({ label, icon, ladder, options, value, onSelect }: {
  label: string;
  icon: ReactNode;
  ladder: T[];
  options: Array<{ id: T; label: string; detail: string }>;
  value: T;
  onSelect: (id: T) => void;
}) {
  const activeIdx = Math.max(0, ladder.indexOf(value));
  return (
    <div className="console-fader" role="group" aria-label={label}>
      <span className="field-label inline-flex items-center gap-2">
        {icon}
        {label}
      </span>
      <div className="console-fader-track">
        {ladder.map((level, index) => {
          const option = options.find((entry) => entry.id === level);
          const on = index <= activeIdx && activeIdx > 0;
          const peak = index === activeIdx && activeIdx > 0;
          return (
            <button
              key={level}
              type="button"
              onClick={() => onSelect(level)}
              aria-pressed={value === level}
              title={option ? `${option.label} — ${option.detail}` : level}
              className={`console-fader-cell ${on ? "is-on" : ""} ${peak ? "is-peak" : ""}`}
            >
              {option?.label ?? level}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export type MusicConsoleProps = {
  value: MusicControls;
  onChange: (next: MusicControls) => void;
  density?: "compact" | "full";
  onBrowseAll?: () => void;
  headerAction?: ReactNode;
};

export function MusicConsole({ value, onChange, density = "compact", onBrowseAll, headerAction }: MusicConsoleProps) {
  const set = (patch: Partial<MusicControls>) => onChange({ ...value, ...patch });
  const activeGenre = value.genre && value.genre !== "auto" ? value.genre : undefined;
  const recipe = recipeTokens(value);
  const toggleGenre = (id: string) => set({ genre: activeGenre === id ? undefined : id });

  return (
    <div className="studio-channel">
      <div className="studio-channel-head">
        <span className="studio-channel-tab">
          <Music2 className="h-3.5 w-3.5" aria-hidden />
          CH · MUSIC
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <EqBars />
          {headerAction}
        </div>
      </div>

      <div className="recipe-readout" aria-live="polite">
        <span className="recipe-mono">{recipe.mono}</span>
        {recipe.flag ? <span className="recipe-flag">{recipe.flag}</span> : null}
      </div>

      {density === "full" ? (
        <div className="console-genre-browser">
          <GenreKey label="Auto" detail="AI picks" lit={!activeGenre} onClick={() => set({ genre: undefined })} />
          {GENRE_GROUPS.map((group) => (
            <div key={group.id} className="console-genre-group">
              <div className="console-genre-group-label">{group.label}</div>
              <div className="console-key-grid is-genres">
                {genrePresetsForGroup(group.id).map((preset) => (
                  <GenreKey
                    key={preset.id}
                    label={preset.label}
                    lit={activeGenre === preset.id}
                    onClick={() => toggleGenre(preset.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="console-section">
          <span className="field-label">Genre</span>
          <div className="console-key-grid is-genres">
            <GenreKey label="Auto" detail="AI picks" lit={!activeGenre} onClick={() => set({ genre: undefined })} />
            {COMPACT_GENRE_IDS.map((id) => (
              <GenreKey
                key={id}
                label={GENRE_PRESETS_BY_ID[id]?.label ?? id}
                lit={activeGenre === id}
                onClick={() => toggleGenre(id)}
              />
            ))}
            {activeGenre && !COMPACT_GENRE_IDS.includes(activeGenre) ? (
              <GenreKey
                label={GENRE_PRESETS_BY_ID[activeGenre]?.label ?? activeGenre}
                detail="active"
                lit
                onClick={() => set({ genre: undefined })}
              />
            ) : null}
            <GenreKey
              label="Browse all"
              detail={`+${GENRE_PRESETS.length - COMPACT_GENRE_IDS.length} more`}
              lit={false}
              onClick={() => onBrowseAll?.()}
              ariaLabel="Browse all genres in the full studio"
            />
          </div>
        </div>
      )}

      <div className="console-section">
        <span className="field-label inline-flex items-center gap-2">
          <Mic2 className="h-4 w-4" aria-hidden />
          Vocals
        </span>
        <div className="console-key-grid is-3">
          {VOCAL_OPTIONS.map((option) => (
            <GenreKey
              key={option.id}
              label={option.label}
              detail={option.detail}
              lit={value.vocals === option.id}
              onClick={() => set({ vocals: option.id })}
            />
          ))}
        </div>
      </div>

      <Fader
        label="Tempo"
        icon={<Gauge className="h-4 w-4" aria-hidden />}
        ladder={TEMPO_LADDER}
        options={TEMPO_OPTIONS}
        value={value.tempo}
        onSelect={(tempo) => set({ tempo })}
      />

      <Fader
        label="Intensity"
        icon={<Flame className="h-4 w-4" aria-hidden />}
        ladder={INTENSITY_LADDER}
        options={INTENSITY_OPTIONS}
        value={value.intensity}
        onSelect={(intensity) => set({ intensity })}
      />
    </div>
  );
}

export function MusicStudioCard({ value, onChange, onOpenFull }: {
  value: MusicControls;
  onChange: (next: MusicControls) => void;
  onOpenFull: () => void;
}) {
  return (
    <MusicConsole
      value={value}
      onChange={onChange}
      density="compact"
      onBrowseAll={onOpenFull}
      headerAction={
        <button type="button" className="console-head-action" onClick={onOpenFull}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          <span>Full studio</span>
        </button>
      }
    />
  );
}

export function MusicStudioDrawer({ value, onChange, onClose, audition }: {
  value: MusicControls;
  onChange: (next: MusicControls) => void;
  onClose: () => void;
  audition?: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = "music-studio-title";

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

  return (
    <div
      ref={backdropRef}
      className="music-studio-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === backdropRef.current) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="music-studio-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="music-studio-head">
          <div>
            <span className="field-label">Music Studio</span>
            <h2 id={titleId}>The console</h2>
          </div>
          <button type="button" className="icon-only" onClick={onClose} aria-label="Close music studio">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <MusicConsole value={value} onChange={onChange} density="full" />

        {audition ? <div className="music-studio-audition">{audition}</div> : null}
      </div>
    </div>
  );
}
