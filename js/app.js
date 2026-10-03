// Keep: a Google Keep–style notes app whose notes are Markdown files in your GitHub repo.

import * as gh from "./github.js";
import * as store from "./store.js";
import { icon } from "./icons.js";
import {
  COLORS, blankNote, isEmpty, toChecklist, toText, matches, nowIso, newId, pathFor,
} from "./notes.js";

export const APP_VERSION = "keep-v1"; // keep in step with VERSION in sw.js

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const COLOR_NAMES = {
  default: "Default", red: "Coral", orange: "Peach", yellow: "Sand", green: "Mint", teal: "Sage",
  blue: "Fog", darkblue: "Storm", purple: "Dusk", pink: "Blossom", brown: "Clay", gray: "Chalk",
};
const TRASH_DAYS = 7;

function pref(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`keep:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem(`keep:${key}`, JSON.stringify(value));
  } catch {}
}

const ui = {
  query: "",
  layout: pref("layout", "grid"),
  navOpen: pref("navOpen", true),
};

// ---------- helpers ----------
function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function linkify(text) {
  return esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

function fmtEdited(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

function allLabels() {
  const set = new Set();
  for (const n of store.notes.values()) if (!n.trashed) n.labels.forEach((l) => set.add(l));
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const byCreated = (a, b) => (b.created || "").localeCompare(a.created || "") || b.id.localeCompare(a.id);

// ---------- routing ----------
function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (hash.startsWith("label/")) return { kind: "label", label: hash.slice(6) };
  if (["archive", "trash", "settings"].includes(hash)) return { kind: hash };
  return { kind: "notes" };
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, action) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
  el.hidden = false;
  if (action) $("button", el).onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 3500);
}

// ---------- popover menus ----------
let menuEl = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
function openMenu(anchor, content) {
  closeMenu();
  menuEl = h(`<div class="menu" role="menu"></div>`);
  menuEl.append(content);
  (anchor.closest("dialog") || document.body).append(menuEl);
  const r = anchor.getBoundingClientRect();
  const m = menuEl.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - m.width - 8);
  let top = r.bottom + 4;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 4);
  menuEl.style.left = `${Math.max(8, left)}px`;
  menuEl.style.top = `${top}px`;
  $("input, button", menuEl)?.focus({ preventScroll: true });
}
document.addEventListener("pointerdown", (e) => {
  if (menuEl && !menuEl.contains(e.target) && !e.target.closest("[data-menu]")) closeMenu();
});

function colorMenu(current, onPick) {
  const el = h(`<div class="palette">${COLORS.map((c) => `
    <button type="button" class="swatch c-${c}${c === current ? " on" : ""}" data-c="${c}" title="${COLOR_NAMES[c]}" aria-label="${COLOR_NAMES[c]}">
      ${c === current ? icon("check") : ""}</button>`).join("")}</div>`);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (!b) return;
    onPick(b.dataset.c);
    $$(".swatch", el).forEach((s) => {
      s.classList.toggle("on", s === b);
      s.innerHTML = s === b ? icon("check") : "";
    });
  });
  return el;
}

function labelMenu(note, onChange) {
  const el = h(`<div class="labelmenu">
    <div class="menu-title">Label note</div>
    <input type="text" placeholder="Enter label name" maxlength="50" aria-label="Label name">
    <div class="lm-list"></div></div>`);
  const input = $("input", el);
  const list = $(".lm-list", el);
  const draw = () => {
    const q = input.value.trim();
    const labels = [...new Set([...allLabels(), ...note.labels])].filter((l) => l.toLowerCase().includes(q.toLowerCase()));
    const exact = labels.some((l) => l.toLowerCase() === q.toLowerCase());
    list.innerHTML = labels.map((l) => `<label class="lm-row"><input type="checkbox" value="${esc(l)}" ${note.labels.includes(l) ? "checked" : ""}> <span>${esc(l)}</span></label>`).join("")
      + (q && !exact ? `<button type="button" class="lm-create">${icon("add")} Create "${esc(q)}"</button>` : "");
  };
  const create = () => {
    const q = input.value.trim();
    if (!q || note.labels.includes(q)) return;
    note.labels = [...note.labels, q];
    input.value = "";
    onChange();
    draw();
  };
  list.addEventListener("change", (e) => {
    const v = e.target.value;
    note.labels = e.target.checked ? [...note.labels, v] : note.labels.filter((l) => l !== v);
    onChange();
  });
  list.addEventListener("click", (e) => e.target.closest(".lm-create") && create());
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      create();
    }
  });
  draw();
  return el;
}

function actionsMenu(items) {
  const el = h(`<div class="actions">${items.map((it, i) => `<button type="button" data-i="${i}">${esc(it.label)}</button>`).join("")}</div>`);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].run();
  });
  return el;
}

// ---------- note operations ----------
async function update(note, changes, { touch = true } = {}) {
  const next = { ...note, ...changes, ...(touch ? { updated: nowIso() } : {}) };
  await store.save(next);
  store.flushSoon();
  return next;
}

async function setArchived(note, archived) {
  await update(note, { archived, pinned: false });
  toast(archived ? "Note archived" : "Note unarchived", { label: "Undo", run: () => update(note, { archived: note.archived, pinned: note.pinned }) });
}

async function trash(note) {
  await update(note, { trashed: nowIso(), pinned: false }, { touch: false });
  toast("Note moved to trash", { label: "Undo", run: () => update(note, { trashed: null, pinned: note.pinned }, { touch: false }) });
}

async function restore(note) {
  await update(note, { trashed: null }, { touch: false });
  toast("Note restored");
}

async function deleteForever(note) {
  if (!confirm("Delete this note forever?")) return false;
  await store.deleteForever(note);
  store.flushSoon();
  return true;
}

async function copyNote(note) {
  const id = newId();
  const now = nowIso();
  const copy = { ...structuredClone(note), id, path: pathFor(id), created: now, updated: now, pinned: false, images: [], pending: false };
  await store.save(copy);
  store.flushSoon();
  toast("Note copied");
}

function noteMenuItems(note, after = () => {}) {
  if (note.trashed) {
    return [
      { label: "Restore", run: async () => { await restore(note); after(); } },
      { label: "Delete forever", run: async () => { if (await deleteForever(note)) after(true); } },
    ];
  }
  return [
    { label: "Delete note", run: async () => { await trash(note); after(true); } },
    { label: "Make a copy", run: () => copyNote(note) },
    {
      label: note.type === "checklist" ? "Hide checkboxes" : "Show checkboxes",
      run: async () => { await update(note, note.type === "checklist" ? toText(note) : toChecklist(note)); after(); },
    },
  ];
}

// ---------- layout ----------
function renderNav() {
  const r = route();
  const labels = allLabels();
  const item = (href, ic, text, on) => `<a href="${href}" class="nav-item${on ? " on" : ""}">${icon(ic)}<span>${esc(text)}</span></a>`;
  $("#nav").innerHTML = [
    item("#/", "bulb", "Notes", r.kind === "notes"),
    ...labels.map((l) => item(`#/label/${encodeURIComponent(l)}`, "label", l, r.kind === "label" && r.label === l)),
    `<button type="button" class="nav-item" id="edit-labels">${icon("edit")}<span>Edit labels</span></button>`,
    item("#/archive", "archive", "Archive", r.kind === "archive"),
    item("#/trash", "trash", "Trash", r.kind === "trash"),
    item("#/settings", "settings", "Settings", r.kind === "settings"),
  ].join("");
  $("#edit-labels").onclick = editLabels;
  document.body.classList.toggle("nav-open", ui.navOpen);
}

