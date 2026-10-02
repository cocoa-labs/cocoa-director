"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";

export type CreateSectionId = "brief" | "sources" | "direction" | "review";
export type WorkbenchTabId = "pipeline" | "sources" | "anchors" | "shots" | "music" | "diagnostics";

type ConsoleTab<T extends string> = {
  id: T;
  label: string;
  badge?: string | number;
  disabled?: boolean;
};

function moveTabFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  if (buttons.length === 0) return;
  const currentIndex = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? buttons.length - 1
      : event.key === "ArrowRight"
        ? (currentIndex + 1) % buttons.length
        : (currentIndex - 1 + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[nextIndex]?.focus();
  buttons[nextIndex]?.click();
}

export function CreateSectionTabs({
  active,
  onChange,
  includeSources,
  sourceCount,
  reviewReady,
}: {
  active: CreateSectionId;
  onChange: (section: CreateSectionId) => void;
  includeSources: boolean;
  sourceCount: number;
  reviewReady: boolean;
}) {
  const tabs: ConsoleTab<CreateSectionId>[] = [
    { id: "brief", label: "Brief" },
    ...(includeSources ? [{ id: "sources" as const, label: "Sources", badge: sourceCount || undefined }] : []),
    { id: "direction", label: "Direction" },
    { id: "review", label: "Review", badge: reviewReady ? "Ready" : undefined },
  ];

  return (
    <div className="create-section-tabs" role="tablist" aria-label="Creation sections" onKeyDown={moveTabFocus}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`create-tab-${tab.id}`}
          aria-controls={`create-panel-${tab.id}`}
          aria-selected={active === tab.id}
          tabIndex={active === tab.id || (index === 0 && !tabs.some((item) => item.id === active)) ? 0 : -1}
          className={active === tab.id ? "is-active" : ""}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {tab.badge !== undefined ? <small>{tab.badge}</small> : null}
        </button>
      ))}
    </div>
  );
}

export type WorkbenchItem = ConsoleTab<WorkbenchTabId> & { content: ReactNode };

export function ProductionWorkbench({ items, initialTab = "pipeline" }: { items: WorkbenchItem[]; initialTab?: WorkbenchTabId }) {
  const enabledItems = items.filter((item) => !item.disabled);
  const [active, setActive] = useState<WorkbenchTabId>(() => enabledItems.some((item) => item.id === initialTab) ? initialTab : enabledItems[0]?.id ?? "pipeline");
  const activeItem = enabledItems.find((item) => item.id === active) ?? enabledItems[0];

  return (
    <section className="production-workbench" aria-labelledby="production-workbench-title">
      <div className="workbench-heading">
        <div>
          <span>Production workbench</span>
          <h2 id="production-workbench-title">Everything in one clear workspace</h2>
        </div>
        <select className="workbench-select" value={activeItem?.id} onChange={(event) => setActive(event.target.value as WorkbenchTabId)} aria-label="Workbench section">
          {enabledItems.map((item) => <option key={item.id} value={item.id}>{item.label}{item.badge !== undefined ? ` (${item.badge})` : ""}</option>)}
        </select>
      </div>
      <div className="workbench-tabs" role="tablist" aria-label="Production workbench" onKeyDown={moveTabFocus}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`workbench-tab-${item.id}`}
            aria-controls={`workbench-panel-${item.id}`}
            aria-selected={activeItem?.id === item.id}
            tabIndex={activeItem?.id === item.id ? 0 : -1}
            disabled={item.disabled}
            className={activeItem?.id === item.id ? "is-active" : ""}
            onClick={() => setActive(item.id)}
          >
            <span>{item.label}</span>
            {item.badge !== undefined ? <small>{item.badge}</small> : null}
          </button>
        ))}
      </div>
      {activeItem ? (
        <div className="workbench-content" role="tabpanel" id={`workbench-panel-${activeItem.id}`} aria-labelledby={`workbench-tab-${activeItem.id}`} tabIndex={0}>
          {activeItem.content}
        </div>
      ) : null}
    </section>
  );
}
