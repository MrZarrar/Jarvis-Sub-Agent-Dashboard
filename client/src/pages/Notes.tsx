/**
 * @file Notes.tsx
 * @description Notes + brain-dump (Phase G). Notes are markdown files on disk
 * (server/lib/notes.js) indexed in SQLite with FTS5 search. This page is:
 *   - a pinned quick-capture box that runs the mini-Jarvis brain-dump flow
 *     (raw → reformatted note, with a raw↔formatted confirm before saving),
 *   - FTS search + tag filters,
 *   - a list ↔ editor split (plain textarea + markdown preview - no heavy editor
 *     dep, reusing <MarkdownContent/>),
 *   - a drain surface for the voice/chat "note: …" capture inbox.
 *
 * Mobile: the capture box stays pinned on top; the list and editor stack.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  StickyNote,
  Plus,
  Search,
  Sparkles,
  Save,
  Trash2,
  X,
  Eye,
  Pencil,
  Inbox,
  Check,
  Loader2,
  Folder,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { EmptyState } from "../components/EmptyState";
import { MarkdownContent } from "../components/conversation/MarkdownContent";
import { useBrainLockAccess } from "../components/BrainLockGate";
import { eventBus } from "../lib/eventBus";
import { timeAgo } from "../lib/format";
import type { Note, NoteMeta, NoteTag, NoteCapture, DumpResult } from "../lib/types";

const SOURCE_BADGE: Record<string, string> = {
  dump: "text-violet-300 bg-violet-500/10 border-violet-500/25",
  voice: "text-sky-300 bg-sky-500/10 border-sky-500/25",
  manual: "text-slate-400 bg-slate-500/10 border-slate-500/25",
};

export function Notes() {
  const { state: brainState, accessRevision } = useBrainLockAccess();
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [tags, setTags] = useState<NoteTag[]>([]);
  const [captures, setCaptures] = useState<NoteCapture[]>([]);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listRequest = useRef(0);
  const captureRequest = useRef(0);
  const noteRequest = useRef(0);
  const previousAccessRevision = useRef(accessRevision);

  const loadList = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const [notesRes, tagsRes] = await Promise.all([
        api.notes.list({ q: query || undefined, tag: activeTag || undefined }),
        api.notes.tags(),
      ]);
      if (request === listRequest.current) {
        setNotes(notesRes.items);
        setTags(tagsRes.items);
        setError(null);
      }
    } catch (e) {
      if (request === listRequest.current) {
        setError(e instanceof Error ? e.message : "Failed to load notes");
      }
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [query, activeTag]);

  const loadCaptures = useCallback(async () => {
    const request = ++captureRequest.current;
    try {
      const res = await api.notes.captures();
      if (request === captureRequest.current) setCaptures(res.items);
    } catch {
      /* inbox is optional */
    }
  }, []);

  useEffect(() => {
    if (previousAccessRevision.current === accessRevision) return;
    previousAccessRevision.current = accessRevision;
    listRequest.current += 1;
    captureRequest.current += 1;
    noteRequest.current += 1;
    setSelectedId(null);
    setSelected(null);
    setCreating(false);
    if (brainState !== "unlocked") {
      setNotes((items) => items.filter((item) => !item.sensitive));
      setTags([]);
      setActiveTag(null);
    }
  }, [accessRevision, brainState]);

  useEffect(() => {
    loadList();
  }, [accessRevision, loadList]);

  useEffect(() => {
    loadCaptures();
  }, [accessRevision, loadCaptures]);

  // Live reindex: the watcher broadcasts note_changed when a file changes on disk.
  useEffect(() => {
    return eventBus.subscribe((msg) => {
      if (msg.type === "note_changed") loadList();
    });
  }, [loadList]);

  const openNote = useCallback(async (id: string) => {
    const request = ++noteRequest.current;
    setCreating(false);
    setSelectedId(id);
    try {
      const res = await api.notes.get(id);
      if (request === noteRequest.current) setSelected(res.note);
    } catch (e) {
      if (request === noteRequest.current) {
        setError(e instanceof Error ? e.message : "Failed to open note");
      }
    }
  }, []);

  const startNew = useCallback(() => {
    setCreating(true);
    setSelectedId(null);
    setSelected(null);
  }, []);

  const afterSave = useCallback(
    (note: Note | null) => {
      setCreating(false);
      if (!note || (note.sensitive && brainState !== "unlocked")) {
        setSelectedId(null);
        setSelected(null);
        loadList();
        return;
      }
      setSelectedId(note.id);
      setSelected(note);
      loadList();
    },
    [brainState, loadList]
  );

  const afterDelete = useCallback(() => {
    setSelectedId(null);
    setSelected(null);
    setCreating(false);
    loadList();
  }, [loadList]);

  return (
    <div className="animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
            <StickyNote className="w-4.5 h-4.5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-100">Notes</h1>
            <p className="text-xs text-gray-500">
              Markdown on disk, searchable, brain-dump reformatted by mini-Jarvis.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={startNew}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent border border-accent/30 text-sm font-medium hover:bg-accent/25 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Note
        </button>
      </div>

      <NotesFolderBar />

      <QuickCapture onSaved={afterSave} />

      {captures.length > 0 && (
        <CapturesBanner
          captures={captures}
          onChanged={() => {
            loadCaptures();
            loadList();
          }}
          onFiled={afterSave}
        />
      )}

      {error && (
        <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2 mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,22rem)_1fr] gap-4">
        {/* List column */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes…"
              className="w-full rounded-lg bg-surface-2 border border-border pl-9 pr-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none"
            />
          </div>

          {tags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {activeTag && (
                <button
                  type="button"
                  onClick={() => setActiveTag(null)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium border bg-accent/15 text-accent border-accent/30 inline-flex items-center gap-1"
                >
                  #{activeTag}
                  <X className="w-3 h-3" />
                </button>
              )}
              {tags
                .filter((t) => t.tag !== activeTag)
                .slice(0, 12)
                .map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => setActiveTag(t.tag)}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium border bg-surface-2 text-gray-400 border-border hover:text-gray-200 hover:bg-surface-3"
                  >
                    #{t.tag}
                    <span className="ml-1 text-gray-600">{t.count}</span>
                  </button>
                ))}
            </div>
          )}

          {loading ? (
            <p className="text-sm text-gray-500 px-1">Loading…</p>
          ) : notes.length === 0 ? (
            <div className="pt-4">
              <EmptyState
                icon={StickyNote}
                title="No notes yet"
                description="Dump a thought in the box above, or create one. Files land in your notes folder and sync both ways."
              />
            </div>
          ) : (
            <div className="space-y-2 max-h-[calc(100vh-20rem)] overflow-y-auto pr-1">
              {notes.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  active={n.id === selectedId}
                  onClick={() => openNote(n.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Editor column */}
        <div>
          {creating ? (
            <NoteEditor
              key="new"
              mode="create"
              onSaved={afterSave}
              onCancel={() => setCreating(false)}
            />
          ) : selected ? (
            <NoteEditor
              key={selected.id}
              mode="edit"
              note={selected}
              onSaved={afterSave}
              onDeleted={afterDelete}
            />
          ) : (
            <div className="holo-panel card p-8 h-full flex items-center justify-center min-h-[16rem]">
              <p className="text-sm text-gray-600">Select a note, or start a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NoteRow({
  note,
  active,
  onClick,
}: {
  note: NoteMeta;
  active: boolean;
  onClick: () => void;
}) {
  const badge = SOURCE_BADGE[note.source] || SOURCE_BADGE.manual;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
        active
          ? "bg-accent/10 border-accent/40"
          : "bg-surface-2 border-border hover:bg-surface-3 hover:border-accent/20"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <h3 className="text-sm font-medium text-gray-100 truncate">{note.title}</h3>
        {note.source && note.source !== "manual" && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0 ${badge}`}>
            {note.source}
          </span>
        )}
      </div>
      {note.excerpt && <p className="text-xs text-gray-500 line-clamp-2 mb-1">{note.excerpt}</p>}
      <div className="flex items-center gap-2 text-[10px] text-gray-600">
        <span>{timeAgo(note.updatedAt)}</span>
        {note.tags.slice(0, 3).map((t) => (
          <span key={t} className="text-gray-500">
            #{t}
          </span>
        ))}
      </div>
    </button>
  );
}

// ── Notes folder setting ────────────────────────────────────────────────────

function NotesFolderBar() {
  const [dir, setDir] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.notes
      .config()
      .then((c) => setDir(c.dir))
      .catch(() => setDir(null));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.notes.setConfig(value.trim());
      setDir(c.dir);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set folder");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-4">
      <Folder className="w-3.5 h-3.5 flex-shrink-0" />
      {editing ? (
        <>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Absolute path (e.g. ~/JarvisNotes)"
            className="flex-1 max-w-md rounded-md bg-surface-2 border border-border px-2 py-1 text-xs text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none font-mono"
          />
          <button
            type="button"
            onClick={save}
            disabled={busy || !value.trim()}
            className="px-2 py-1 rounded-md bg-accent/15 text-accent border border-accent/30 text-[11px] font-medium hover:bg-accent/25 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="px-2 py-1 rounded-md text-gray-500 text-[11px] hover:text-gray-300"
          >
            Cancel
          </button>
          {error && <span className="text-red-300">{error}</span>}
        </>
      ) : (
        <>
          <span className="font-mono truncate">{dir || "…"}</span>
          <button
            type="button"
            onClick={() => {
              setValue(dir || "");
              setEditing(true);
            }}
            className="text-accent hover:underline flex-shrink-0"
          >
            change
          </button>
        </>
      )}
    </div>
  );
}

// ── Quick-capture / brain-dump ─────────────────────────────────────────────

function QuickCapture({ onSaved }: { onSaved: (note: Note | null) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<DumpResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reformat = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.notes.dump({ text, save: false });
      setPreview(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reformat failed");
    } finally {
      setBusy(false);
    }
  }, [text]);

  const saveRaw = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.notes.create({ title: "", body: text });
      setText("");
      setPreview(null);
      if (res.note) onSaved(res.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [text, onSaved]);

  const confirmFormatted = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      // Save the already-reformatted content directly (no second brain call).
      const res = await api.notes.create({
        title: preview.title,
        body: preview.body,
        tags: preview.tags,
      });
      setText("");
      setPreview(null);
      if (res.note) onSaved(res.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [preview, onSaved]);

  return (
    <div className="holo-panel card p-4 mb-5">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-accent" />
        <span className="text-xs font-medium text-gray-300">Quick capture</span>
        <span className="text-[11px] text-gray-600">
          - dump a thought; mini-Jarvis cleans it into a note
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Brain-dump here… (unstructured is fine)"
        rows={3}
        className="w-full rounded-lg bg-surface-2 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none resize-y"
      />
      {error && <p className="text-xs text-red-300 mt-2">{error}</p>}

      {!preview ? (
        <div className="flex items-center justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={saveRaw}
            disabled={busy || !text.trim()}
            className="px-3 py-1.5 rounded-lg bg-surface-2 text-gray-300 border border-border text-xs font-medium hover:bg-surface-3 disabled:opacity-50"
          >
            Save raw
          </button>
          <button
            type="button"
            onClick={reformat}
            disabled={busy || !text.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/15 text-accent border border-accent/30 text-xs font-medium hover:bg-accent/25 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            Reformat
          </button>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-accent/25 bg-accent/5 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-accent">
              {preview.formatted
                ? `Reformatted${preview.provider ? ` · ${preview.provider}` : ""}`
                : "No provider configured - raw pass-through"}
            </span>
            <span className="text-[10px] text-gray-500">{preview.title}</span>
          </div>
          <div className="rounded-md bg-surface-1 border border-border p-3 max-h-64 overflow-y-auto">
            <MarkdownContent text={preview.body} dense />
          </div>
          {preview.tags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-2">
              {preview.tags.map((t) => (
                <span key={t} className="text-[10px] text-gray-400">
                  #{t}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={() => setPreview(null)}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-surface-2 text-gray-400 border border-border text-xs font-medium hover:bg-surface-3 disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={saveRaw}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-surface-2 text-gray-300 border border-border text-xs font-medium hover:bg-surface-3 disabled:opacity-50"
            >
              Save raw instead
            </button>
            <button
              type="button"
              onClick={confirmFormatted}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/15 text-accent border border-accent/30 text-xs font-medium hover:bg-accent/25 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Save note
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Captures inbox drain ────────────────────────────────────────────────────

function CapturesBanner({
  captures,
  onChanged,
  onFiled,
}: {
  captures: NoteCapture[];
  onChanged: () => void;
  onFiled: (note: Note) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const file = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api.notes.fileCapture(id);
      onFiled(res.note);
      onChanged();
    } finally {
      setBusyId(null);
    }
  };
  const discard = async (id: string) => {
    setBusyId(id);
    try {
      await api.notes.discardCapture(id);
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3 mb-5">
      <div className="flex items-center gap-2 mb-2">
        <Inbox className="w-4 h-4 text-sky-300" />
        <span className="text-xs font-medium text-sky-200">
          {captures.length} captured {captures.length === 1 ? "note" : "notes"} from voice/chat
        </span>
      </div>
      <div className="space-y-2">
        {captures.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-2 rounded-md bg-surface-1 border border-border px-3 py-2"
          >
            <p className="text-xs text-gray-300 flex-1 line-clamp-2">{c.text}</p>
            <button
              type="button"
              onClick={() => file(c.id)}
              disabled={busyId === c.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent/15 text-accent border border-accent/30 text-[11px] font-medium hover:bg-accent/25 disabled:opacity-50"
            >
              {busyId === c.id ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              File
            </button>
            <button
              type="button"
              onClick={() => discard(c.id)}
              disabled={busyId === c.id}
              className="px-2 py-1 rounded-md bg-surface-2 text-gray-500 border border-border text-[11px] hover:text-gray-300 disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Editor (create / edit) ──────────────────────────────────────────────────

function NoteEditor({
  mode,
  note,
  onSaved,
  onDeleted,
  onCancel,
}: {
  mode: "create" | "edit";
  note?: Note;
  onSaved: (note: Note | null) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}) {
  const { state: brainState } = useBrainLockAccess();
  const [title, setTitle] = useState(note?.title ?? "");
  const [tagsText, setTagsText] = useState((note?.tags ?? []).join(", "));
  const [body, setBody] = useState(note?.body ?? "");
  const [sensitive, setSensitive] = useState(note?.sensitive ?? false);
  const [sensitiveChanged, setSensitiveChanged] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      if (mode === "create") {
        const res = await api.notes.create({ title, body, tags, sensitive });
        onSaved(res.note);
      } else if (note) {
        const res = await api.notes.update(note.id, {
          title,
          body,
          tags,
          ...(sensitiveChanged ? { sensitive } : {}),
        });
        onSaved(res.note);
      }
    } catch (e) {
      const becameHiddenWhileLocked =
        mode === "edit" &&
        note?.sensitive === false &&
        sensitiveChanged &&
        sensitive &&
        brainState === "locked" &&
        e instanceof ApiError &&
        e.status === 404;
      if (becameHiddenWhileLocked) {
        onSaved(null);
        return;
      }
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [mode, note, title, body, tagsText, sensitive, sensitiveChanged, brainState, onSaved]);

  const remove = useCallback(async () => {
    if (!note) return;
    setBusy(true);
    try {
      await api.notes.remove(note.id);
      onDeleted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }, [note, onDeleted]);

  return (
    <div className="holo-panel card p-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="w-full bg-transparent text-base font-semibold text-gray-100 placeholder-gray-600 focus:outline-none mb-2"
      />
      <input
        value={tagsText}
        onChange={(e) => setTagsText(e.target.value)}
        placeholder="tags, comma, separated"
        className="w-full bg-transparent text-xs text-gray-400 placeholder-gray-600 focus:outline-none mb-3 border-b border-border pb-2"
      />

      <label className="mb-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-gray-300">
        <input
          type="checkbox"
          aria-label="Sensitive information"
          checked={sensitive}
          onChange={(event) => {
            const next = event.target.checked;
            setSensitive(next);
            if (mode === "edit") setSensitiveChanged(next !== (note?.sensitive ?? false));
          }}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        <span>
          Sensitive information
          <span className="block text-[11px] text-gray-500">
            Hide this note unless the Brain session is unlocked.
          </span>
        </span>
      </label>

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1 text-[11px] text-gray-500">
          {note?.path && <span className="font-mono truncate max-w-[20rem]">{note.path}</span>}
        </div>
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-2 text-gray-400 border border-border text-[11px] hover:text-gray-200"
        >
          {showPreview ? <Pencil className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          {showPreview ? "Edit" : "Preview"}
        </button>
      </div>

      {showPreview ? (
        <div className="rounded-lg bg-surface-1 border border-border p-3 min-h-[16rem] max-h-[calc(100vh-24rem)] overflow-y-auto">
          <MarkdownContent text={body || "_Nothing to preview_"} />
        </div>
      ) : (
        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write in markdown…"
          className="w-full rounded-lg bg-surface-1 border border-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-accent/50 focus:outline-none resize-y min-h-[16rem] font-mono"
        />
      )}

      {error && <p className="text-xs text-red-300 mt-2">{error}</p>}

      <div className="flex items-center justify-between mt-3">
        <div>
          {mode === "edit" &&
            (confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-red-300">Delete this note?</span>
                <button
                  type="button"
                  onClick={remove}
                  disabled={busy}
                  className="px-2.5 py-1 rounded-md bg-red-500/15 text-red-300 border border-red-500/30 text-[11px] font-medium hover:bg-red-500/25"
                >
                  Yes, delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1 rounded-md text-gray-500 text-[11px] hover:text-gray-300"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-surface-2 text-gray-500 border border-border text-xs hover:text-red-300 hover:border-red-500/30"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            ))}
        </div>
        <div className="flex items-center gap-2">
          {mode === "create" && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg bg-surface-2 text-gray-400 border border-border text-xs font-medium hover:bg-surface-3"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-accent/15 text-accent border border-accent/30 text-xs font-medium hover:bg-accent/25 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
