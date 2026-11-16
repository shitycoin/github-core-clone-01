import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Store, type Repo, getRepo, setRef, deleteRef } from './store.ts';
import { checkAuth, isOwner } from './auth.ts';
import { nextRequestId } from './ids.ts';
import { readBody, sendJson } from './server.ts';
import { parsePack, buildPack } from './pack.ts';
import { PktLineDecoder, encodePktLine, pktLineFlush, pktLineDelim, splitSideband } from './pktline.ts';

const ZERO = '0'.repeat(40);
const OID = /^[0-9a-fA-F]{40}$/;
function headers(data: Buffer): { lines: string[]; message: string } {
  const end = data.indexOf('\n\n');
  return { lines: data.subarray(0, end < 0 ? data.length : end).toString().split('\n'), message: end < 0 ? '' : data.subarray(end + 2).toString() };
}
export function parseCommitData(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const h = headers(data), trees: string[] = [], parents: string[] = [];
  let author = '', committer = '';
  for (const line of h.lines) {
    if (line.startsWith('tree ')) trees.push(line.slice(5));
    if (line.startsWith('parent ')) parents.push(line.slice(7));
    if (line.startsWith('author ')) author = line.slice(7);
    if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (trees.length !== 1 || !OID.test(trees[0]) || parents.some(p => !OID.test(p))) throw new Error('Invalid commit');
  return { tree: trees[0], parents, author, committer, message: h.message };
}
export function parseTreeData(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  for (let pos = 0; pos < data.length;) {
    const space = data.indexOf(32, pos), nul = data.indexOf(0, space + 1);
    if (space < pos || nul <= space + 1 || nul + 21 > data.length) throw new Error('Truncated tree');
    const mode = data.subarray(pos, space).toString();
    if (!/^[0-7]+$/.test(mode)) throw new Error('Invalid tree mode');
    entries.push({ mode, name: data.subarray(space + 1, nul).toString(), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    pos = nul + 21;
  }
  return entries;
}
export function parseTagData(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const h = headers(data), fields: Record<string, string> = {};
  for (const line of h.lines) { const i = line.indexOf(' '); if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1); }
  if (!OID.test(fields.object ?? '') || !['commit', 'tree', 'blob', 'tag'].includes(fields.type)) throw new Error('Invalid tag');
  return { object: fields.object, type: fields.type, tag: fields.tag ?? '', tagger: fields.tagger ?? '', message: h.message };
}
// Breadth-first traversal assigns the minimum generation even with merges or multiple wants.
function walkGraph(store: Store, roots: Iterable<string>, stops: Set<string>, depth: number | null) {
  const seen = new Set<string>(), commits: string[] = [], boundary: string[] = [];
  const queue = [...roots].map(oid => ({ oid, generation: 0 }));
  for (let i = 0; i < queue.length; i++) {
    const { oid, generation } = queue[i];
    if (seen.has(oid)) continue;
    const obj = store.objects.get(oid);
    if (!obj) throw new Error('Missing object');
    seen.add(oid);
    if (obj.type === 'commit') {
      commits.push(oid);
      const c = parseCommitData(obj.raw);
      queue.push({ oid: c.tree, generation });
      if (depth !== null && generation >= depth - 1) boundary.push(oid);
      else if (!stops.has(oid)) for (const parent of c.parents) queue.push({ oid: parent, generation: generation + 1 });
    } else if (obj.type === 'tree') {
      for (const e of parseTreeData(obj.raw)) if (Number.parseInt(e.mode, 8) !== 0o160000) queue.push({ oid: e.oid, generation });
    } else if (obj.type === 'tag') {
      // Tag edges do not consume a commit generation.
      queue.splice(i + 1, 0, { oid: parseTagData(obj.raw).object, generation });
    }
  }
  return { seen, commits, boundary };
}
export function collectReachable(store: Store, roots: Iterable<string>): Set<string> {
  return walkGraph(store, roots, new Set(), null).seen;
}
export function isAncestor(store: Store, ancestor: string, tip: string): boolean {
  const pending = [tip], visited = new Set<string>();
  while (pending.length && visited.size < 1000) {
    const oid = pending.pop()!;
    if (oid === ancestor) return true;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const o = store.objects.get(oid);
    if (o?.type === 'commit') pending.push(...parseCommitData(o.raw).parents);
  }
  return false;
}
export function peelToCommit(store: Store, oid: string): string | null {
  try {
    for (let hops = 0; hops <= 10; hops++) {
      const obj = store.objects.get(oid);
      if (obj?.type === 'commit') return oid;
      if (obj?.type !== 'tag') return null;
      oid = parseTagData(obj.raw).object;
    }
  } catch { return null; }
  return null;
}
export function computeFetchPlan(store: Store, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | null): { send: string[]; shallow: string[]; unshallow: string[] } {
  const held = walkGraph(store, haves.filter(o => store.objects.has(o)), new Set(shallowIn), null).seen;
  const walk = walkGraph(store, wants.filter(o => store.objects.has(o)), new Set(), depth);
  // Stable topological order: a selected child precedes its selected parents,
  // including when the caller lists an ancestor before another wanted tip.
  const selected = new Set(walk.commits.filter(o => !held.has(o)));
  const children = new Map([...selected].map(o => [o, 0]));
  const parents = new Map([...selected].map(o => [o, parseCommitData(store.objects.get(o)!.raw).parents.filter(p => selected.has(p))]));
  for (const ps of parents.values()) for (const p of ps) children.set(p, children.get(p)! + 1);
  const commits: string[] = [];
  while (selected.size) {
    const next = [...selected].find(o => children.get(o) === 0);
    if (!next) throw new Error('Cyclic commit graph');
    selected.delete(next); commits.push(next);
    for (const p of parents.get(next)!) children.set(p, children.get(p)! - 1);
  }
  const other = [...walk.seen].filter(o => !held.has(o) && store.objects.get(o)!.type !== 'commit').sort();
  const unshallow = [...new Set(shallowIn)].filter(oid => {
    const obj = store.objects.get(oid);
    if (!walk.seen.has(oid) || obj?.type !== 'commit') return false;
    const parents = parseCommitData(obj.raw).parents;
    return parents.length > 0 && parents.every(p => walk.seen.has(p));
  }).sort();
  return { send: [...commits, ...other], shallow: walk.boundary.sort(), unshallow };
}
export function validatePushCommand(store: Store, repo: Repo, cmd: { oldOid: string; newOid: string; ref: string }): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  try {
    const { oldOid, newOid, ref } = cmd, current = repo.refs.get(ref);
    if (newOid === ZERO) {
      if (!current) return fail('reference does not exist');
      if (current !== oldOid) return fail('non-fast-forward');
      if (ref === `refs/heads/${repo.defaultBranch}`) return fail('deletion of the current branch prohibited');
    } else {
      if (oldOid === ZERO) { if (current) return fail('already exists'); }
      else { if (!current) return fail('reference does not exist'); if (current !== oldOid) return fail('non-fast-forward'); }
      if (!store.objects.has(newOid)) return fail('object not found');
      if (oldOid !== ZERO && !isAncestor(store, oldOid, newOid)) return fail('non-fast-forward');
    }
    return { ok: true };
  } catch { return fail('non-fast-forward'); }
}
function refs(repo: Repo): Array<[string, string]> { return [...repo.refs].filter(([name]) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); }
function packets(lines: string[]): Buffer[] { return lines.map(line => encodePktLine(line + '\n')); }
export function buildV2Advertisement(): Buffer { return Buffer.concat([...packets(['version 2', 'ls-refs=unborn', 'fetch=shallow']), pktLineFlush()]); }
export function buildV0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const target = `refs/heads/${repo.defaultBranch}`;
  const caps = `symref=HEAD:${target} ` + (service === 'git-upload-pack' ? 'side-band-64k shallow ofs-delta thin-pack' : 'report-status side-band-64k delete-refs ofs-delta');
  const sorted = refs(repo), lines = [`# service=${service}`];
  lines.push(sorted.length ? `${repo.refs.get(target) ?? ZERO} HEAD\0${caps}` : `${ZERO} capabilities^{}\0${caps}`);
  for (const [name, oid] of sorted) {
    lines.push(`${oid} ${name}`);
    if (store.objects.get(oid)?.type === 'tag') { const peeled = peelToCommit(store, oid); if (peeled) lines.push(`${peeled} ${name}^{}`); }
  }
  return Buffer.concat([...packets(lines), pktLineFlush()]);
}
function lsRefs(store: Store, repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter(a => a.startsWith('ref-prefix ')).map(a => a.slice(11));
  const lines: string[] = [], target = `refs/heads/${repo.defaultBranch}`, tip = repo.refs.get(target);
  if (!prefixes.length) {
    if (tip) lines.push(`${tip} HEAD${args.includes('symrefs') ? ` symref-target:${target}` : ''}`);
    else if (args.includes('unborn')) lines.push(`unborn HEAD symref-target:${target}`);
  }
  for (const [name, oid] of refs(repo)) {
    if (prefixes.length && !prefixes.some(p => name.startsWith(p))) continue;
    const peeled = args.includes('peel') && store.objects.get(oid)?.type === 'tag' ? peelToCommit(store, oid) : null;
    lines.push(`${oid} ${name}${peeled ? ` peeled:${peeled}` : ''}`);
  }
  return Buffer.concat([...packets(lines), pktLineFlush()]);
}
function fetchResponse(store: Store, repo: Repo, lines: string[], v2: boolean): Buffer {
  const wants: string[] = [], haves: string[] = [], shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const [key, value] = line.split(' ');
    if (key === 'want' && OID.test(value ?? '')) wants.push(value);
    if (key === 'have' && OID.test(value ?? '')) haves.push(value);
    if (key === 'shallow' && OID.test(value ?? '')) shallow.push(value);
    if (key === 'deepen') { const n = Number(value); if (Number.isSafeInteger(n) && n > 0) depth = n; }
  }
  const plan = computeFetchPlan(store, wants, haves, shallow, depth);
  const acknowledgments = haves.filter(o => store.objects.has(o)).map(o => `ACK ${o}`);
  if (!haves.length || haves.some(o => !store.objects.has(o))) acknowledgments.push('NAK');
  else if (v2) acknowledgments.push('ready');
  const boundaries = [...plan.shallow.map(o => `shallow ${o}`), ...plan.unshallow.map(o => `unshallow ${o}`)];
  const pack = plan.send.length ? splitSideband(1, buildPack(plan.send, store)) : [];
  if (!v2) return Buffer.concat([...packets([...acknowledgments, ...boundaries]), ...pack, pktLineFlush()]);
  const sections: Buffer[][] = [packets(['acknowledgments', ...acknowledgments])];
  if (boundaries.length) sections.push(packets(['shallow-info', ...boundaries]));
  const wanted = new Set(wants), matched = refs(repo).filter(([, oid]) => wanted.has(oid)).map(([name, oid]) => `${oid} ${name}`);
  if (matched.length) sections.push(packets(['wanted-refs', ...matched]));
  if (pack.length) sections.push([...packets(['packfile']), ...pack]);
  return Buffer.concat([...sections.flatMap((section, i) => i ? [pktLineDelim(), ...section] : section), pktLineFlush()]);
}
function receiveResponse(store: Store, repo: Repo, body: Buffer): Buffer {
  const decoder = new PktLineDecoder(); decoder.push(body); decoder.finish();
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let flushed = false;
  for (let p = decoder.next(); p; p = decoder.next()) {
    if (p.kind === 'flush') { flushed = true; break; }
    if (p.kind !== 'data') throw new Error('Invalid command');
    const line = p.payload.toString().split('\0')[0].replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/(?:heads|tags)\/[^\s\0]+)$/.exec(line);
    if (!match) throw new Error('Invalid command');
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (!flushed) throw new Error('Missing flush');
  const pack = body.subarray(body.length - decoder.bufferedBytes), report: string[] = [];
  let unpacked = true;
  try { if (pack.length) parsePack(pack, store); report.push('unpack ok'); }
  catch { unpacked = false; report.push('unpack invalid pack'); }
  if (unpacked) for (const cmd of commands) {
    const result = validatePushCommand(store, repo, cmd);
    if (result.ok) {
      if (cmd.newOid === ZERO) deleteRef(repo, cmd.ref); else setRef(repo, cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
    } else report.push(`ng ${cmd.ref} ${result.reason}`);
  }
  return Buffer.concat([...splitSideband(1, Buffer.concat(packets(report))), pktLineFlush()]);
}
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<void> {
  const error = (status: number, message: string) => sendJson(res, status, { message });
  if (!isOwner(owner)) { error(404, 'Not Found'); return; }
  if (req.headers.authorization !== undefined && !checkAuth(req)) { error(401, 'Unauthorized'); return; }
  const repo = getRepo(store, owner, name);
  if (!repo) { error(404, 'Not Found'); return; }
  const url = new URL(req.url ?? '/', 'http://entry'), suffix = url.pathname.split('/').slice(3).join('/');
  const v2 = String(req.headers['git-protocol'] ?? '').split(':').includes('version=2');
  let service: 'git-upload-pack' | 'git-receive-pack', body: Buffer, advertisement = false;
  if (req.method === 'GET' && suffix === 'info/refs') {
    const requested = url.searchParams.get('service');
    if (requested !== 'git-upload-pack' && requested !== 'git-receive-pack') { error(400, 'Unknown service'); return; }
    service = requested; advertisement = true;
    body = v2 && service === 'git-upload-pack' ? buildV2Advertisement() : buildV0Advertisement(store, repo, service);
  } else if (req.method === 'POST' && (suffix === 'git-upload-pack' || suffix === 'git-receive-pack')) {
    service = suffix;
    const read = await readBody(req, 64 * 1024 * 1024);
    if (!read.ok) { error(read.overCap ? 413 : 400, read.overCap ? 'Request entity too large' : 'Invalid body'); return; }
    try {
      if (service === 'git-receive-pack') body = receiveResponse(store, repo, read.body);
      else {
        const decoder = new PktLineDecoder(); decoder.push(read.body); decoder.finish();
        const lines: string[] = [];
        for (let p = decoder.next(); p; p = decoder.next()) if (p.kind === 'data') lines.push(p.payload.toString().replace(/\n$/, ''));
        body = v2 && lines.includes('command=ls-refs') ? lsRefs(store, repo, lines) : fetchResponse(store, repo, lines, v2);
      }
    } catch { error(400, 'Invalid pkt-line'); return; }
  } else { error(404, 'Not Found'); return; }
  res.writeHead(200, { 'content-type': `application/x-${service}-${advertisement ? 'advertisement' : 'result'}`, 'content-length': body.length, 'X-GitHub-Request-Id': nextRequestId() });
  res.end(body);
}
