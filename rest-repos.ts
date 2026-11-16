import { handleIssues } from './rest-issues.ts';
import { handlePulls } from './rest-pulls.ts';
// The M3 create-repo shim is preserved below; M4 handlers follow it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth, OWNER_LOGIN } from './auth.ts';
import { createRepo, deleteRepo, listRepos, getObject, getRef, setRef, type Repo, type Store } from './store.ts';
import { readBody, sendJson } from './server.ts';
import { nextRequestId } from './ids.ts';
import { repoJson, requireAuth, requireRepo, readJson, decodePath, paginate, resolveCommit, readCommit, readFiles, readTreePath, directoryListing, isDirectory, putObject, commitFiles, walkCommits } from './rest.ts';

export async function handleCreateRepo(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (!checkAuth(req)) { sendJson(res, 401, { message: 'Unauthorized' }); return; }
  const read = await readBody(req);
  if (!read.ok) { sendJson(res, read.overCap ? 413 : 400, { message: read.overCap ? 'Request entity too large' : 'Invalid JSON' }); return; }
  let input: unknown;
  try { input = JSON.parse(read.body.toString()); }
  catch { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
  const fields = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (typeof fields.name !== 'string' || !fields.name.trim()) { sendJson(res, 422, { message: 'name is required' }); return; }
  const repo = createRepo(store, OWNER_LOGIN, fields.name, { private: fields.private === true, description: typeof fields.description === 'string' ? fields.description : '' });
  if (!repo) { sendJson(res, 422, { message: 'Repository already exists' }); return; }
  sendJson(res, 201, { id: repo.id, databaseId: repo.databaseId, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch, description: repo.description });
}

const notFound = (res: ServerResponse) => sendJson(res, 404, { message: 'Not Found' });
const invalid = (res: ServerResponse, message: string) => sendJson(res, 422, { message });

function validBranch(branch: string): boolean {
  return !!branch && !branch.startsWith('/') && !branch.endsWith('/') && !branch.includes('..') &&
    !branch.includes('@{') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
    branch.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

async function handleContents(req: IncomingMessage, res: ServerResponse, store: Store, repo: Repo, path: string, query: URLSearchParams): Promise<void> {
  if (path && path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) { invalid(res, 'Invalid path'); return; }
  if (req.method === 'GET') {
    const tip = resolveCommit(store, repo, query.get('ref') ?? repo.defaultBranch);
    if (!tip) { notFound(res); return; }
    const entry = readTreePath(store, readCommit(store, tip).tree, path);
    if (!entry) { notFound(res); return; }
    if (isDirectory(entry)) { sendJson(res, 200, directoryListing(store, entry.sha, path)); return; }
    const blob = getObject(store, entry.sha);
    if (!blob || blob.type !== 'blob') { notFound(res); return; }
    sendJson(res, 200, { type: 'file', encoding: 'base64', content: blob.raw.toString('base64'), sha: entry.sha, size: blob.raw.length });
    return;
  }
  if (req.method !== 'PUT' && req.method !== 'DELETE') { notFound(res); return; }
  const fields = await readJson(req, res, req.method === 'DELETE');
  if (!fields) return;
  if (!path) { invalid(res, 'path is required'); return; }
  if (req.method === 'DELETE' && typeof fields.sha !== 'string') { invalid(res, 'sha is required'); return; }
  if (typeof fields.message !== 'string') { invalid(res, 'message is required'); return; }
  if (fields.branch !== undefined && typeof fields.branch !== 'string') { invalid(res, 'Invalid branch'); return; }
  const branch = typeof fields.branch === 'string' ? fields.branch : repo.defaultBranch;
  if (!validBranch(branch)) { invalid(res, 'Invalid branch'); return; }
  // Resolve after the body has arrived, so simultaneous requests compare the latest sha.
  const tip = getRef(repo, `refs/heads/${branch}`);
  if (!tip && branch !== repo.defaultBranch) { notFound(res); return; }
  const modes = new Map<string, string>();
  const files = tip ? readFiles(store, readCommit(store, tip).tree, modes) : new Map<string, string>();
  const old = files.get(path);
  if (req.method === 'DELETE' && !old) { notFound(res); return; }
  if ((old !== undefined || fields.sha !== undefined) && fields.sha !== old) {
    sendJson(res, 409, { message: 'sha does not match' }); return;
  }
  if (req.method === 'DELETE') {
    files.delete(path);
    const sha = commitFiles(store, repo, branch, files, fields.message, modes);
    sendJson(res, 200, { commit: { sha } }); return;
  }
  if (typeof fields.content !== 'string') { invalid(res, 'content is required'); return; }
  for (const existing of files.keys()) {
    if (existing.startsWith(path + '/') || path.startsWith(existing + '/')) { invalid(res, 'File/directory conflict'); return; }
  }
  const contentSha = putObject(store, 'blob', Buffer.from(fields.content, 'base64'));
  files.set(path, contentSha);
  const sha = commitFiles(store, repo, branch, files, fields.message, modes);
  sendJson(res, old ? 200 : 201, { content: { sha: contentSha, encoding: 'base64' }, commit: { sha } });
}

/** The server parses the URL once; decoding preserves the contents-path remainder. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, url: URL): Promise<void> {
  const { pathname, searchParams } = url;
  if (req.method === 'GET' && pathname === '/api/v3/meta') { sendJson(res, 200, { installed_version: '1.0.0' }); return; }
  if (req.method === 'GET' && pathname === '/api/v3/user/repos') {
    if (!requireAuth(req, res)) return;
    const page = paginate(listRepos(store, OWNER_LOGIN), searchParams, req.headers.host ?? 'entry', pathname);
    sendJson(res, 200, page.items.map(repoJson), page.headers); return;
  }
  let segments: string[];
  try { segments = decodePath(pathname); }
  catch { sendJson(res, 400, { message: 'Invalid path' }); return; }
  if (segments[0] !== 'api' || segments[1] !== 'v3' || segments[2] !== 'repos' || !segments[3] || !segments[4]) { notFound(res); return; }
  const repo = requireRepo(req, res, store, segments[3], segments[4]);
  if (!repo) return;
  const tail = segments.slice(5);
  if (tail.length === 0) {
    if (req.method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (req.method === 'PATCH') {
      const fields = await readJson(req, res);
      if (!fields) return;
      if (typeof fields.description === 'string') repo.description = fields.description;
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (req.method === 'DELETE') {
      deleteRepo(store, repo.owner, repo.name);
      res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() }); res.end(); return;
    }
  }
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && req.method === 'POST') {
    const fields = await readJson(req, res);
    if (!fields) return;
    if (typeof fields.ref !== 'string' || !fields.ref.startsWith('refs/heads/') || !validBranch(fields.ref.slice(11)) ||
        typeof fields.sha !== 'string' || !/^[0-9a-f]{40}$/.test(fields.sha) || getObject(store, fields.sha)?.type !== 'commit') {
      invalid(res, 'Invalid ref'); return;
    }
    if (getRef(repo, fields.ref)) { invalid(res, 'Reference already exists'); return; }
    setRef(repo, fields.ref, fields.sha);
    sendJson(res, 201, { ref: fields.ref, object: { sha: fields.sha } }); return;
  }
  if (tail.length === 1 && tail[0] === 'branches' && req.method === 'GET') {
    sendJson(res, 200, [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } }))); return;
  }
  if (tail.length === 1 && tail[0] === 'commits' && req.method === 'GET') {
    const ref = searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveCommit(store, repo, ref);
    if (!tip && searchParams.has('sha')) { notFound(res); return; }
    sendJson(res, 200, tip ? walkCommits(store, tip).map(c => ({ sha: c.sha, commit: { message: c.message } })) : []); return;
  }
  if (tail[0] === 'contents') { await handleContents(req, res, store, repo, tail.slice(1).join('/'), searchParams); return; }
  if (tail.length === 1 && tail[0] === 'labels' && req.method === 'POST') { await handleIssues(req, res, repo, tail, url); return; }
  if (tail.length === 1 && tail[0] === 'issues') { await handleIssues(req, res, repo, tail, url); return; }
  if (tail.length === 2 && tail[0] === 'issues' && /^\d+$/.test(tail[1])) { await handleIssues(req, res, repo, tail, url); return; }
  if (tail.length === 3 && tail[0] === 'issues' && /^\d+$/.test(tail[1]) && tail[2] === 'comments') { await handleIssues(req, res, repo, tail, url); return; }
  if (tail.length === 1 && tail[0] === 'pulls') { await handlePulls(req, res, store, repo, tail, url); return; }
  if (tail.length === 2 && tail[0] === 'pulls' && /^\d+$/.test(tail[1])) { await handlePulls(req, res, store, repo, tail, url); return; }
  if (tail.length === 3 && tail[0] === 'pulls' && /^\d+$/.test(tail[1]) && tail[2] === 'files') { await handlePulls(req, res, store, repo, tail, url); return; }
  if (tail.length === 3 && tail[0] === 'pulls' && /^\d+$/.test(tail[1]) && tail[2] === 'merge') { await handlePulls(req, res, store, repo, tail, url); return; }
  notFound(res);
}