function renderSyncButton() {
  const btn = $("#sync-btn");
  const pend = store.pending();
  const errors = pend.filter((p) => p.error).length;
  let ic = "cloudDone";
  let title = store.status.lastSync ? `Synced ${fmtEdited(store.status.lastSync)}. Tap to refresh.` : "Tap to sync";
  btn.classList.toggle("spin", store.status.syncing);
  btn.classList.toggle("warn", Boolean(errors || store.status.error));
  if (store.status.syncing) {
    ic = "refresh";
    title = "Syncing…";
  } else if (store.status.error || errors) {
    ic = "warn";
    title = store.status.error || `${errors} change(s) couldn't be saved. See Settings.`;
  } else if (pend.length) {
    ic = "cloudOff";
    title = `${pend.length} change(s) waiting to sync`;
  }
  btn.innerHTML = icon(ic);
  btn.title = title;
  btn.setAttribute("aria-label", title);
}

function render() {
  if (menuEl && !menuEl.closest("dialog")) closeMenu();
  renderNav();
  renderSyncButton();
  const r = route();
  $("#layout-btn").innerHTML = icon(ui.layout === "grid" ? "list" : "grid");
  $("#layout-btn").title = ui.layout === "grid" ? "List view" : "Grid view";
  const view = $("#view");
  if (r.kind === "settings") return renderSettings(view);
  if (!gh.isConfigured() && !store.notes.size) return renderWelcome(view);
  renderNotes(view, r);
}

function renderWelcome(view) {
  view.innerHTML = `<section class="empty">
    ${icon("bulb", "big")}
    <h2>Welcome to Keep</h2>
    <p>Your notes are saved as files in your private GitHub repository, where Claude can read and edit them too.</p>
    <p><a class="btn primary" href="#/settings">Connect your repository</a></p></section>`;
}

