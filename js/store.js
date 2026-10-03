// Local state and sync. The last copy of every note is cached in localStorage so the
// app opens instantly (and offline). Edits go into an IndexedDB outbox, one entry per
// file (later edits replace earlier ones, so a burst of typing is one commit), and are
// pushed to GitHub by flush(). If a note changed on GitHub meanwhile (e.g. Claude edited
// it), GitHub's version is kept and yours is saved next to it as a "conflict copy".

import * as gh from "./github.js";
import { parseNote, serializeNote, pathFor, newId, nowIso } from "./notes.js";

const CACHE_KEY = "keep:cache";
const DB = "keep";
const STORE = "outbox";

// ---------- IndexedDB outbox ----------
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "path" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}
const obGet = (path) => tx("readonly", (s) => s.get(path));
const obAll = () => tx("readonly", (s) => s.getAll());
const obPut = (rec) => tx("readwrite", (s) => s.put(rec));
const obDel = (path) => tx("readwrite", (s) => s.delete(path));

// ---------- state ----------
let remote = new Map(); // path -> {sha, text}   (what GitHub had last time we looked)
let outbox = new Map(); // path -> outbox record
export const notes = new Map(); // id -> note (what the app shows)
export const status = { loaded: false, syncing: false, error: null, lastSync: null };

const listeners = new Set();
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (what) => listeners.forEach((fn) => fn(what));

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      lastSync: status.lastSync,
      files: [...remote].map(([path, f]) => ({ path, sha: f.sha, text: f.text })),
    }));
  } catch {}
}

function rebuild() {
  notes.clear();
  const paths = new Set([...remote.keys(), ...outbox.keys()]);
  for (const path of paths) {
    if (!/^notes\/[^/]+\.md$/.test(path)) continue;
    const ob = outbox.get(path);
    if (ob?.kind === "delete") continue;
    const text = ob?.kind === "text" ? ob.text : remote.get(path)?.text;
    if (text == null) continue;
    const note = parseNote(text, path);
    note.pending = Boolean(ob);
    note.syncError = ob?.error || null;
    notes.set(note.id, note);
  }
}

export async function init() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c) {
      remote = new Map(c.files.map((f) => [f.path, { sha: f.sha, text: f.text }]));
      status.lastSync = c.lastSync;
    }
  } catch {}
  try {
    outbox = new Map((await obAll()).map((r) => [r.path, r]));
  } catch {}
  rebuild();
  emit("notes");
}

export async function refresh() {
  if (!gh.isConfigured()) return;
  status.syncing = true;
  emit("status");
  try {
    const files = await gh.loadFolder("notes");
    remote = new Map(files.filter((f) => f.path.endsWith(".md") && f.text != null).map((f) => [f.path, { sha: f.sha, text: f.text }]));
    status.lastSync = new Date().toISOString();
    status.error = null;
    saveCache();
    rebuild();
    emit("notes");
  } catch (e) {
    status.error = e instanceof gh.NetworkError ? null : e.message;
    if (!(e instanceof gh.NetworkError)) throw e;
  } finally {
    status.syncing = false;
    status.loaded = true;
    emit("status");
  }
}

// ---------- edits ----------
const label = (note) => (note.title || note.body || note.items[0]?.text || "untitled").split("\n")[0].slice(0, 50);

async function queue(rec) {
  const prev = outbox.get(rec.path) || (await obGet(rec.path).catch(() => null));
  const full = {
    ...rec,
    // The version our edit is based on: keep the first one until it is pushed.
    baseSha: prev ? prev.baseSha : remote.get(rec.path)?.sha || null,
    error: null,
    at: Date.now(),
  };
  outbox.set(rec.path, full);
  await obPut(full);
}

export async function save(note) {
  const text = serializeNote(note);
  const cur = remote.get(note.path);
  const ob = outbox.get(note.path);
  if (!ob && cur?.text === text) return; // nothing changed
  if (ob?.kind === "text" && ob.text === text) return;
  await queue({ path: note.path, kind: "text", text, message: `${cur ? "Update" : "Add"} note: ${label(note)}` });
  rebuild();
  emit("notes");
}

export async function deleteForever(note) {
  for (const img of note.images) await queue({ path: img, kind: "delete", message: `Delete image of note: ${label(note)}` });
  if (remote.has(note.path) || outbox.get(note.path)?.baseSha) {
    await queue({ path: note.path, kind: "delete", message: `Delete note: ${label(note)}` });
  } else {
    outbox.delete(note.path); // never reached GitHub
    await obDel(note.path);
  }
  rebuild();
  emit("notes");
}

// ---------- images ----------
const imageUrls = new Map(); // path -> object URL

