// M6: hand-rolled GraphQL v4 dispatcher (no engine). Resolves the 17 documents the suite
// sends (checks-graphql.ts) against the SAME in-memory store REST reads. A small recursive
// parser turns each document into a selection tree; resolvers walk it against the field
// tables in FIELDS and report any selected field outside its table as a GraphQL error
// (HTTP stays 200, valid siblings still resolve). No clock, no randomness: deterministic.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth, OWNER_LOGIN } from './auth.ts';
import { decodeGlobalId, globalId } from './ids.ts';
import { getRef, getRepo, type Repo, type Store } from './store.ts';
import { readBody, sendJson } from './server.ts';
import { readCommit, readFiles } from './rest.ts';
import { addCommentRecord, closeIssueRecord, createIssueRecord, type Comment, type Issue } from './rest-issues.ts';
import { createPullRecord, hasConflict, mergePullRecord, pullFiles, type Pull } from './rest-pulls.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const MISSING = Symbol('missing');

// ---------------------------------------------------------------------------
// Minimal GraphQL parser (documents only: operation + selection sets + values)
// ---------------------------------------------------------------------------
type TokKind = 'name' | 'string' | 'int' | 'punct';
interface Tok { kind: TokKind; value: string }
interface ArgVal { kind: 'var' | 'string' | 'int' | 'bool' | 'null' | 'enum' | 'list' | 'object'; name?: string; value?: unknown; items?: ArgVal[]; fields?: Map<string, ArgVal> }
interface Sel { name: string; alias: string | null; args: Map<string, ArgVal>; children: Sel[] | null; fragment: string | null }
interface Operation { kind: 'query' | 'mutation'; selections: Sel[] }

function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}
function isNameChar(code: number): boolean {
  return isNameStart(code) || (code >= 48 && code <= 57);
}
function tokenize(text: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 44) { i += 1; continue; }
    if (code === 35) { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (code === 34) {
      let j = i + 1, out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          const e = text[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u' && j + 5 < text.length) { out += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else { out += text[j]; j += 1; }
      }
      if (j >= text.length) return null;
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (text.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    const ch = text[i];
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ':' || ch === '!' || ch === '$' || ch === '@' || ch === '=') {
      toks.push({ kind: 'punct', value: ch }); i += 1; continue;
    }
    if (ch === '-' || (code >= 48 && code <= 57)) {
      let j = i;
      if (text[j] === '-') j += 1;
      let digits = false;
      while (j < text.length && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) { j += 1; digits = true; }
      if (!digits) return null;
      if (text[j] === '.' && j + 1 < text.length && text.charCodeAt(j + 1) >= 48 && text.charCodeAt(j + 1) <= 57) {
        j += 1;
        while (j < text.length && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j += 1;
      }
      toks.push({ kind: 'int', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(code)) {
      let j = i;
      while (j < text.length && isNameChar(text.charCodeAt(j))) j += 1;
      toks.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    return null;
  }
  return toks;
}

class Parser {
  toks: Tok[];
  pos: number;
  constructor(toks: Tok[]) { this.toks = toks; this.pos = 0; }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok | undefined { return this.toks[this.pos++]; }
  expectPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }
  expectName(v?: string): string | null {
    const t = this.peek();
    if (t && t.kind === 'name' && (v === undefined || t.value === v)) { this.pos += 1; return t.value; }
    return null;
  }
  skipBalanced(open: string, close: string): boolean {
    if (!this.expectPunct(open)) return false;
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (!t) return false;
      if (t.kind === 'punct' && t.value === open) depth += 1;
      if (t.kind === 'punct' && t.value === close) depth -= 1;
    }
    return true;
  }
  parseValue(): ArgVal | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      const name = this.expectName();
      if (!name) return null;
      return { kind: 'var', name };
    }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'int') { this.next(); return { kind: 'int', value: Number(t.value) }; }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const items: ArgVal[] = [];
      for (;;) {
        const nt = this.peek();
        if (!nt) return null;
        if (nt.kind === 'punct' && nt.value === ']') { this.next(); break; }
        const v = this.parseValue();
        if (!v) return null;
        items.push(v);
      }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields = new Map<string, ArgVal>();
      for (;;) {
        const nt = this.peek();
        if (!nt) return null;
        if (nt.kind === 'punct' && nt.value === '}') { this.next(); break; }
        const fname = this.expectName();
        if (!fname) return null;
        if (!this.expectPunct(':')) return null;
        const v = this.parseValue();
        if (!v) return null;
        fields.set(fname, v);
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    return null;
  }
  parseSelection(): Sel | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      let fragment: string | null = null;
      const on = this.peek();
      if (on && on.kind === 'name' && on.value === 'on') {
        this.next();
        const typeName = this.expectName();
        if (!typeName) return null;
        fragment = typeName;
      }
      const children = this.parseSelectionSet();
      if (!children) return null;
      return { name: '', alias: null, args: new Map(), children, fragment };
    }
    if (t.kind !== 'name') return null;
    const first = this.next()!.value;
    let alias: string | null = null;
    let name = first;
    const colon = this.peek();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      const field = this.expectName();
      if (!field) return null;
      alias = first;
      name = field;
    }
    const args = new Map<string, ArgVal>();
    const paren = this.peek();
    if (paren && paren.kind === 'punct' && paren.value === '(') {
      this.next();
      for (;;) {
        const nt = this.peek();
        if (!nt) return null;
        if (nt.kind === 'punct' && nt.value === ')') { this.next(); break; }
        const argName = this.expectName();
        if (!argName) return null;
        if (!this.expectPunct(':')) return null;
        const value = this.parseValue();
        if (!value) return null;
        args.set(argName, value);
      }
    }
    let children: Sel[] | null = null;
    const brace = this.peek();
    if (brace && brace.kind === 'punct' && brace.value === '{') {
      children = this.parseSelectionSet();
      if (!children) return null;
    }
    return { name, alias, args, children, fragment: null };
  }
  parseSelectionSet(): Sel[] | null {
    if (!this.expectPunct('{')) return null;
    const out: Sel[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) return null;
      if (t.kind === 'punct' && t.value === '}') { this.next(); return out; }
      const sel = this.parseSelection();
      if (!sel) return null;
      out.push(sel);
    }
  }
}