function renderNotes(view, r) {
  const q = ui.query.trim();
  let list = [...store.notes.values()];
  let emptyText;
  if (q) {
    list = list.filter((n) => !n.trashed && matches(n, q));
    emptyText = "No matching notes";
  } else if (r.kind === "archive") {
    list = list.filter((n) => n.archived && !n.trashed);
    emptyText = "Your archived notes appear here";
  } else if (r.kind === "trash") {
    list = list.filter((n) => n.trashed);
    emptyText = "No notes in Trash";
  } else if (r.kind === "label") {
    list = list.filter((n) => !n.trashed && n.labels.includes(r.label));
    emptyText = "No notes with this label yet";
  } else {
    list = list.filter((n) => !n.archived && !n.trashed);
    emptyText = "Notes you add appear here";
  }
  list.sort(byCreated);

  view.innerHTML = "";
  view.className = `layout-${ui.layout}`;
  if (!q && (r.kind === "notes" || r.kind === "label")) view.append(composer(r));
  if (r.kind === "trash" && !q) {
    const bar = h(`<div class="trash-bar"><span>Notes in Trash are deleted after ${TRASH_DAYS} days.</span>
      ${list.length ? `<button type="button" class="btn text">Empty Trash</button>` : ""}</div>`);
    $("button", bar)?.addEventListener("click", emptyTrash);
    view.append(bar);
  }
  if (!list.length) {
    view.append(h(`<section class="empty">${icon(r.kind === "trash" ? "trash" : r.kind === "archive" ? "archive" : q ? "search" : "bulb", "big")}<p>${esc(emptyText)}</p></section>`));
    return;
  }
  const pinned = r.kind === "trash" ? [] : list.filter((n) => n.pinned);
  const others = list.filter((n) => !pinned.includes(n));
  if (pinned.length) {
    view.append(h(`<h3 class="section">Pinned</h3>`));
    view.append(masonry(pinned));
    if (others.length) view.append(h(`<h3 class="section">Others</h3>`));
  }
  if (others.length) view.append(masonry(others));
  $$(".masonry", view).forEach(layoutMasonry);
}

function composer(r) {
  const el = h(`<div class="composer">
    <button type="button" class="composer-text" data-new="text">Take a note…</button>
    <button type="button" class="icon-btn" data-new="checklist" title="New list" aria-label="New list">${icon("checklist")}</button>
    <button type="button" class="icon-btn" data-new="image" title="New note with image" aria-label="New note with image">${icon("image")}</button>
  </div>`);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-new]");
    if (!b) return;
    const note = blankNote(b.dataset.new === "checklist" ? "checklist" : "text");
    if (r.kind === "label") note.labels = [r.label];
    openEditor(note, { isNew: true, pickImage: b.dataset.new === "image" });
  });
  return el;
}

// Cards go into whichever column is shortest, so the grid reads left to right like Keep.
const masonries = new Set();
function masonry(notes) {
  const wrap = h(`<div class="masonry"></div>`);
  wrap._cards = notes.map(card);
  masonries.add(wrap);
  return wrap;
}
function layoutMasonry(wrap) {
  if (!wrap.isConnected) return masonries.delete(wrap);
  const width = wrap.clientWidth;
  const n = ui.layout === "list" ? 1 : Math.max(1, Math.min(6, Math.floor((width + 16) / (240 + 16))));
  if (wrap._n === n && wrap.childElementCount) return;
  wrap._n = n;
  wrap.innerHTML = "";
  const cols = Array.from({ length: n }, () => wrap.appendChild(h(`<div class="col"></div>`)));
  for (const c of wrap._cards) {
    const shortest = cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    shortest.append(c);
  }
}
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => masonries.forEach(layoutMasonry), 100);
});

function checklistPreview(note) {
  const open = note.items.filter((i) => !i.checked);
  const done = note.items.length - open.length;
  const shown = open.slice(0, 10);
  return `<ul class="card-list">${shown.map((i) => `<li class="${i.indent ? "indent" : ""}">${icon("boxEmpty")}<span>${linkify(i.text)}</span></li>`).join("")}</ul>`
    + (open.length > shown.length ? `<div class="card-more">…</div>` : "")
    + (done ? `<div class="card-more">+ ${done} checked item${done > 1 ? "s" : ""}</div>` : "");
}

function card(note) {
  const t = note.trashed;
  const el = h(`<article class="card c-${note.color}" tabindex="0" data-id="${esc(note.id)}">
    ${note.images.length ? `<div class="card-imgs n${Math.min(note.images.length, 3)}">${note.images.slice(0, 3).map((p) => `<img alt="" data-src="${esc(p)}">`).join("")}</div>` : ""}
    ${t ? "" : `<button type="button" class="pin icon-btn${note.pinned ? " on" : ""}" title="${note.pinned ? "Unpin" : "Pin"} note" aria-label="${note.pinned ? "Unpin" : "Pin"} note">${icon(note.pinned ? "pinned" : "pin")}</button>`}
    ${note.title ? `<h4 class="card-title">${esc(note.title)}</h4>` : ""}
    ${note.type === "checklist" ? checklistPreview(note) : note.body ? `<div class="card-body">${linkify(note.body)}</div>` : ""}
    ${isEmpty(note) ? `<div class="card-body muted">Empty note</div>` : ""}
    ${note.labels.length ? `<div class="chips">${note.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</div>` : ""}
    ${note.pending ? `<span class="pending-dot" title="${esc(note.syncError || "Waiting to sync")}"></span>` : ""}
    <div class="card-tools">
      ${t
        ? `<button type="button" class="icon-btn" data-act="deleteForever" title="Delete forever" aria-label="Delete forever">${icon("deleteForever")}</button>
           <button type="button" class="icon-btn" data-act="restore" title="Restore" aria-label="Restore">${icon("restore")}</button>`
        : `<button type="button" class="icon-btn" data-act="color" data-menu title="Background options" aria-label="Background options">${icon("palette")}</button>
           <button type="button" class="icon-btn" data-act="label" data-menu title="Labels" aria-label="Labels">${icon("label")}</button>
           <button type="button" class="icon-btn" data-act="archive" title="${note.archived ? "Unarchive" : "Archive"}" aria-label="${note.archived ? "Unarchive" : "Archive"}">${icon(note.archived ? "unarchive" : "archive")}</button>
           <button type="button" class="icon-btn" data-act="more" data-menu title="More" aria-label="More">${icon("more")}</button>`}
    </div></article>`);
  $$("img[data-src]", el).forEach((img) => store.imageUrl(img.dataset.src).then((u) => (img.src = u)).catch(() => img.remove()));
  el.addEventListener("click", async (e) => {
    if (e.target.closest("a")) return;
    const b = e.target.closest("button");
    let n = store.notes.get(note.id) || note;
    if (!b) return openEditor(n);
    e.stopPropagation();
    if (b.classList.contains("pin")) return update(n, { pinned: !n.pinned, archived: false });
    const act = b.dataset.act;
    if (act === "restore") return restore(n);
    if (act === "deleteForever") return deleteForever(n);
    if (act === "archive") return setArchived(n, !n.archived);
    if (act === "color") {
      return openMenu(b, colorMenu(n.color, async (c) => { n = await update(n, { color: c }, { touch: false }); }));
    }
    if (act === "label") {
      const working = { ...n };
      return openMenu(b, labelMenu(working, async () => { await update(n, { labels: working.labels }, { touch: false }); }));
    }
    if (act === "more") return openMenu(b, actionsMenu(noteMenuItems(n)));
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === el) openEditor(store.notes.get(note.id) || note);
  });
  return el;
}

