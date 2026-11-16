import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { nextRequestId } from './ids.ts';
import { createStore, type Store } from './store.ts';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleCreateRepo, handleRest } from './rest-repos.ts';
const store = createStore();
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string,string> = {}): void {
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'X-GitHub-Request-Id': nextRequestId() });
  res.end(text);
}
export type BodyResult = { ok: true; body: Buffer; overCap: false } | { ok: false; overCap: boolean };
/** Drains oversized bodies without retaining bytes or destroying keep-alive. */
export function readBody(req: IncomingMessage, cap = 1024 * 1024): Promise<BodyResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0, overCap = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) { overCap = true; chunks.length = 0; }
      else if (!overCap) chunks.push(chunk);
    });
    req.on('end', () => resolve(overCap ? { ok: false, overCap: true } : { ok: true, body: Buffer.concat(chunks), overCap: false }));
    req.on('error', () => resolve({ ok: false, overCap }));
    req.on('aborted', () => resolve({ ok: false, overCap }));
  });
}
async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  let path: string; let parsed: URL;
  try { parsed = new URL(req.url ?? '/', 'http://entry'); path = parsed.pathname; } catch { path = ''; parsed = new URL('http://entry/'); }
  const method = req.method ?? '';
  if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
  const ownerEnd = path.indexOf('/', 1);
  const repoEnd = path.indexOf('/', ownerEnd + 1);
  if (ownerEnd > 1 && repoEnd > ownerEnd + 1 && path.slice(ownerEnd + 1, repoEnd).endsWith('.git')) {
    await handleGit(req, res, store, decodeURIComponent(path.slice(1, ownerEnd)), decodeURIComponent(path.slice(ownerEnd + 1, repoEnd - 4))); return;
  } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return;
    }
    if (method === 'POST' && path === '/api/v3/user/repos') { await handleCreateRepo(req, res, store); return; }
    await handleRest(req, res, store, parsed); return;
  } else if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
    await handleGraphQL(req, res, store); return;
  } else if (path === '/mcp' || path.startsWith('/mcp/')) {
    // M7: MCP.
  }
  sendJson(res, 404, { message: 'Not Found' });
}
export function createApp(): Server {
  return createServer((req, res) => {
    req.on('error', () => {});
    void dispatch(req, res, store).catch(() => {
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, { message: 'Internal Server Error' });
    }).finally(() => { req.resume(); });
  });
}