function parseDocument(text: string): Operation | null {
  const toks = tokenize(text);
  if (!toks) return null;
  const p = new Parser(toks);
  let kind: 'query' | 'mutation' = 'query';
  const first = p.peek();
  if (first && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
    kind = first.value as 'query' | 'mutation';
    p.next();
    const maybeName = p.peek();
    if (maybeName && maybeName.kind === 'name') p.next();
    const paren = p.peek();
    if (paren && paren.kind === 'punct' && paren.value === '(') {
      if (!p.skipBalanced('(', ')')) return null;
    }
  }
  const selections = p.parseSelectionSet();
  if (!selections || p.pos !== p.toks.length) return null;
  return { kind, selections };
}

// ---------------------------------------------------------------------------
// Field tables (the whole "schema" — anything selected outside these is unknown)
// ---------------------------------------------------------------------------
const FIELDS: Record<string, string[]> = {
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Ref: ['name'],
  __Type: ['fields', 'enumValues'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};
// Introspection tables (exact — the checks assert these names are present).
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id', 'name'],
};
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'];

interface Ctx { store: Store; vars: Record<string, unknown>; errors: { message: string }[] }

function argVal(arg: ArgVal | undefined, vars: Record<string, unknown>): unknown {
  if (!arg) return undefined;
  switch (arg.kind) {
    case 'var': return vars[arg.name ?? ''];
    case 'list': return (arg.items ?? []).map((item) => argVal(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of arg.fields ?? []) out[k] = argVal(v, vars);
      return out;
    }
    default: return arg.value;
  }
}
function argOf(sel: Sel, name: string, vars: Record<string, unknown>): unknown {
  return argVal(sel.args.get(name), vars);
}

const encodeCursor = (n: number): string => Buffer.from(`cursor:${n}`).toString('base64');
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString();
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isSafeInteger(n) ? n : null;
  } catch { return null; }
}