async function emptyTrash() {
  const list = [...store.notes.values()].filter((n) => n.trashed);
  if (!list.length || !confirm(`Delete ${list.length} note${list.length > 1 ? "s" : ""} in Trash forever?`)) return;
  for (const n of list) await store.deleteForever(n);
  store.flushSoon(500);
  toast("Trash emptied");
}

function editLabels() {
  const dlg = h(`<dialog class="labels-dialog"><form method="dialog">
    <h3>Edit labels</h3><div class="el-list"></div>
    <p class="hint">Labels are created from a note's label menu. Renaming or deleting one updates every note that has it.</p>
    <div class="right"><button class="btn text" value="close">Done</button></div></form></dialog>`);
  const listEl = $(".el-list", dlg);
  const draw = () => {
    listEl.innerHTML = allLabels().map((l) => `<div class="el-row" data-l="${esc(l)}">
      <button type="button" class="icon-btn" data-del title="Delete label" aria-label="Delete label ${esc(l)}">${icon("trash")}</button>
      <input type="text" value="${esc(l)}" maxlength="50" aria-label="Label name">
      </div>`).join("") || `<p class="muted">No labels yet.</p>`;
  };
  const affected = (l) => [...store.notes.values()].filter((n) => n.labels.includes(l));
  listEl.addEventListener("click", async (e) => {
    const row = e.target.closest(".el-row");
    if (!row || !e.target.closest("[data-del]")) return;
    const l = row.dataset.l;
    if (!confirm(`Delete label "${l}"? Notes keep their content.`)) return;
    for (const n of affected(l)) await update(n, { labels: n.labels.filter((x) => x !== l) }, { touch: false });
    draw();
  });
  listEl.addEventListener("change", async (e) => {
    const row = e.target.closest(".el-row");
    const from = row.dataset.l;
    const to = e.target.value.trim();
    if (!to || to === from) return draw();
    for (const n of affected(from)) {
      await update(n, { labels: [...new Set(n.labels.map((x) => (x === from ? to : x)))] }, { touch: false });
    }
    if (route().kind === "label" && route().label === from) location.hash = `#/label/${encodeURIComponent(to)}`;
    draw();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  draw();
  dlg.showModal();
}

// ---------- editor ----------
let ed = null; // {note, isNew, dlg, saveTimer}

function openEditor(note, { isNew = false, pickImage = false } = {}) {
  if (ed) closeEditor();
  const dlg = $("#editor");
  ed = { note: structuredClone(note), isNew, dlg, saveTimer: null, opening: true };
  dlg.className = `editor c-${ed.note.color}`;
  drawEditor();
  dlg.showModal();
  $$("textarea", dlg).forEach(autosize); // sizes are only known once the dialog is visible
  history.pushState({ editor: true }, "");
  if (isNew) $(".ed-title", dlg)?.focus();
  if (pickImage) $("#ed-file", dlg)?.click();
}

function editorChanged({ touch = true, redraw = false } = {}) {
  if (!ed) return;
  if (touch) ed.note.updated = nowIso();
  ed.dirty = true;
  if (redraw) drawEditor();
  clearTimeout(ed.saveTimer);
  const note = ed.note;
  ed.saveTimer = setTimeout(() => saveEditor(note), 400);
}

async function saveEditor(note) {
  if (isEmpty(note) && !store.notes.has(note.id)) return; // a new note isn't saved until it has content
  await store.save(structuredClone(note));
}

async function closeEditor({ fromHistory = false } = {}) {
  if (!ed) return;
  const { note, dlg, dirty, isNew } = ed;
  clearTimeout(ed.saveTimer);
  ed = null;
  closeMenu();
  if (dlg.open) dlg.close();
  if (!fromHistory && history.state?.editor) history.back();
  if (dirty) {
    if (isNew && isEmpty(note)) {
      // Started a new note, then cleared it: drop it.
      const existing = store.notes.get(note.id);
      if (existing) await store.deleteForever(existing);
    } else {
      await saveEditor(note);
    }
  }
  store.flushSoon(1500);
}

window.addEventListener("popstate", () => {
  if (ed) closeEditor({ fromHistory: true });
});

function drawEditor() {
  const { note, dlg } = ed;
  const t = Boolean(note.trashed);
  dlg.className = `editor c-${note.color}`;
  dlg.innerHTML = `
    <div class="ed-scroll">
      ${note.images.length ? `<div class="ed-imgs">${note.images.map((p) => `<figure><img alt="" data-src="${esc(p)}">${t ? "" : `<button type="button" class="icon-btn img-del" data-path="${esc(p)}" title="Remove image" aria-label="Remove image">${icon("trash")}</button>`}</figure>`).join("")}</div>` : ""}
      ${note.error ? `<p class="ed-warn">${icon("warn")} ${esc(note.error)}. The whole file is shown below; saving keeps it.</p>` : ""}
      ${t ? `<p class="ed-warn">Can't edit in Trash.</p>` : ""}
      <div class="ed-head">
        <textarea class="ed-title" rows="1" placeholder="Title" aria-label="Title" ${t ? "readonly" : ""}>${esc(note.title)}</textarea>
        ${t ? "" : `<button type="button" class="icon-btn pin${note.pinned ? " on" : ""}" data-act="pin" title="${note.pinned ? "Unpin" : "Pin"} note" aria-label="${note.pinned ? "Unpin" : "Pin"} note">${icon(note.pinned ? "pinned" : "pin")}</button>`}
      </div>
      ${note.type === "checklist" ? `<div class="ed-list"></div>` : `<textarea class="ed-body" placeholder="Take a note…" aria-label="Note" ${t ? "readonly" : ""}>${esc(note.body)}</textarea>`}
      <div class="chips ed-chips">${editorChips(note)}</div>
      <div class="ed-edited">${note.updated ? `Edited ${esc(fmtEdited(note.updated))}` : ""}</div>
    </div>
    <div class="ed-bar">
      ${t
        ? `<button type="button" class="icon-btn" data-act="deleteForever" title="Delete forever" aria-label="Delete forever">${icon("deleteForever")}</button>
           <button type="button" class="icon-btn" data-act="restore" title="Restore" aria-label="Restore">${icon("restore")}</button>`
        : `<button type="button" class="icon-btn" data-act="color" data-menu title="Background options" aria-label="Background options">${icon("palette")}</button>
           <button type="button" class="icon-btn" data-act="image" title="Add image" aria-label="Add image">${icon("image")}</button>
           <button type="button" class="icon-btn" data-act="label" data-menu title="Labels" aria-label="Labels">${icon("label")}</button>
           <button type="button" class="icon-btn" data-act="archive" title="${note.archived ? "Unarchive" : "Archive"}" aria-label="${note.archived ? "Unarchive" : "Archive"}">${icon(note.archived ? "unarchive" : "archive")}</button>
           <button type="button" class="icon-btn" data-act="more" data-menu title="More" aria-label="More">${icon("more")}</button>`}
      <span class="grow"></span>
      <button type="button" class="btn text" data-act="close">Close</button>
      <input type="file" id="ed-file" accept="image/*" multiple hidden>
    </div>`;
  $$("img[data-src]", dlg).forEach((img) => store.imageUrl(img.dataset.src).then((u) => (img.src = u)).catch(() => {}));
  const title = $(".ed-title", dlg);
  autosize(title);
  title.addEventListener("input", () => { note.title = title.value.replace(/\n/g, " "); autosize(title); editorChanged(); });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (note.type === "checklist" ? $(".ed-list .item-text, .ed-list .add-text", dlg) : $(".ed-body", dlg))?.focus();
    }
  });
  const body = $(".ed-body", dlg);
  if (body) {
    autosize(body);
    body.addEventListener("input", () => { note.body = body.value; autosize(body); editorChanged(); });
  }
  if (note.type === "checklist") drawChecklist();
  dlg.onclick = editorClick;
  $("#ed-file", dlg).onchange = (e) => addImages([...e.target.files]);
}

function editorChips(note) {
  const t = Boolean(note.trashed);
  return note.labels.map((l) => `<span class="chip">${esc(l)}${t ? "" : `<button type="button" data-unlabel="${esc(l)}" aria-label="Remove label ${esc(l)}">${icon("close")}</button>`}</span>`).join("");
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

async function editorClick(e) {
  if (!ed) return;
  const { note } = ed;
  if (e.target === ed.dlg) return closeEditor(); // backdrop
  const un = e.target.closest("[data-unlabel]");
  if (un) {
    note.labels = note.labels.filter((l) => l !== un.dataset.unlabel);
    $(".ed-chips", ed.dlg).innerHTML = editorChips(note);
    return editorChanged({ touch: false });
  }
  const del = e.target.closest(".img-del");
  if (del) {
    const p = del.dataset.path;
    note.images = note.images.filter((x) => x !== p);
    await store.removeImage(note, p);
    return editorChanged({ redraw: true });
  }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  switch (b.dataset.act) {
    case "close":
      return closeEditor();
    case "pin":
      note.pinned = !note.pinned;
      if (note.pinned) note.archived = false;
      return editorChanged({ touch: false, redraw: true });
    case "color":
      return openMenu(b, colorMenu(note.color, (c) => {
        note.color = c;
        ed.dlg.className = `editor c-${c}`;
        editorChanged({ touch: false });
      }));
    case "label":
      return openMenu(b, labelMenu(note, () => {
        editorChanged({ touch: false });
        $(".ed-chips", ed.dlg).innerHTML = editorChips(note);
      }));
    case "image":
      return $("#ed-file", ed.dlg).click();
    case "archive": {
      const archived = !note.archived;
      note.archived = archived;
      note.pinned = false;
      editorChanged({ touch: false });
      const snapshot = structuredClone(note);
      await closeEditor();
      return toast(archived ? "Note archived" : "Note unarchived", {
        label: "Undo", run: () => update(snapshot, { archived: !archived }, { touch: false }),
      });
    }
    case "restore":
      note.trashed = null;
      editorChanged({ touch: false });
      await closeEditor();
      return toast("Note restored");
    case "deleteForever": {
      const n = store.notes.get(note.id);
      if (n && (await deleteForever(n))) {
        ed.dirty = false;
        closeEditor();
      }
      return;
    }
    case "more":
      return openMenu(b, actionsMenu(editorMenuItems()));
  }
}

function editorMenuItems() {
  const { note } = ed;
  return [
    {
      label: "Delete note",
      run: async () => {
        note.trashed = nowIso();
        note.pinned = false;
        editorChanged({ touch: false });
        const snapshot = structuredClone(note);
        await closeEditor();
        toast("Note moved to trash", { label: "Undo", run: () => update(snapshot, { trashed: null }, { touch: false }) });
      },
    },
    {
      label: "Make a copy",
      run: async () => {
        await saveEditor(note);
        await copyNote(note);
      },
    },
    {
      label: note.type === "checklist" ? "Hide checkboxes" : "Show checkboxes",
      run: () => {
        ed.note = note.type === "checklist" ? toText(note) : toChecklist(note);
        editorChanged({ redraw: true });
      },
    },
  ];
}

async function addImages(files) {
  if (!ed || !files.length) return;
  const note = ed.note;
  for (const f of files) {
    try {
      const blob = await shrink(f);
      const path = await store.addImage(note, blob);
      note.images = [...note.images, path];
    } catch (e) {
      toast(`Couldn't add image: ${e.message}`);
    }
  }
  if (ed?.note === note) editorChanged({ redraw: true });
  else await store.save(structuredClone(note));
}

