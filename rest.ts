import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth, isOwner, OWNER_LOGIN } from './auth.ts';
import { timestampForCreation } from './clock.ts';
import { hashObject } from './objects.ts';
import { getObject, getRepo, getRef, putObjectRaw, setRef, type Repo, type Store } from './store.ts';
import { readBody, sendJson } from './server.ts';

export const repoJson = (r: Repo) => ({
  id: r.id, databaseId: r.databaseId, name: r.name, full_name: r.fullName,
  owner: { login: r.owner }, private: r.private, default_branch: r.defaultBranch, description: r.description,
});

export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (checkAuth(req)) return true;
  sendJson(res, 401, { message: 'Unauthorized' });
  return false;
}

export function requireRepo(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Repo | undefined {
  if (!requireAuth(req, res)) return;
  const repo = isOwner(owner) ? getRepo(store, owner, name) : undefined;
  if (!repo) sendJson(res, 404, { message: 'Not Found' });
  return repo;
}

/** Undefined means a response was sent; valid non-object JSON has no fields. */
export async function readJson(req: IncomingMessage, res: ServerResponse, allowEmpty = false): Promise<Record<string, unknown> | undefined> {
  const read = await readBody(req);
  if (!read.ok) {
    sendJson(res, read.overCap ? 413 : 400, { message: read.overCap ? 'Request entity too large' : 'Invalid JSON' });
    return;
  }
  try {
    const value: unknown = allowEmpty && read.body.length === 0 ? {} : JSON.parse(read.body.toString());
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { sendJson(res, 400, { message: 'Invalid JSON' }); }
}

export function decodePath(pathname: string): string[] {
  return pathname.split('/').slice(1).map(segment => decodeURIComponent(segment));
}

export function positiveInt(value: string | null, fallback: number): number {
  const n = value === null ? fallback : parseInt(value, 10);
  return Number.isSafeInteger(n) ? Math.max(1, n) : fallback;
}

export function paginate<T>(items: T[], query: URLSearchParams, host: string, pathname: string) {
  const perPage = positiveInt(query.get('per_page'), 30), page = positiveInt(query.get('page'), 1);
  const headers: Record<string, string> = {};
  if (page * perPage < items.length) {
    const next = new URL(pathname, `http://${host}`);
    next.search = query.toString();
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.Link = `<${next.href}>; rel="next"`;
  }
  return { items: items.slice((page - 1) * perPage, page * perPage), headers };
}

export function putObject(store: Store, type: string, raw: Buffer): string {
  const oid = hashObject(type, raw);
  putObjectRaw(store, oid, type, raw);
  return oid;
}

function objectRaw(store: Store, oid: string, type: string): Buffer {
  const object = getObject(store, oid);
  if (!object || object.type !== type) throw new Error(`Missing ${type} object`);
  return object.raw;
}

export interface TreeEntry { mode: string; name: string; sha: string }
export const isDirectory = (entry: TreeEntry) => entry.mode === '40000' || entry.mode === '040000';

export function parseTree(raw: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let offset = 0; offset < raw.length;) {
    const space = raw.indexOf(32, offset), nul = raw.indexOf(0, offset);
    if (space < offset || nul <= space || nul + 21 > raw.length) throw new Error('Invalid tree');
    entries.push({ mode: raw.subarray(offset, space).toString(), name: raw.subarray(space + 1, nul).toString(), sha: raw.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}

export function readTree(store: Store, oid: string): TreeEntry[] { return parseTree(objectRaw(store, oid, 'tree')); }

/** Git sorts a directory as its name followed by '/', using byte order. */
export function buildTree(store: Store, files: Map<string, string>, modes: Map<string, string> = new Map()): string {
  interface Directory { files: Map<string, TreeEntry>; dirs: Map<string, Directory> }
  const directory = (): Directory => ({ files: new Map(), dirs: new Map() });
  const root = directory();
  for (const [path, sha] of files) {
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\0')) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid file entry');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (node.files.has(part)) throw new Error('File/directory conflict');
      if (!node.dirs.has(part)) node.dirs.set(part, directory());
      node = node.dirs.get(part)!;
    }
    const name = parts[parts.length - 1];
    if (node.dirs.has(name)) throw new Error('File/directory conflict');
    node.files.set(name, { name, sha, mode: modes.get(path) ?? '100644' });
  }
  const build = (node: Directory): string => {
    const entries = [...node.files.values()];
    for (const [name, child] of node.dirs) entries.push({ name, sha: build(child), mode: '40000' });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (isDirectory(a) ? '/' : '')), Buffer.from(b.name + (isDirectory(b) ? '/' : ''))));
    return putObject(store, 'tree', Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
  };
  return build(root);
}

