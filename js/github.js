// Minimal GitHub client. Notes live in your private repo; this page only talks to
// api.github.com with the token saved in Settings (stored in this browser only).

const API = "https://api.github.com";
const SETTINGS_KEY = "keep:settings";
const DEFAULTS = { owner: "eason2561", repo: "Keep", branch: "", token: "" };

export class NetworkError extends Error {}
export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function isConfigured(s = loadSettings()) {
  return Boolean(s.token && s.owner && s.repo);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
export const textToBase64 = (text) => bytesToBase64(enc.encode(text));
export const base64ToText = (b64) =>
  dec.decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function request(url, { method = "GET", body, accept = "application/vnd.github+json", as = "json" } = {}) {
  const s = loadSettings();
  if (!isConfigured(s)) throw new GitHubError(0, "Add your GitHub token in Settings first.");
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError("Can't reach GitHub (offline?)");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).message || msg;
    } catch {}
    if (res.status === 401) msg = "GitHub rejected the token. Check Settings.";
    throw new GitHubError(res.status, msg);
  }
  if (res.status === 204) return null;
  if (as === "blob") return res.blob();
  return res.json();
}

const repoUrl = () => {
  const s = loadSettings();
  return `${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;
};
const contentUrl = (p, withRef = true) => {
  const b = loadSettings().branch;
  return `${repoUrl()}/contents/${p.split("/").map(encodeURIComponent).join("/")}${withRef && b ? `?ref=${encodeURIComponent(b)}` : ""}`;
};
const branchField = () => {
  const b = loadSettings().branch;
  return b ? { branch: b } : {};
};

export const repoInfo = () => request(repoUrl());

// Every file in a folder, with its text, in one GraphQL call.
// Returns [{path, sha, text}] (text is null for binary or very large files).
export async function loadFolder(folder) {
  const s = loadSettings();
  const query = `query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){
    object(expression:$expr){... on Tree{entries{path oid type object{... on Blob{text isTruncated isBinary}}}}}}}`;
  const j = await request(`${API}/graphql`, {
    method: "POST",
    body: { query, variables: { owner: s.owner, name: s.repo, expr: `${s.branch || "HEAD"}:${folder}` } },
  });
  if (j.errors?.length) {
    const msg = j.errors[0].message;
    throw new GitHubError(j.errors[0].type === "NOT_FOUND" ? 404 : 400, msg);
  }
  const tree = j.data?.repository?.object;
  if (j.data && !j.data.repository) throw new GitHubError(404, `Repository ${s.owner}/${s.repo} not found, or the token can't read it.`);
  if (!tree?.entries) return [];
  const out = [];
  for (const e of tree.entries) {
    if (e.type !== "blob") continue;
    const blob = e.object || {};
    let text = blob.isBinary ? null : blob.text;
    if (text != null && blob.isTruncated) text = (await getText(e.path)).text;
    out.push({ path: e.path, sha: e.oid, text });
  }
  return out;
}

export async function getText(path) {
  const j = await request(contentUrl(path));
  return { text: base64ToText(j.content), sha: j.sha };
}

export async function getSha(path) {
  try {
    return (await request(contentUrl(path))).sha;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

export const getBlob = (path) =>
  request(contentUrl(path), { accept: "application/vnd.github.raw+json", as: "blob" });

// Returns the new blob sha. A stale or missing sha raises GitHubError 409 / 422.
export async function putFile(path, base64, message, sha) {
  const body = { message, content: base64, ...(sha ? { sha } : {}), ...branchField() };
  const j = await request(contentUrl(path, false), { method: "PUT", body });
  return j.content.sha;
}

export async function deleteFile(path, sha, message) {
  await request(contentUrl(path, false), { method: "DELETE", body: { message, sha, ...branchField() } });
}