async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("unsupported image"))), "image/jpeg", 0.85));
}

// Checklist editing. Items keep their order in the file; checked ones are shown below.
function drawChecklist(focus) {
  const { note, dlg } = ed;
  const wrap = $(".ed-list", dlg);
  const t = Boolean(note.trashed);
  const row = (it, i) => `<div class="item${it.indent ? " indent" : ""}${it.checked ? " checked" : ""}" data-i="${i}">
      <button type="button" class="icon-btn box" role="checkbox" aria-checked="${it.checked}" aria-label="Done" ${t ? "disabled" : ""}>${icon(it.checked ? "boxChecked" : "boxEmpty")}</button>
      <textarea class="item-text" rows="1" aria-label="List item" ${t ? "readonly" : ""}>${esc(it.text)}</textarea>
      ${t ? "" : `<button type="button" class="icon-btn item-del" title="Delete" aria-label="Delete item">${icon("close")}</button>`}
    </div>`;
  const open = note.items.map((it, i) => [it, i]).filter(([it]) => !it.checked);
  const done = note.items.map((it, i) => [it, i]).filter(([it]) => it.checked);
  ed.showDone ??= true;
  wrap.innerHTML = open.map(([it, i]) => row(it, i)).join("")
    + (t ? "" : `<div class="item add">${icon("add")}<textarea class="add-text" rows="1" placeholder="List item" aria-label="Add list item"></textarea></div>`)
    + (done.length ? `<button type="button" class="done-toggle${ed.showDone ? " open" : ""}">${icon("expand")} ${done.length} completed item${done.length > 1 ? "s" : ""}</button>
      ${ed.showDone ? done.map(([it, i]) => row(it, i)).join("") : ""}` : "");
  $$("textarea", wrap).forEach(autosize);
  if (focus) {
    const target = focus.add ? $(".add-text", wrap) : $(`.item[data-i="${focus.i}"] .item-text`, wrap);
    if (target) {
      target.focus();
      const pos = focus.pos ?? target.value.length;
      target.setSelectionRange(pos, pos);
    }
  }
  wrap.oninput = (e) => {
    const ta = e.target;
    autosize(ta);
    if (ta.classList.contains("add-text")) {
      const lines = ta.value.split("\n").filter((l) => l.trim());
      if (!lines.length) return;
      for (const l of lines) note.items.push({ text: l.trim(), checked: false, indent: 0 });
      editorChanged();
      return drawChecklist({ i: note.items.length - 1 });
    }
    const i = +ta.closest(".item").dataset.i;
    if (ta.value.includes("\n")) {
      // Pasted several lines: one item each.
      const [first, ...rest] = ta.value.split("\n");
      note.items[i].text = first;
      note.items.splice(i + 1, 0, ...rest.filter((l) => l.trim()).map((l) => ({ text: l.trim(), checked: false, indent: note.items[i].indent })));
      editorChanged();
      return drawChecklist({ i: i + rest.length });
    }
    note.items[i].text = ta.value;
    editorChanged();
  };
  wrap.onkeydown = (e) => {
    const ta = e.target.closest(".item-text");
    if (!ta) return;
    const i = +ta.closest(".item").dataset.i;
    const it = note.items[i];
    if (e.key === "Enter") {
      e.preventDefault();
      const pos = ta.selectionStart;
      const tail = it.text.slice(pos);
      it.text = it.text.slice(0, pos);
      note.items.splice(i + 1, 0, { text: tail, checked: it.checked, indent: it.indent });
      editorChanged();
      drawChecklist({ i: i + 1, pos: 0 });
    } else if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault();
      if (it.indent) {
        it.indent = 0;
        editorChanged();
        return drawChecklist({ i, pos: 0 });
      }
      const prev = findPrev(i, it.checked);
      if (prev < 0 && it.text) return;
      note.items.splice(i, 1);
      if (prev >= 0) {
        const p = note.items[prev];
        const pos = p.text.length;
        p.text += it.text;
        editorChanged();
        drawChecklist({ i: prev, pos });
      } else {
        editorChanged();
        drawChecklist({ add: true });
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      it.indent = e.shiftKey || findPrev(i, it.checked) < 0 ? 0 : 1;
      editorChanged();
      drawChecklist({ i, pos: ta.selectionStart });
    }
  };
  wrap.onclick = (e) => {
    if (e.target.closest(".done-toggle")) {
      ed.showDone = !ed.showDone;
      return drawChecklist();
    }
    const itemEl = e.target.closest(".item[data-i]");
    if (!itemEl) return;
    const i = +itemEl.dataset.i;
    if (e.target.closest(".box")) {
      const checked = !note.items[i].checked;
      note.items[i].checked = checked;
      // Checking a parent item checks its sub-items too.
      if (!note.items[i].indent) for (let j = i + 1; j < note.items.length && note.items[j].indent; j++) note.items[j].checked = checked;
      editorChanged();
      return drawChecklist();
    }
    if (e.target.closest(".item-del")) {
      note.items.splice(i, 1);
      editorChanged();
      return drawChecklist();
    }
  };
}

