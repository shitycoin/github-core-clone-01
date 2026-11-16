import type { IncomingMessage, ServerResponse } from 'node:http';
import { timestampForCreation } from './clock.ts';
import { getObject, getRef, nextPullNumber, type Repo, type Store } from './store.ts';
import { commitFiles, paginate, readCommit, readFiles, readJson } from './rest.ts';
import { sendJson } from './server.ts';

export interface Pull {
  number: number; state: 'open' | 'closed'; title: string; body: string;
  head: string; base: string; headShaAtCreate: string; baseShaAtCreate: string;
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
}
export const pullJson = (p: Pull) => ({ number: p.number, state: p.state, title: p.title, body: p.body,
  head: { ref: p.head, sha: p.headShaAtCreate }, base: { ref: p.base, sha: p.baseShaAtCreate },
  merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha });

export function lineDiff(oldText: string, newText: string) {
  const lines = (text: string): string[] => text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const oldLines = lines(oldText), newLines = lines(newText);
  // LCS with one row: quadratic time, linear auxiliary storage.
  const row = new Uint32Array(newLines.length + 1);
  for (const oldLine of oldLines) {
    let diagonal = 0;
    for (let j = 1; j <= newLines.length; j++) {
      const previous = row[j];
      row[j] = oldLine === newLines[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = previous;
    }
  }
  const common = row[newLines.length], additions = newLines.length - common, deletions = oldLines.length - common;
  return { additions, deletions, changes: additions + deletions };
}
export const hasConflict = (baseBlob: string | undefined, tipBlob: string | undefined, headBlob: string | undefined) =>
  tipBlob !== baseBlob && headBlob !== baseBlob && headBlob !== tipBlob;
export function pullFiles(store: Store, pull: Pull) {
  const base = readFiles(store, readCommit(store, pull.baseShaAtCreate).tree);
  const head = readFiles(store, readCommit(store, pull.headShaAtCreate).tree);
  const text = (sha: string | undefined) => sha ? getObject(store, sha)!.raw.toString() : '';
  return [...new Set([...base.keys(), ...head.keys()])].sort().filter(path => base.get(path) !== head.get(path)).map(filename => ({
    filename, status: !base.has(filename) ? 'added' : !head.has(filename) ? 'removed' : 'modified',
    ...lineDiff(text(base.get(filename)), text(head.get(filename))),
  }));
}

/** Called only after handleRest's shared requireRepo auth/ownership boundary. */
export async function handlePulls(req: IncomingMessage, res: ServerResponse, store: Store, repo: Repo, tail: string[], url: URL): Promise<void> {
  const error = (status: number, message: string) => sendJson(res, status, { message });
  const list = (items: unknown[]) => {
    const page = paginate(items, url.searchParams, req.headers.host ?? 'entry', url.pathname);
    sendJson(res, 200, page.items, page.headers);
  };
  if (tail.length === 1) {
    if (req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      list(([...repo.pulls.values()] as Pull[]).filter(p => state === 'all' || p.state === state).sort((a, b) => a.number - b.number).map(pullJson)); return;
    }
    if (req.method === 'POST') {
      const fields = await readJson(req, res); if (!fields) return;
      const head = typeof fields.head === 'string' ? fields.head : '', base = typeof fields.base === 'string' ? fields.base : '';
      const headShaAtCreate = getRef(repo, `refs/heads/${head}`), baseShaAtCreate = getRef(repo, `refs/heads/${base}`);
      if (!head || !base || !headShaAtCreate || !baseShaAtCreate || getObject(store, headShaAtCreate)?.type !== 'commit' || getObject(store, baseShaAtCreate)?.type !== 'commit') { error(422, 'Invalid branch'); return; }
      const pull: Pull = { number: nextPullNumber(repo), state: 'open', title: typeof fields.title === 'string' ? fields.title : '', body: typeof fields.body === 'string' ? fields.body : '', head, base, headShaAtCreate, baseShaAtCreate, merged: false, merged_at: null, merge_commit_sha: null };
      repo.pulls.set(pull.number, pull); sendJson(res, 201, pullJson(pull)); return;
    }
  } else {
    const pull = repo.pulls.get(Number(tail[1])) as Pull | undefined;
    if (!pull) { error(404, 'Not Found'); return; }
    if (tail.length === 2 && req.method === 'GET') { sendJson(res, 200, pullJson(pull)); return; }
    if (tail[2] === 'files' && req.method === 'GET') { list(pullFiles(store, pull)); return; }
    if (tail[2] === 'merge' && req.method === 'PUT') {
      const fields = await readJson(req, res); if (!fields) return;
      if (pull.state !== 'open') { error(405, 'Pull request is not open'); return; }
      if (fields.merge_method !== undefined && fields.merge_method !== 'squash') { error(422, 'Only squash merge is supported'); return; }
      const tip = getRef(repo, `refs/heads/${pull.base}`);
      if (!tip) { error(405, 'Base branch is missing'); return; }
      const base = readFiles(store, readCommit(store, pull.baseShaAtCreate).tree);
      const headModes = new Map<string, string>(), modes = new Map<string, string>();
      const head = readFiles(store, readCommit(store, pull.headShaAtCreate).tree, headModes);
      const files = readFiles(store, readCommit(store, tip).tree, modes);
      const changed = [...new Set([...base.keys(), ...head.keys()])].filter(path => base.get(path) !== head.get(path));
      for (const path of changed) {
        if (hasConflict(base.get(path), files.get(path), head.get(path))) { error(405, 'Merge conflict'); return; }
      }
      for (const path of changed) {
        const blob = head.get(path);
        if (blob === undefined) { files.delete(path); modes.delete(path); }
        else { files.set(path, blob); modes.set(path, headModes.get(path)!); }
      }
      const message = `Merge pull request #${pull.number} from ${pull.head}`;
      const sha = commitFiles(store, repo, pull.base, files, message, modes);
      pull.state = 'closed'; pull.merged = true; pull.merged_at = timestampForCreation().iso; pull.merge_commit_sha = sha;
      sendJson(res, 200, { merged: true, sha, message }); return;
    }
  }
  error(404, 'Not Found');
}