export interface Commit { tree: string; parents: string[]; message: string }
export function parseCommit(raw: Buffer): Commit {
  const text = raw.toString(), split = text.indexOf('\n\n');
  if (split < 0) throw new Error('Invalid commit');
  const headers = text.slice(0, split).split('\n');
  const tree = headers.find(line => line.startsWith('tree '))?.slice(5);
  if (!tree || !/^[0-9a-f]{40}$/.test(tree)) throw new Error('Invalid commit tree');
  return { tree, parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: text.slice(split + 2).replace(/\n$/, '') };
}

export function readCommit(store: Store, oid: string): Commit { return parseCommit(objectRaw(store, oid, 'commit')); }

export function buildCommit(store: Store, tree: string, parents: string[], message: string): string {
  const epoch = timestampForCreation().epoch;
  const identity = `${OWNER_LOGIN} <${OWNER_LOGIN}@example.invalid> ${epoch} +0000`;
  const raw = `tree ${tree}\n${parents.map(sha => `parent ${sha}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${message}\n`;
  return putObject(store, 'commit', Buffer.from(raw));
}

/** Tips are resolved against the shared refs so Git pushes are immediately visible. */
export function resolveCommit(store: Store, repo: Repo, ref = repo.defaultBranch): string | undefined {
  const oid = getRef(repo, `refs/heads/${ref}`) ?? getRef(repo, ref) ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : undefined);
  return oid && getObject(store, oid)?.type === 'commit' ? oid : undefined;
}

export function walkCommits(store: Store, tip: string): Array<Commit & { sha: string }> {
  const out: Array<Commit & { sha: string }> = [], pending = [tip], seen = new Set<string>();
  while (pending.length) {
    const sha = pending.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = readCommit(store, sha);
    out.push({ sha, ...commit });
    pending.push(...commit.parents.slice().reverse());
  }
  return out;
}

/** Optional mode map preserves executable files/symlinks received through Git. */
export function readFiles(store: Store, tree: string, modes: Map<string, string> = new Map()): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    for (const entry of readTree(store, oid)) {
      const path = prefix + entry.name;
      if (isDirectory(entry)) walk(entry.sha, path + '/');
      else { files.set(path, entry.sha); modes.set(path, entry.mode); }
    }
  };
  walk(tree, '');
  return files;
}

export function readTreePath(store: Store, tree: string, path: string): TreeEntry | undefined {
  let entry: TreeEntry = { mode: '40000', name: '', sha: tree };
  for (const name of path ? path.split('/') : []) {
    if (!isDirectory(entry)) return;
    const child = readTree(store, entry.sha).find(item => item.name === name);
    if (!child) return;
    entry = child;
  }
  return entry;
}

export function directoryListing(store: Store, tree: string, path: string) {
  return readTree(store, tree).map(e => ({ type: isDirectory(e) ? 'dir' : 'file', name: e.name, path: path ? `${path}/${e.name}` : e.name, sha: e.sha }));
}

/** Build objects first, then publish the new branch tip in one synchronous mutation. */
export function commitFiles(store: Store, repo: Repo, branch: string, files: Map<string, string>, message: string, modes = new Map<string, string>()): string {
  const parent = getRef(repo, `refs/heads/${branch}`);
  const tree = buildTree(store, files, modes);
  const sha = buildCommit(store, tree, parent ? [parent] : [], message);
  setRef(repo, `refs/heads/${branch}`, sha);
  return sha;
}