function findPrev(i, checked) {
  const items = ed.note.items;
  for (let j = i - 1; j >= 0; j--) if (items[j].checked === checked) return j;
  return -1;
}

// ---------- settings ----------
function renderSettings(view) {
  const s = gh.loadSettings();
  const pend = store.pending();
  view.className = "settings";
  view.innerHTML = `
    <h2>Settings</h2>
    <form id="settings-form" class="panel">
      <h3>GitHub repository</h3>
      <p class="hint">Notes are Markdown files in <code>notes/</code> of this repo. Keep it private.</p>
      <div class="row2">
        <label>Owner<input name="owner" value="${esc(s.owner)}" autocomplete="off" required></label>
        <label>Repository<input name="repo" value="${esc(s.repo)}" autocomplete="off" required></label>
      </div>
      <label>Branch <span class="muted">(blank = default branch)</span><input name="branch" value="${esc(s.branch)}" autocomplete="off"></label>
      <label>Access token<input name="token" type="password" value="${esc(s.token)}" autocomplete="off" placeholder="github_pat_…"></label>
      <p class="hint">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
        for only this repository with <strong>Contents: Read and write</strong>. It is stored only in this browser.</p>
      <div class="right"><button class="btn primary" type="submit">Save &amp; test</button></div>
      <p id="settings-msg" class="hint" role="status"></p>
    </form>
    <section class="panel">
      <h3>Sync</h3>
      <p class="hint">${store.status.lastSync ? `Last synced ${esc(fmtEdited(store.status.lastSync))}.` : "Not synced yet."}
        ${store.notes.size} notes. Changes made elsewhere (by Claude, or on another device) appear when you reopen the app or tap refresh.</p>
      <div class="btn-row">
        <button type="button" class="btn" id="reload">Reload from GitHub</button>
        <button type="button" class="btn" id="clear">Clear cached notes</button>
      </div>
      ${pend.length ? `<h3>Waiting to sync (${pend.length})</h3><ul class="pending">${pend.map((p) => `
        <li><div><code>${esc(p.path)}</code> <span class="muted">${p.kind === "delete" ? "delete" : p.kind === "blob" ? "image" : "edit"}</span>
          ${p.error ? `<div class="err">${esc(p.error)}</div>` : ""}</div>
          <span>${p.error ? `<button type="button" class="btn text" data-retry="${esc(p.path)}">Retry</button>` : ""}
          <button type="button" class="btn text" data-discard="${esc(p.path)}">Discard</button></span></li>`).join("")}</ul>` : ""}
    </section>
    <section class="panel">
      <h3>Shortcuts</h3>
      <p class="hint"><kbd>c</kbd> new note · <kbd>l</kbd> new list · <kbd>/</kbd> search · <kbd>Esc</kbd> close note</p>
      <p class="hint muted">Version ${APP_VERSION}</p>
    </section>`;
  $("#settings-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    gh.saveSettings({
      owner: f.get("owner").trim(), repo: f.get("repo").trim(),
      branch: f.get("branch").trim(), token: f.get("token").trim(),
    });
    const msg = $("#settings-msg");
    msg.textContent = "Testing…";
    try {
      const info = await gh.repoInfo();
      if (!info.permissions?.push) throw new Error("The token can read this repo but not write to it (needs Contents: Read and write).");
      msg.textContent = `Connected to ${info.full_name}${info.private ? "" : " — warning: this repo is PUBLIC, so anyone can read your notes"}.`;
      await store.flush();
      await store.refresh();
      toast("Connected");
    } catch (err) {
      msg.textContent = err.message;
    }
  };
  $("#reload").onclick = () => syncNow(true);
  $("#clear").onclick = async () => {
    if (!confirm("Clear cached notes? Changes waiting to sync are kept.")) return;
    store.clearCache();
    await syncNow(true);
  };
  view.onclick = async (e) => {
    const r = e.target.closest("[data-retry]");
    const d = e.target.closest("[data-discard]");
    if (r) await store.retry(r.dataset.retry);
    if (d && confirm("Discard this change? It hasn't been saved to GitHub.")) await store.discard(d.dataset.discard);
    if (r || d) render();
  };
}