function findRepoByDatabaseId(store: Store, dbId: number): Repo | undefined {
  for (const r of store.repos.values()) if (r.databaseId === dbId) return r;
  return undefined;
}
function decodeRepoId(store: Store, gid: unknown): Repo | null {
  if (typeof gid !== 'string') return null;
  const d = decodeGlobalId(gid);
  if (!d || d.type !== 'Repository') return null;
  const dbId = Number(d.id);
  if (!Number.isSafeInteger(dbId)) return null;
  return findRepoByDatabaseId(store, dbId) ?? null;
}
function decodeTyped(store: Store, gid: unknown, type: string): { repo: Repo; number: number } | null {
  if (typeof gid !== 'string') return null;
  const d = decodeGlobalId(gid);
  if (!d || d.type !== type) return null;
  const parts = d.id.split(':');
  const dbId = Number(parts[0]);
  const number = Number(parts[1]);
  if (!Number.isSafeInteger(dbId) || !Number.isSafeInteger(number)) return null;
  const repo = findRepoByDatabaseId(store, dbId);
  if (!repo) return null;
  return { repo, number };
}

// Resolve ONLY the selected children of one object; unknown fields become errors.
function resolveFields(ctx: Ctx, typeName: string, children: Sel[] | null, resolveOne: (sel: Sel) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const table = FIELDS[typeName] ?? [];
  for (const sel of children ?? []) {
    if (sel.fragment !== null) {
      if (sel.fragment === typeName) Object.assign(out, resolveFields(ctx, typeName, sel.children, resolveOne));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') { out[key] = typeName; continue; }
    if (!table.includes(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      continue;
    }
    const value = resolveOne(sel);
    if (value !== MISSING) out[key] = value;
  }
  return out;
}

function userFields(ctx: Ctx, login: string, children: Sel[] | null): Record<string, unknown> {
  return resolveFields(ctx, 'User', children, (sel) => {
    if (sel.name === 'login') return login;
    if (sel.name === 'id') return globalId('User', login);
    if (sel.name === 'name') return login;
    return MISSING;
  });
}

function issueFields(ctx: Ctx, repo: Repo, issue: Issue, children: Sel[] | null): Record<string, unknown> {
  return resolveFields(ctx, 'Issue', children, (sel) => {
    switch (sel.name) {
      case 'id': return globalId('Issue', `${repo.databaseId}:${issue.number}`);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return issue.body;
    }
    return MISSING;
  });
}

function mergeableOf(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  try {
    const base = readFiles(store, readCommit(store, pull.baseShaAtCreate).tree);
    const head = readFiles(store, readCommit(store, pull.headShaAtCreate).tree);
    const tip = getRef(repo, `refs/heads/${pull.base}`);
    if (!tip) return 'UNKNOWN';
    const tipFiles = readFiles(store, readCommit(store, tip).tree);
    const changed = [...new Set([...base.keys(), ...head.keys()])].filter((path) => base.get(path) !== head.get(path));
    for (const path of changed) {
      if (hasConflict(base.get(path), tipFiles.get(path), head.get(path))) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  } catch { return 'UNKNOWN'; }
}

function pullFields(ctx: Ctx, repo: Repo, pull: Pull, children: Sel[] | null): Record<string, unknown> {
  return resolveFields(ctx, 'PullRequest', children, (sel) => {
    switch (sel.name) {
      case 'id': return globalId('PullRequest', `${repo.databaseId}:${pull.number}`);
      case 'number': return pull.number;
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'mergeable': return mergeableOf(ctx.store, repo, pull);
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'files': {
        const first = argOf(sel, 'first', ctx.vars);
        const files = pullFiles(ctx.store, pull).slice(0, typeof first === 'number' ? first : 10);
        return resolveFields(ctx, 'PullRequestChangedFileConnection', sel.children, (s) => {
          if (s.name === 'nodes') {
            return files.map((f) => resolveFields(ctx, 'PullRequestChangedFile', s.children, (c) => (c.name === 'path' ? f.filename : MISSING)));
          }
          return MISSING;
        });
      }
    }
    return MISSING;
  });
}

function issuesConnection(ctx: Ctx, repo: Repo, sel: Sel): Record<string, unknown> {
  let list = [...repo.issues.values()] as Issue[];
  const states = argOf(sel, 'states', ctx.vars);
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = argOf(sel, 'orderBy', ctx.vars);
  const direction = isRecord(orderBy) ? String(orderBy.direction ?? 'ASC') : 'ASC';
  list.sort((a, b) => (a.number - b.number) * (direction === 'DESC' ? -1 : 1));
  const after = argOf(sel, 'after', ctx.vars);
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    if (decoded !== null) {
      const idx = list.findIndex((issue) => issue.number === decoded);
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const first = argOf(sel, 'first', ctx.vars);
  const page = typeof first === 'number' ? list.slice(0, first) : list;
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return resolveFields(ctx, 'IssueConnection', sel.children, (s) => {
    if (s.name === 'nodes') return page.map((issue) => issueFields(ctx, repo, issue, s.children));
    if (s.name === 'pageInfo') {
      return resolveFields(ctx, 'PageInfo', s.children, (p) => {
        if (p.name === 'hasNextPage') return hasNextPage;
        if (p.name === 'endCursor') return endCursor;
        return MISSING;
      });
    }
    return MISSING;
  });
}

function pullsConnection(ctx: Ctx, repo: Repo, sel: Sel): Record<string, unknown> {
  const first = argOf(sel, 'first', ctx.vars);
  let list = ([...repo.pulls.values()] as Pull[]).filter((p) => p.state === 'open').sort((a, b) => a.number - b.number);
  if (typeof first === 'number') list = list.slice(0, first);
  return resolveFields(ctx, 'PullRequestConnection', sel.children, (s) => {
    if (s.name === 'nodes') return list.map((p) => pullFields(ctx, repo, p, s.children));
    return MISSING;
  });
}

function repoFields(ctx: Ctx, repo: Repo, children: Sel[] | null): Record<string, unknown> {
  return resolveFields(ctx, 'Repository', children, (sel) => {
    switch (sel.name) {
      case 'id': return globalId('Repository', repo.databaseId);
      case 'databaseId': return repo.databaseId;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return userFields(ctx, repo.owner, sel.children);
      case 'defaultBranchRef': return resolveFields(ctx, 'Ref', sel.children, (s) => (s.name === 'name' ? repo.defaultBranch : MISSING));
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const n = argOf(sel, 'number', ctx.vars);
        const issue = typeof n === 'number' ? (repo.issues.get(n) as Issue | undefined) : undefined;
        return issue ? issueFields(ctx, repo, issue, sel.children) : null;
      }
      case 'issues': return issuesConnection(ctx, repo, sel);
      case 'pullRequests': return pullsConnection(ctx, repo, sel);
      case 'pullRequest': {
        const n = argOf(sel, 'number', ctx.vars);
        const pull = typeof n === 'number' ? (repo.pulls.get(n) as Pull | undefined) : undefined;
        return pull ? pullFields(ctx, repo, pull, sel.children) : null;
      }
    }
    return MISSING;
  });
}

function typeFields(ctx: Ctx, name: string, children: Sel[] | null): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return resolveFields(ctx, '__Type', children, (sel) => {
      if (sel.name === 'fields') return null;
      if (sel.name === 'enumValues') return SEARCH_ENUM.map((n) => ({ name: n }));
      return MISSING;
    });
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return resolveFields(ctx, '__Type', children, (sel) => {
    if (sel.name === 'fields') return fields.map((n) => ({ name: n }));
    if (sel.name === 'enumValues') return null;
    return MISSING;
  });
}

function resolveNode(ctx: Ctx, id: unknown, children: Sel[] | null): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const d = decodeGlobalId(id);
  if (!d || d.type !== 'Repository') return null;
  const repo = findRepoByDatabaseId(ctx.store, Number(d.id));
  if (!repo) return null;
  const out = repoFields(ctx, repo, children);
  out.__typename = 'Repository';
  return out;
}

// ---------------------------------------------------------------------------
// Root Query / Mutation
// ---------------------------------------------------------------------------
function resolveQuery(ctx: Ctx, op: Operation): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'viewer':
        data[key] = userFields(ctx, OWNER_LOGIN, sel.children);
        break;
      case 'repository': {
        const owner = argOf(sel, 'owner', ctx.vars);
        const name = argOf(sel, 'name', ctx.vars);
        const repo = typeof owner === 'string' && typeof name === 'string' ? getRepo(ctx.store, owner, name) : undefined;
        data[key] = repo ? repoFields(ctx, repo, sel.children) : null;
        break;
      }
      case 'node':
        data[key] = resolveNode(ctx, argOf(sel, 'id', ctx.vars), sel.children);
        break;
      case '__type': {
        const name = argOf(sel, 'name', ctx.vars);
        data[key] = typeof name === 'string' ? typeFields(ctx, name, sel.children) : null;
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
        break;
    }
  }
  return data;
}

