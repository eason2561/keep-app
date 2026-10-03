// Note file format, shared with src/keepnotes/notes.py. Keep the two in sync.
//
//   notes/<id>.md
//   ---
//   title: Groceries
//   type: checklist          # text | checklist
//   color: yellow            # see COLORS
//   pinned: true
//   archived: false
//   trashed: 2026-10-03T18:12:00Z   # only while in the trash
//   labels: [shopping]
//   images: [attachments/<id>-a1b2.jpg]
//   created: 2026-10-03T18:12:00Z
//   updated: 2026-10-03T18:20:00Z
//   ---
//   - [ ] Milk
//     - [ ] Oat milk          (two-space indent = sub-item)
//   - [x] Eggs
//
// A text note's body is plain text. Every front-matter field is optional.

const yaml = globalThis.jsyaml;

export const COLORS = [
  "default", "red", "orange", "yellow", "green", "teal",
  "blue", "darkblue", "purple", "pink", "brown", "gray",
];

const FIELD_ORDER = ["title", "type", "color", "pinned", "archived", "trashed", "labels", "images", "created", "updated"];
const ITEM_RE = /^(\s*)[-*]\s+\[( |x|X)\]\s?(.*)$/;

export function newId(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${rand}`;
}

export const pathFor = (id) => `notes/${id}.md`;
export const idFromPath = (path) => path.replace(/^notes\//, "").replace(/\.md$/, "");

function str(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function parseItems(body) {
  const items = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(ITEM_RE);
    if (m) items.push({ text: m[3], checked: m[2] !== " ", indent: m[1].length >= 2 ? 1 : 0 });
    else items.push({ text: line.replace(/^\s*[-*]\s+/, "").trim(), checked: false, indent: 0 });
  }
  return items;
}

export function itemsToBody(items) {
  return items.map((i) => `${i.indent ? "  " : ""}- [${i.checked ? "x" : " "}] ${i.text}`).join("\n");
}

// Text of a file → note object. Never throws: unreadable front matter becomes body text.
export function parseNote(text, path) {
  let meta = {};
  let body = text.replace(/\r\n/g, "\n");
  const m = body.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  let error = null;
  if (m) {
    try {
      meta = yaml.load(m[1], { schema: yaml.CORE_SCHEMA }) || {};
      if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("front matter is not a mapping");
      body = body.slice(m[0].length);
    } catch (e) {
      error = `Front matter: ${e.message}`;
      meta = {};
    }
  }
  body = body.replace(/^\n+/, "").replace(/\s+$/, "");
  const type = meta.type === "checklist" ? "checklist" : "text";
  const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(str).filter(Boolean);
  const note = {
    id: idFromPath(path),
    path,
    title: str(meta.title),
    type,
    color: COLORS.includes(meta.color) ? meta.color : "default",
    pinned: meta.pinned === true,
    archived: meta.archived === true,
    trashed: meta.trashed ? str(meta.trashed) : null,
    labels: list(meta.labels),
    images: list(meta.images),
    created: str(meta.created),
    updated: str(meta.updated),
    body: type === "text" ? body : "",
    items: type === "checklist" ? parseItems(body) : [],
    extra: {},
    error,
  };
  // Keep fields this app doesn't know about (Claude may add some) when saving.
  for (const [k, v] of Object.entries(meta)) if (!FIELD_ORDER.includes(k)) note.extra[k] = v;
  return note;
}

export function serializeNote(note) {
  const meta = {};
  if (note.title) meta.title = note.title;
  if (note.type === "checklist") meta.type = "checklist";
  if (note.color && note.color !== "default") meta.color = note.color;
  if (note.pinned) meta.pinned = true;
  if (note.archived) meta.archived = true;
  if (note.trashed) meta.trashed = note.trashed;
  if (note.labels.length) meta.labels = [...note.labels];
  if (note.images.length) meta.images = [...note.images];
  meta.created = note.created;
  meta.updated = note.updated;
  Object.assign(meta, note.extra);
  const fm = yaml.dump(meta, { schema: yaml.CORE_SCHEMA, lineWidth: -1, flowLevel: 1 }).trimEnd();
  const body = note.type === "checklist" ? itemsToBody(note.items) : note.body.replace(/\s+$/, "");
  return `---\n${fm}\n---\n${body ? `${body}\n` : ""}`;
}

export function blankNote(type = "text", now = new Date()) {
  const id = newId(now);
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    id, path: pathFor(id), title: "", type, color: "default", pinned: false, archived: false,
    trashed: null, labels: [], images: [], created: iso, updated: iso, body: "",
    items: [], extra: {}, error: null,
  };
}

export function isEmpty(note) {
  return !note.title.trim() && !note.body.trim() && !note.items.some((i) => i.text.trim()) && !note.images.length;
}

// Switch between a text note and a checklist the way Keep does (one line ↔ one item).
export function toChecklist(note) {
  if (note.type === "checklist") return note;
  const items = note.body.split("\n").filter((l) => l.trim()).map((l) => ({ text: l.trim(), checked: false, indent: 0 }));
  return { ...note, type: "checklist", items, body: "" };
}
export function toText(note) {
  if (note.type === "text") return note;
  return { ...note, type: "text", body: note.items.map((i) => i.text).join("\n"), items: [] };
}

export function matches(note, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [note.title, note.body, ...note.items.map((i) => i.text), ...note.labels].join("\n").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