// ---------- sync ----------
let lastRefresh = 0;
async function syncNow(loud = false) {
  if (!gh.isConfigured()) {
    if (loud) toast("Add your GitHub token in Settings first.");
    return;
  }
  try {
    await store.flush();
    await store.refresh();
    lastRefresh = Date.now();
    if (loud) toast("Up to date");
  } catch (e) {
    toast(e.message);
  }
}

store.subscribe((what) => {
  if (what === "status") return renderSyncButton();
  if (what?.conflict) return toast(what.conflict.endsWith(".") ? what.conflict : `Changed elsewhere too: your version was saved as "${what.conflict}".`);
  if (what === "notes") {
    // Don't redraw underneath an open note or settings form being typed in.
    if (route().kind === "settings" && document.activeElement?.closest("#settings-form")) return renderSyncButton();
    render();
  }
});

// ---------- wiring ----------
function wire() {
  if (window.matchMedia("(max-width: 720px)").matches) ui.navOpen = false; // drawer starts closed on phones
  $("#menu-btn").innerHTML = icon("menu");
  $("#search-icon").innerHTML = icon("search");
  $("#search-clear").innerHTML = icon("close");
  $("#settings-btn").innerHTML = icon("settings");
  $("#menu-btn").onclick = () => {
    ui.navOpen = !ui.navOpen;
    setPref("navOpen", ui.navOpen);
    document.body.classList.toggle("nav-open", ui.navOpen);
  };
  $("#scrim").onclick = () => {
    ui.navOpen = false;
    document.body.classList.remove("nav-open");
  };
  $("#nav").addEventListener("click", (e) => {
    if (e.target.closest("a") && window.matchMedia("(max-width: 720px)").matches) {
      ui.navOpen = false;
      document.body.classList.remove("nav-open");
    }
  });
  $("#layout-btn").onclick = () => {
    ui.layout = ui.layout === "grid" ? "list" : "grid";
    setPref("layout", ui.layout);
    render();
  };
  $("#sync-btn").onclick = () => syncNow(true);
  const search = $("#search");
  search.addEventListener("input", () => {
    ui.query = search.value;
    document.body.classList.toggle("searching", Boolean(ui.query));
    if (route().kind === "settings") location.hash = "#/";
    else render();
  });
  $("#search-clear").onclick = () => {
    search.value = "";
    ui.query = "";
    document.body.classList.remove("searching");
    render();
  };
  window.addEventListener("hashchange", () => {
    if (ed) closeEditor({ fromHistory: true });
    render();
    $("#view").focus({ preventScroll: true });
  });
  $("#editor").addEventListener("cancel", (e) => {
    e.preventDefault();
    if (menuEl) return closeMenu();
    closeEditor();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuEl) {
      closeMenu();
      e.preventDefault();
      return;
    }
    if (ed || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, textarea, select, dialog")) return;
    if (e.key === "/") {
      e.preventDefault();
      search.focus();
    } else if (e.key === "c" || e.key === "l") {
      const r = route();
      if (r.kind === "settings" || r.kind === "trash" || r.kind === "archive") location.hash = "#/";
      const note = blankNote(e.key === "l" ? "checklist" : "text");
      if (r.kind === "label") note.labels = [r.label];
      e.preventDefault();
      openEditor(note, { isNew: true });
    }
  });
  window.addEventListener("online", () => syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") store.flush().catch(() => {});
    else if (Date.now() - lastRefresh > 30_000) syncNow();
  });
  setInterval(() => {
    if (document.visibilityState === "visible" && !ed) syncNow();
  }, 5 * 60_000);
}

async function main() {
  wire();
  await store.init();
  render();
  await syncNow();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

main();