function inputOf(sel: Sel, ctx: Ctx): Record<string, unknown> | undefined {
  const input = argOf(sel, 'input', ctx.vars);
  return isRecord(input) ? input : undefined;
}

function mutateCreateIssue(ctx: Ctx, sel: Sel): Record<string, unknown> | null {
  const input = inputOf(sel, ctx);
  const repo = input ? decodeRepoId(ctx.store, input.repositoryId) : null;
  if (!repo || !input) {
    ctx.errors.push({ message: 'createIssue: repositoryId does not identify an existing repository' });
    return null;
  }
  const issue = createIssueRecord(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '');
  return resolveFields(ctx, 'CreateIssuePayload', sel.children, (s) => (s.name === 'issue' ? issueFields(ctx, repo, issue, s.children) : MISSING));
}

function mutateCloseIssue(ctx: Ctx, sel: Sel): Record<string, unknown> | null {
  const input = inputOf(sel, ctx);
  const decoded = input ? decodeTyped(ctx.store, input.issueId, 'Issue') : null;
  const issue = decoded ? (decoded.repo.issues.get(decoded.number) as Issue | undefined) : undefined;
  if (!decoded || !issue) {
    ctx.errors.push({ message: 'closeIssue: issueId does not identify an existing issue' });
    return null;
  }
  closeIssueRecord(issue);
  return resolveFields(ctx, 'CloseIssuePayload', sel.children, (s) => (s.name === 'issue' ? issueFields(ctx, decoded.repo, issue, s.children) : MISSING));
}

