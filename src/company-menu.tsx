import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Company } from "../supabase/functions/_shared/model";
import {
  hasTag,
  normalizeTag,
  sameTag,
} from "../supabase/functions/_shared/library";

export type MenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; hint?: string }
  | { heading: string }
  | "separator";

// Keeps a floating panel opened at the pointer inside the viewport, and closes it
// on Escape, an outside click, scrolling or the window losing focus.
function useFloating(x: number, y: number, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, innerHeight - height - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const scroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return { ref, style: { left: pos.left, top: pos.top } };
}

// A right-click menu. Arrow keys move between items; Enter chooses.
export function ContextMenu({
  x,
  y,
  title,
  items,
  onClose,
}: {
  x: number;
  y: number;
  title?: ReactNode;
  items: MenuItem[];
  onClose: () => void;
}) {
  const { ref, style } = useFloating(x, y, onClose);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  const move = (step: number) => {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []),
    ];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {title && <p className="context-menu-title">{title}</p>}
      {items.map((item, i) =>
        item === "separator" ? (
          <hr key={i} />
        ) : "heading" in item ? (
          <p key={i} className="context-menu-heading">
            {item.heading}
          </p>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <small>{item.hint}</small>}
          </button>
        ),
      )}
    </div>
  );
}

// Tags for one or more companies, opened from the right-click menu. Each tick
// saves straight away. A tag on only some of the companies shows as partly
// ticked; ticking it adds it to all of them.
export function TagPopover({
  x,
  y,
  companies,
  known,
  onApply,
  onOpenWindow,
  onClose,
}: {
  x: number;
  y: number;
  companies: Company[];
  known: { tag: string; count: number }[];
  onApply: (tag: string, add: string[], remove: string[]) => Promise<void>;
  onOpenWindow: () => void;
  onClose: () => void;
}) {
  const { ref, style } = useFloating(x, y, onClose);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState<string[]>([]);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const q = text.trim().toLowerCase();
  const visible = known.filter((t) => t.tag.toLowerCase().includes(q));
  const canCreate = !!normalizeTag(text) && !known.some((t) => sameTag(t.tag, text));
  const stateOf = (tag: string) => {
    const n = companies.filter((c) => hasTag(c, tag)).length;
    return n === 0 ? "none" : n === companies.length ? "all" : "some";
  };
  const apply = async (tag: string) => {
    if (saving.some((t) => sameTag(t, tag))) return;
    const state = stateOf(tag);
    const ids = companies.map((c) => c.id);
    setSaving((s) => [...s, tag]);
    setError("");
    try {
      if (state === "all") await onApply(tag, [], ids);
      else
        await onApply(
          tag,
          companies.filter((c) => !hasTag(c, tag)).map((c) => c.id),
          [],
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving((s) => s.filter((t) => !sameTag(t, tag)));
    }
  };
  return (
    <div
      ref={ref}
      className="context-menu tag-popover"
      role="dialog"
      aria-label="Edit tags"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p className="context-menu-title">
        Tags ·{" "}
        {companies.length === 1
          ? companies[0].name
          : `${companies.length} companies`}
      </p>
      <input
        ref={input}
        type="search"
        aria-label="Find or create a tag"
        placeholder="Find or create a tag…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const exact = known.find((t) => sameTag(t.tag, text));
            const target = exact?.tag || (canCreate ? normalizeTag(text) : visible[0]?.tag);
            if (target) {
              void apply(target);
              setText("");
            }
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            ref.current?.querySelector<HTMLInputElement>(".tag-popover-list input")?.focus();
          }
        }}
      />
      <ul className="tag-popover-list">
        {canCreate && (
          <li>
            <button
              type="button"
              className="tag-create"
              onClick={() => {
                void apply(normalizeTag(text));
                setText("");
              }}
            >
              + Create and add “{normalizeTag(text)}”
            </button>
          </li>
        )}
        {visible.map((t) => {
          const state = stateOf(t.tag);
          const busy = saving.some((s) => sameTag(s, t.tag));
          return (
            <li key={t.tag}>
              <label className={busy ? "saving" : ""}>
                <input
                  type="checkbox"
                  checked={state === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = state === "some";
                  }}
                  disabled={busy}
                  onChange={() => apply(t.tag)}
                />
                <span>{t.tag}</span>
                <small>{busy ? "Saving…" : t.count}</small>
              </label>
            </li>
          );
        })}
        {!visible.length && !canCreate && <li className="muted">No tags yet.</li>}
      </ul>
      {error && (
        <p role="alert" className="tag-popover-error">
          {error}
        </p>
      )}
      <div className="tag-popover-foot">
        <button
          type="button"
          className="link"
          onClick={() => {
            onClose();
            onOpenWindow();
          }}
        >
          Open tag window
        </button>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

// Ctrl/Cmd-click toggles one item, Shift-click selects a range from the last
// clicked item. Returns null for a plain click so the caller does its default.
export function multiSelectClick(
  e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ids: string[],
  id: string,
  selected: string[],
  anchor: string | null,
): string[] | null {
  if (e.shiftKey) {
    const from = ids.indexOf(anchor ?? id),
      to = ids.indexOf(id);
    if (from < 0 || to < 0) return [id];
    const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
    return e.ctrlKey || e.metaKey
      ? [...new Set([...selected, ...range])]
      : range;
  }
  if (e.ctrlKey || e.metaKey)
    return selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
  return null;
}
