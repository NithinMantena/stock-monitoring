import React, {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { NOTE_SECTIONS } from "../supabase/functions/_shared/journal";
const ReactMarkdown = React.lazy(() => import("react-markdown"));

// The notes editor shared by the journal and the notebook. Notes are Markdown
// (nested bullets, as in the Investment Pitch List). The journal shows them
// formatted and switches to editing where you click; the notebook edits.

export interface NotesEditorHandle {
  // Adds a block at the caret while editing, otherwise at the end.
  insert(block: string): void;
}
const NATIVE_AUTOSIZE =
  typeof CSS !== "undefined" && !!CSS.supports?.("field-sizing", "content");
const INDENT = "    ";
const LIST = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;

function lineBounds(value: string, start: number, end: number) {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the start of a line does not include that line.
  const stop = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const next = value.indexOf("\n", stop);
  return [from, next === -1 ? value.length : next] as const;
}

// Replaces a range through the browser so Ctrl+Z still works.
function replaceRange(
  el: HTMLTextAreaElement,
  from: number,
  to: number,
  text: string,
) {
  el.focus();
  el.setSelectionRange(from, to);
  if (!document.execCommand?.("insertText", false, text)) {
    el.setRangeText(text, from, to, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function handleListKeys(e: React.KeyboardEvent<HTMLTextAreaElement>) {
  const el = e.currentTarget;
  const value = el.value;
  const { selectionStart: start, selectionEnd: end } = el;
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const [from, to] = lineBounds(value, start, end);
    const lines = value.slice(from, to).split("\n");
    const next = lines.map((l) =>
      e.shiftKey ? l.replace(/^( {1,4}|\t)/, "") : INDENT + l,
    );
    const text = next.join("\n");
    const firstShift = next[0].length - lines[0].length;
    replaceRange(el, from, to, text);
    if (start === end) {
      const caret = Math.max(from, start + firstShift);
      el.setSelectionRange(caret, caret);
    } else el.setSelectionRange(from, from + text.length);
    return;
  }
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.nativeEvent.isComposing &&
    start === end
  ) {
    const [from, to] = lineBounds(value, start, start);
    const line = value.slice(from, to);
    const m = LIST.exec(line);
    if (!m || start < from + m[1].length + m[2].length) return;
    e.preventDefault();
    const [, indent, marker, gap, content] = m;
    if (!content.trim() && start === to) {
      // Enter on an empty bullet steps out a level, then out of the list.
      replaceRange(
        el,
        from,
        to,
        indent.length ? indent.slice(INDENT.length) + marker + gap : "",
      );
      return;
    }
    const nextMarker = /^\d+/.test(marker)
      ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`
      : marker;
    replaceRange(el, start, start, `\n${indent}${nextMarker} `);
  }
}

function caretFromPoint(x: number, y: number) {
  const d = document as any;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p
      ? { node: p.offsetNode as Node, offset: p.offset as number }
      : null;
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y) as Range | null;
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}
// Where in the Markdown source a click on the formatted notes landed: the
// clicked words are searched for near the same relative position.
function sourceOffset(root: HTMLElement, source: string, x: number, y: number) {
  const hit = caretFromPoint(x, y);
  if (!hit || !root.contains(hit.node) || hit.node.nodeType !== Node.TEXT_NODE)
    return source.length;
  let before = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && n !== hit.node; n = walker.nextNode())
    before += n.textContent?.length || 0;
  const total = root.textContent?.length || 1;
  const estimate = Math.round(((before + hit.offset) / total) * source.length);
  const text = hit.node.textContent || "";
  const snippet = text.slice(Math.max(0, hit.offset - 12), hit.offset);
  if (snippet.trim().length >= 3) {
    let best = -1;
    for (
      let i = source.indexOf(snippet);
      i !== -1;
      i = source.indexOf(snippet, i + 1)
    )
      if (best === -1 || Math.abs(i - estimate) < Math.abs(best - estimate))
        best = i;
    if (best !== -1) return best + snippet.length;
  }
  return Math.min(source.length, estimate);
}

export function FormattedNotes({
  value,
  empty,
}: {
  value: string;
  empty?: string;
}) {
  return (
    <React.Suspense fallback={<p className="muted">Formatting notes…</p>}>
      {value.trim() ? (
        <ReactMarkdown
          skipHtml
          components={{
            a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
          }}
        >
          {value}
        </ReactMarkdown>
      ) : (
        <p className="notes-empty">{empty || "Nothing written yet."}</p>
      )}
    </React.Suspense>
  );
}

export const NotesEditor = forwardRef<
  NotesEditorHandle,
  {
    value: string;
    onChange: (value: string) => void;
    label: string;
    // "click": formatted until clicked (journal). "always": a text box (notebook).
    edit: "click" | "always";
    placeholder?: string;
    className?: string;
  }
>(function NotesEditor(
  { value, onChange, label, edit, placeholder, className = "" },
  ref,
) {
  const [editing, setEditing] = useState(edit === "always");
  const area = useRef<HTMLTextAreaElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const caret = useRef<number | null>(null);
  // Last caret position while editing, so "Insert section" lands there.
  const lastCaret = useRef<number | null>(null);
  const reveal = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  // Grows with its text: natively where the browser supports it (CSS
  // field-sizing), otherwise measured here. Measuring collapses the box, which
  // re-lays-out the page and can clamp its scroll position, so it is done only
  // when the text no longer fits or got shorter, and the scroll is restored.
  const typed = useRef(value.length);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || NATIVE_AUTOSIZE) return;
    const shorter = value.length < typed.current;
    typed.current = value.length;
    if (!shorter && el.style.height) {
      if (el.scrollHeight > el.clientHeight)
        el.style.height = el.scrollHeight + 2 + "px";
      return;
    }
    const scroller = el.closest<HTMLElement>(".journal-doc, .detail");
    const top = scroller?.scrollTop;
    const pageY = window.scrollY;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + 2 + "px";
    if (scroller && top !== undefined) scroller.scrollTop = top;
    if (window.scrollY !== pageY) window.scrollTo(window.scrollX, pageY);
  }, [value, editing]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!editing || !el || caret.current === null) return;
    const at = caret.current;
    caret.current = null;
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
    // A heading added at the end of long notes is brought into view.
    if (reveal.current) el.scrollIntoView({ block: "end" });
    reveal.current = false;
  }, [editing]);
  useImperativeHandle(ref, () => ({
    insert(block: string) {
      const el = area.current;
      const text = latest.current;
      if (el && editing) {
        const at = Math.min(lastCaret.current ?? text.length, text.length);
        const lineStart = at === 0 || text[at - 1] === "\n";
        const pad =
          at === 0
            ? ""
            : lineStart
              ? text[at - 2] === "\n"
                ? ""
                : "\n"
              : "\n\n";
        replaceRange(el, at, at, pad + block);
        lastCaret.current = el.selectionStart;
        return;
      }
      const base = text.replace(/\s+$/, "");
      const next = (base ? base + "\n\n" : "") + block;
      onChange(next);
      caret.current = next.length;
      reveal.current = true;
      setEditing(true);
    },
  }));
  if (!editing)
    return (
      <div
        ref={view}
        className={"markdown notes-view " + className}
        tabIndex={0}
        role="group"
        aria-label={`${label} (Enter to edit)`}
        title="Click to edit"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) return;
          if (window.getSelection()?.toString()) return;
          caret.current = view.current
            ? sourceOffset(view.current, value, e.clientX, e.clientY)
            : value.length;
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) {
            e.preventDefault();
            caret.current = value.length;
            setEditing(true);
          }
        }}
      >
        <FormattedNotes value={value} empty={placeholder} />
      </div>
    );
  return (
    <textarea
      ref={area}
      className={"notes notes-edit " + className}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      spellCheck
      onChange={(e) => onChange(e.target.value)}
      onSelect={(e) => (lastCaret.current = e.currentTarget.selectionStart)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && edit === "click") {
          e.preventDefault();
          e.currentTarget.blur();
          return;
        }
        handleListKeys(e);
      }}
      onBlur={(e) => {
        lastCaret.current = e.currentTarget.selectionStart;
        // Choosing "Insert section" keeps the text box open.
        const next = e.relatedTarget as HTMLElement | null;
        if (edit === "click" && !next?.closest(".section-picker"))
          setEditing(false);
      }}
    />
  );
});

// "Insert section" picker; the first option inserts every heading at once.
export function SectionPicker({
  onInsert,
  compact = false,
}: {
  onInsert: (block: string) => void;
  compact?: boolean;
}) {
  return (
    <select
      className={"section-picker" + (compact ? " compact" : "")}
      aria-label="Insert a section heading"
      value=""
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        onInsert(
          v === "*"
            ? NOTE_SECTIONS.map((s) => `### ${s}\n\n- `).join("\n\n")
            : `### ${v}\n\n- `,
        );
      }}
    >
      <option value="">Insert section…</option>
      <option value="*">All sections</option>
      {NOTE_SECTIONS.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