function mutateCreatePullRequest(ctx: Ctx, sel: Sel): Record<string, unknown> | null {
  const input = inputOf(sel, ctx);
  const repo = input ? decodeRepoId(ctx.store, input.repositoryId) : null;
  if (!repo || !input) {
    ctx.errors.push({ message: 'createPullRequest: repositoryId does not identify an existing repository' });
    return null;
  }
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const title = typeof input.title === 'string' ? input.title : '';
  let pull: Pull;
  try {
    pull = createPullRecord(ctx.store, repo, head, base, title, '');
  } catch (err) {
    ctx.errors.push({ message: `createPullRequest: ${err instanceof Error ? err.message : 'invalid branches'}` });
    return null;
  }
  return resolveFields(ctx, 'CreatePullRequestPayload', sel.children, (s) => (s.name === 'pullRequest' ? pullFields(ctx, repo, pull, s.children) : MISSING));
}

function mutateMergePullRequest(ctx: Ctx, sel: Sel): Record<string, unknown> | null {
  const input = inputOf(sel, ctx);
  if (!input) {
    ctx.errors.push({ message: 'mergePullRequest: input is required' });
    return null;
  }
  if (input.mergeMethod !== undefined && input.mergeMethod !== 'SQUASH') {
    ctx.errors.push({ message: 'mergePullRequest: only SQUASH merge is supported' });
    return null;
  }
  const decoded = decodeTyped(ctx.store, input.pullRequestId, 'PullRequest');
  const pull = decoded ? (decoded.repo.pulls.get(decoded.number) as Pull | undefined) : undefined;
  if (!decoded || !pull) {
    ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not identify an existing pull request' });
    return null;
  }
  try {
    mergePullRecord(ctx.store, decoded.repo, pull);
  } catch (err) {
    ctx.errors.push({ message: `mergePullRequest: ${err instanceof Error ? err.message : 'merge failed'}` });
    return null;
  }
  return resolveFields(ctx, 'MergePullRequestPayload', sel.children, (s) => (s.name === 'pullRequest' ? pullFields(ctx, decoded.repo, pull, s.children) : MISSING));
}

