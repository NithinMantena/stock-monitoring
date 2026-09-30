import { useEffect, useRef, useState } from "react";
import type { SavedList } from "../supabase/functions/_shared/library";

// Save opens a small menu of the owner's lists; an article can be in several.
export function SavePicker({
  lists,
  selected,
  disabled,
  onChange,
  onCreateList,
}: {
  lists: SavedList[];
  selected: string[];
  disabled: boolean;
  onChange: (lists: string[]) => void;
  onCreateList: (name: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const names = lists.filter((l) => selected.includes(l.id)).map((l) => l.name);
  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError("");
    try {
      const id = await onCreateList(trimmed);
      setName("");
      onChange([...selected, id]);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="save-picker" ref={box}>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={selected.length > 0}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
        title={names.length ? `Saved in ${names.join(", ")}` : "Save to a list"}
      >
        {names.length
          ? `Saved · ${names.length === 1 ? names[0] : `${names.length} lists`}`
          : "Save"}{" "}
        ▾
      </button>
      {open && (
        <div className="save-menu" role="group" aria-label="Save to lists">
          <p className="eyebrow">SAVE TO</p>
          {lists.map((l) => (
            <label key={l.id} className="save-option">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.includes(l.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, l.id]
                      : selected.filter((x) => x !== l.id),
                  )
                }
              />
              {l.name}
            </label>
          ))}
          <form
            className="save-new"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input
              aria-label="New list name"
              placeholder="+ New list…"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {name.trim() && <button disabled={disabled}>Add</button>}
          </form>
          {error && <p role="alert">{error}</p>}
          {selected.length > 0 && (
            <button
              type="button"
              className="link"
              disabled={disabled}
              onClick={() => onChange([])}
            >
              Remove from all lists
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ListManager({
  lists,
  counts,
  onRename,
  onDelete,
  onCreate,
}: {
  lists: SavedList[];
  counts: Map<string, number>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<string>;
}) {
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <details className="list-manager">
      <summary>Manage lists</summary>
      <ul>
        {lists.map((l) => (
          <li key={l.id}>
            {editing === l.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await onRename(l.id, draft);
                    setEditing("");
                  });
                }}
              >
                <input
                  autoFocus
                  aria-label={`Rename ${l.name}`}
                  value={draft}
                  maxLength={80}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button disabled={!draft.trim()}>Save</button>
                <button type="button" onClick={() => setEditing("")}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span>
                  {l.name} <small className="muted">{counts.get(l.id) || 0}</small>
                </span>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setEditing(l.id);
                    setDraft(l.name);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    const n = counts.get(l.id) || 0;
                    if (
                      confirm(
                        n
                          ? `Delete "${l.name}"? Its ${n} saved item${n === 1 ? "" : "s"} leave this list; items in no other list return to History.`
                          : `Delete "${l.name}"?`,
                      )
                    )
                      void run(() => onDelete(l.id));
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await onCreate(name);
            setName("");
          });
        }}
      >
        <input
          aria-label="New list name"
          placeholder="New list name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button disabled={!name.trim()}>Create list</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
