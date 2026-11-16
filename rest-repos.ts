// M3 SHIM — M4 expands this file to the full repos table (list/get/patch/delete/branches/commits/contents).
// Only POST /user/repos is implemented here.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth, OWNER_LOGIN } from './auth.ts';
import { createRepo, type Store } from './store.ts';
import { readBody, sendJson } from './server.ts';

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