export async function addImage(note, blob) {
  const path = `attachments/${note.id}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const base64 = gh.bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  imageUrls.set(path, Promise.resolve(URL.createObjectURL(blob)));
  await queue({ path, kind: "blob", base64, message: `Add image to note: ${label(note)}` });
  return path;
}

export async function removeImage(note, path) {
  const ob = outbox.get(path);
  if (ob?.kind === "blob" && !ob.baseSha) {
    outbox.delete(path);
    await obDel(path);
  } else {
    await queue({ path, kind: "delete", message: `Remove image from note: ${label(note)}` });
  }
}

export function imageUrl(path) {
  if (!imageUrls.has(path)) {
    const ob = outbox.get(path);
    const p = ob?.kind === "blob"
      ? Promise.resolve(URL.createObjectURL(new Blob([Uint8Array.from(atob(ob.base64), (c) => c.charCodeAt(0))], { type: "image/jpeg" })))
      : gh.getBlob(path).then((b) => URL.createObjectURL(b));
    p.catch(() => imageUrls.delete(path));
    imageUrls.set(path, p);
  }
  return imageUrls.get(path);
}

// ---------- push ----------
const isConflict = (e) => e instanceof gh.GitHubError && (e.status === 409 || e.status === 422);

async function pushText(rec) {
  const b64 = gh.textToBase64(rec.text);
  try {
    return { sha: await gh.putFile(rec.path, b64, rec.message, rec.baseSha || undefined), text: rec.text };
  } catch (e) {
    if (!isConflict(e) && !(e instanceof gh.GitHubError && e.status === 404)) throw e;
  }
  // GitHub's copy isn't the one we started from.
  let cur = null;
  try {
    cur = await gh.getText(rec.path);
  } catch (e) {
    if (!(e instanceof gh.GitHubError && e.status === 404)) throw e;
  }
  if (!cur) {
    // Deleted on GitHub meanwhile: put ours back.
    return { sha: await gh.putFile(rec.path, b64, rec.message), text: rec.text };
  }
  if (cur.text === rec.text) return cur;
  if (cur.sha === rec.baseSha) {
    // Just a race with another commit; try once more.
    return { sha: await gh.putFile(rec.path, b64, rec.message, cur.sha), text: rec.text };
  }
  // Real conflict: keep GitHub's version, save ours as a copy.
  const mine = parseNote(rec.text, rec.path);
  const id = newId();
  const copy = { ...mine, id, path: pathFor(id), title: `${mine.title || "Note"} (conflict copy)`, updated: nowIso() };
  const copyText = serializeNote(copy);
  const copySha = await gh.putFile(copy.path, gh.textToBase64(copyText), `Add note: ${copy.title}`);
  remote.set(copy.path, { sha: copySha, text: copyText });
  emit({ conflict: copy.title });
  return cur;
}

async function pushOne(rec) {
  if (rec.kind === "text") {
    const res = await pushText(rec);
    remote.set(rec.path, { sha: res.sha, text: res.text });
    return res.sha;
  }
  if (rec.kind === "blob") {
    try {
      return await gh.putFile(rec.path, rec.base64, rec.message, rec.baseSha || undefined);
    } catch (e) {
      if (isConflict(e)) return rec.baseSha; // already uploaded
      throw e;
    }
  }
  // delete
  const sha = (rec.path.endsWith(".md") && remote.get(rec.path)?.sha) || rec.baseSha || (await gh.getSha(rec.path));
  if (sha) {
    try {
      await gh.deleteFile(rec.path, sha, rec.message);
    } catch (e) {
      if (isConflict(e) && rec.path.endsWith(".md")) {
        // Edited on GitHub after you deleted it: keep the edited note.
        emit({ conflict: "A note you deleted was edited elsewhere, so it was kept." });
      } else if (!(e instanceof gh.GitHubError && e.status === 404)) throw e;
    }
  }
  remote.delete(rec.path);
  return null;
}

let flushing = null;
export function flush() {
  if (!gh.isConfigured()) return Promise.resolve(0);
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    status.syncing = true;
    emit("status");
    try {
      const recs = [...outbox.values()].filter((r) => !r.error).sort((a, b) => a.at - b.at);
      for (const rec of recs) {
        try {
          const sha = await pushOne(rec);
          sent++;
          const latest = outbox.get(rec.path);
          if (latest && latest.at === rec.at) {
            outbox.delete(rec.path);
            await obDel(rec.path);
          } else if (latest) {
            // Edited again while we were pushing: base the next push on what we just wrote.
            latest.baseSha = sha;
            await obPut(latest);
          }
        } catch (e) {
          if (e instanceof gh.NetworkError) break;
          const latest = outbox.get(rec.path);
          if (latest) {
            latest.error = e.message;
            await obPut(latest);
          }
        }
      }
      if (sent) {
        status.lastSync = new Date().toISOString();
        saveCache();
      }
    } finally {
      status.syncing = false;
      rebuild();
      emit("notes");
      emit("status");
    }
    return sent;
  })().finally(() => {
    flushing = null; // after assignment, even when the body finished synchronously
  });
  return flushing;
}

let timer = null;
export function flushSoon(ms = 2000) {
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch(() => {}), ms);
}

// ---------- outbox management (Settings) ----------
export const pending = () => [...outbox.values()].sort((a, b) => a.at - b.at);

export async function retry(path) {
  const r = outbox.get(path);
  if (!r) return;
  r.error = null;
  await obPut(r);
  return flush();
}

export async function discard(path) {
  outbox.delete(path);
  await obDel(path);
  rebuild();
  emit("notes");
}

export function clearCache() {
  localStorage.removeItem(CACHE_KEY);
  remote = new Map();
  rebuild();
  emit("notes");
}