function mutateAddComment(ctx: Ctx, sel: Sel): Record<string, unknown> | null {
  const input = inputOf(sel, ctx);
  const decoded = input ? decodeTyped(ctx.store, input.subjectId, 'Issue') : null;
  const issue = decoded ? (decoded.repo.issues.get(decoded.number) as Issue | undefined) : undefined;
  if (!decoded || !issue || !input) {
    ctx.errors.push({ message: 'addComment: subjectId does not identify an existing issue' });
    return null;
  }
  const comment: Comment = addCommentRecord(decoded.repo, decoded.number, typeof input.body === 'string' ? input.body : '');
  return resolveFields(ctx, 'AddCommentPayload', sel.children, (s) => {
    if (s.name !== 'commentEdge') return MISSING;
    return resolveFields(ctx, 'CommentEdge', s.children, (e) => {
      if (e.name !== 'node') return MISSING;
      return resolveFields(ctx, 'IssueComment', e.children, (c) => {
        if (c.name === 'id') return globalId('IssueComment', `${decoded.repo.databaseId}:${decoded.number}:${comment.id}`);
        if (c.name === 'body') return comment.body;
        return MISSING;
      });
    });
  });
}

function resolveMutation(ctx: Ctx, op: Operation): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'createIssue': data[key] = mutateCreateIssue(ctx, sel); break;
      case 'closeIssue': data[key] = mutateCloseIssue(ctx, sel); break;
      case 'createPullRequest': data[key] = mutateCreatePullRequest(ctx, sel); break;
      case 'mergePullRequest': data[key] = mutateMergePullRequest(ctx, sel); break;
      case 'addComment': data[key] = mutateAddComment(ctx, sel); break;
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
        break;
    }
  }
  return data;
}

function runOperation(store: Store, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, vars: variables, errors: [] };
  if (typeof query !== 'string' || query.trim() === '') return { data: {}, errors: [{ message: 'Unknown operation' }] };
  const parsed = parseDocument(query);
  if (!parsed) return { data: {}, errors: [{ message: 'Unknown operation' }] };
  const data = parsed.kind === 'mutation' ? resolveMutation(ctx, parsed) : resolveQuery(ctx, parsed);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function operationOf(entry: unknown): { query: string; variables: Record<string, unknown> } {
  if (isRecord(entry)) {
    return {
      query: typeof entry.query === 'string' ? entry.query : '',
      variables: isRecord(entry.variables) ? entry.variables : {},
    };
  }
  return { query: '', variables: {} };
}

/** POST /api/graphql only. Auth 401 / malformed JSON 400 / over-cap 413, else 200 envelopes. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  let path = '';
  try { path = new URL(req.url ?? '/', 'http://entry').pathname; } catch { path = ''; }
  if (req.method !== 'POST' || path !== '/api/graphql') { sendJson(res, 404, { message: 'Not Found' }); return; }
  if (!checkAuth(req)) { sendJson(res, 401, { message: 'Unauthorized' }); return; }
  const read = await readBody(req);
  if (!read.ok) { sendJson(res, read.overCap ? 413 : 400, { message: read.overCap ? 'Request entity too large' : 'Invalid JSON' }); return; }
  let body: unknown;
  try { body = JSON.parse(read.body.toString()); } catch { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => {
      const op = operationOf(entry);
      return runOperation(store, op.query, op.variables);
    }));
    return;
  }
  if (isRecord(body)) {
    const op = operationOf(body);
    sendJson(res, 200, runOperation(store, op.query, op.variables));
    return;
  }
  sendJson(res, 400, { message: 'Invalid JSON' });
}
