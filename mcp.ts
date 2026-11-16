// M7: MCP endpoint (POST /mcp, JSON-RPC 2.0 over plain application/json).
// Six tools over the SAME in-memory store REST/GraphQL read, via the M6 shared
// record helpers — no second write path. Modern era (server/discover, 2026-07-28)
// + legacy initialize fallback. Tools list built once at boot, served cached.
// No clock, no randomness: deterministic.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth, OWNER_LOGIN } from './auth.ts';
import { createRepo, getRepo, type Repo, type Store } from './store.ts';
import { readBody, sendJson } from './server.ts';
import { repoJson } from './rest.ts';
import { createIssueRecord, issueJson, sortedIssues } from './rest-issues.ts';
import { createPullRecord, mergePullRecord, pullJson } from './rest-pulls.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const LEGACY_VERSIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const PREFERRED_VERSION = '2026-07-28';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

type ToolDef = { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] } };

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const strProp = (description: string) => ({ type: 'string', description });
const boolProp = (description: string) => ({ type: 'boolean', description });
const intProp = (description: string) => ({ type: 'integer', description });

const repoIdProps = {
  owner: strProp('Repository owner login.'),
  repo: strProp('Repository name.'),
  full_name: strProp('Repository full name "owner/repo" (alternative to owner + repo).'),
};

// The six canonical tools, built ONCE at boot; the same array object is served on every tools/list.
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a repository under the authenticated user.', {
    name: strProp('Repository name.'),
    description: strProp('Repository description.'),
    private: boolProp('Whether the repository is private.'),
    owner: strProp('Repository owner login (ignored; the repository is created under the token login).'),
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', repoIdProps, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    ...repoIdProps,
    title: strProp('Issue title.'),
    body: strProp('Issue body.'),
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    ...repoIdProps,
    state: strProp('Issue state filter: open, closed, or all.'),
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    ...repoIdProps,
    title: strProp('Pull request title.'),
    body: strProp('Pull request body.'),
    head: strProp('Head branch name.'),
    base: strProp('Base branch name.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request (squash) in a repository.', {
    ...repoIdProps,
    pull_number: intProp('Pull request number.'),
  }, ['owner', 'repo', 'pull_number']),
]);

const CANONICAL = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'] as const;
type Canonical = (typeof CANONICAL)[number];

// Aliases copied verbatim from MCP_TOOL_ALIASES in checks-mcp.ts.
const ALIASES: Readonly<Record<Canonical, readonly string[]>> = Object.freeze({
  create_repo: Object.freeze(['create_repository', 'repo_create', 'repos_create', 'repository_create']),
  get_repo: Object.freeze(['get_repository', 'repo_get', 'repos_get', 'repository_get']),
  create_issue: Object.freeze(['issue_create', 'issues_create']),
  list_issues: Object.freeze(['issues_list', 'issue_list']),
  create_pull_request: Object.freeze(['pull_request_create', 'pulls_create', 'create_pr', 'pr_create']),
  merge_pull_request: Object.freeze(['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge']),
});

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const NAME_MAP = new Map<string, Canonical>();
for (const canonical of CANONICAL) {
  NAME_MAP.set(normalize(canonical), canonical);
  for (const alias of ALIASES[canonical]) NAME_MAP.set(normalize(alias), canonical);
}

/** Resolve a tool name: exact canonical/alias match, else suffix match (a server prefix is allowed). */
function resolveTool(name: string): Canonical | null {
  const norm = normalize(name);
  const exact = NAME_MAP.get(norm);
  if (exact !== undefined) return exact;
  for (const [key, canonical] of NAME_MAP) {
    if (norm.length > key.length && norm.endsWith(key)) return canonical;
  }
  return null;
}

// ---------------------------------------------------------------- argument helpers

function strArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function intArg(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Owner/repo from {owner, repo} (or synonyms) or from {full_name: "owner/repo"}. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = strArg(args, ['owner', 'owner_login', 'login', 'user_login', 'org', 'organization', 'user', 'account', 'namespace', 'owner_name']);
  const repo = strArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  const fullName = strArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0 && slash < fullName.length - 1) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  }
  return null;
}

function findRepo(store: Store, owner: string, repo: string): Repo | undefined {
  return owner === OWNER_LOGIN ? getRepo(store, owner, repo) : undefined;
}

// ---------------------------------------------------------------- tool results

type ToolOutcome = { result: unknown } | { errorText: string };

const ok = (result: unknown): ToolOutcome => ({ result });
const err = (errorText: string): ToolOutcome => ({ errorText });

function callCreateRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const name = strArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name === undefined) return err('Missing required argument: name');
  const repo = createRepo(store, OWNER_LOGIN, name, {
    private: args.private === true,
    description: typeof args.description === 'string' ? args.description : '',
  });
  if (!repo) return err('Repository already exists');
  return ok(repoJson(repo));
}

function callGetRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const target = resolveOwnerRepo(args);
  if (target === null) return err('Missing required argument: owner and repo (or full_name)');
  const repo = findRepo(store, target.owner, target.repo);
  if (!repo) return err('Not Found');
  return ok(repoJson(repo));
}

function callCreateIssue(store: Store, args: Record<string, unknown>): ToolOutcome {
  const target = resolveOwnerRepo(args);
  const title = strArg(args, ['title', 'issue_title', 'subject']);
  if (target === null) return err('Missing required argument: owner and repo (or full_name)');
  if (title === undefined) return err('Missing required argument: title');
  const repo = findRepo(store, target.owner, target.repo);
  if (!repo) return err('Not Found');
  const body = typeof args.body === 'string' ? args.body : '';
  return ok(issueJson(repo, createIssueRecord(repo, title, body)));
}

function callListIssues(store: Store, args: Record<string, unknown>): ToolOutcome {
  const target = resolveOwnerRepo(args);
  if (target === null) return err('Missing required argument: owner and repo (or full_name)');
  const repo = findRepo(store, target.owner, target.repo);
  if (!repo) return err('Not Found');
  const state = strArg(args, ['state', 'status']) ?? 'open';
  const query = new URLSearchParams({ state });
  return ok(sortedIssues(repo, query).map((issue) => issueJson(repo, issue)));
}

function callCreatePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const target = resolveOwnerRepo(args);
  const title = strArg(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
  const head = strArg(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  const base = strArg(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
  if (target === null) return err('Missing required argument: owner and repo (or full_name)');
  if (title === undefined) return err('Missing required argument: title');
  if (head === undefined) return err('Missing required argument: head');
  if (base === undefined) return err('Missing required argument: base');
  const repo = findRepo(store, target.owner, target.repo);
  if (!repo) return err('Not Found');
  const body = typeof args.body === 'string' ? args.body : '';
  try {
    return ok(pullJson(createPullRecord(store, repo, head, base, title, body)));
  } catch {
    return err('Invalid branch');
  }
}

function callMergePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const target = resolveOwnerRepo(args);
  const number = intArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (target === null) return err('Missing required argument: owner and repo (or full_name)');
  if (number === undefined) return err('Missing required argument: pull_number');
  const repo = findRepo(store, target.owner, target.repo);
  if (!repo) return err('Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err('Not Found');
  try {
    const { sha } = mergePullRecord(store, repo, pull);
    return ok({ merged: true, sha, message: `Merge pull request #${pull.number} from ${pull.head}`, ...pullJson(pull) });
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Merge failed');
  }
}

function callTool(store: Store, canonical: Canonical, args: Record<string, unknown>): ToolOutcome {
  switch (canonical) {
    case 'create_repo': return callCreateRepo(store, args);
    case 'get_repo': return callGetRepo(store, args);
    case 'create_issue': return callCreateIssue(store, args);
    case 'list_issues': return callListIssues(store, args);
    case 'create_pull_request': return callCreatePullRequest(store, args);
    case 'merge_pull_request': return callMergePullRequest(store, args);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

/** POST /mcp — JSON-RPC 2.0, plain application/json. Auth is decided before anything else. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  if (!checkAuth(req)) { sendJson(res, 401, { message: 'Unauthorized' }); return; }
  const read = await readBody(req);
  if (!read.ok) { rpcError(res, 400, null, -32700, 'Parse error'); return; }
  let body: unknown;
  try {
    body = JSON.parse(read.body.toString());
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error');
    return;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    rpcError(res, 200, isRecord(body) && 'id' in body ? body.id : null, -32600, 'Invalid Request');
    return;
  }
  const id: unknown = 'id' in body ? body.id : null;
  // Notifications carry no id: acknowledge with 202 and no body.
  if (!('id' in body)) {
    res.writeHead(202);
    res.end();
    return;
  }
  const params = isRecord(body.params) ? body.params : {};
  switch (body.method) {
    case 'server/discover': {
      rpcResult(res, id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...serverInfo },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...serverInfo } },
      });
      return;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = offered === PREFERRED_VERSION || (LEGACY_VERSIONS as readonly string[]).includes(offered) ? offered : PREFERRED_VERSION;
      rpcResult(res, id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { ...serverInfo } });
      return;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const canonical = name === '' ? null : resolveTool(name);
      if (canonical === null) {
        rpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const outcome = callTool(store, canonical, args);
      if ('errorText' in outcome) {
        rpcResult(res, id, { content: [{ type: 'text', text: outcome.errorText }], isError: true });
      } else {
        rpcResult(res, id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
          structuredContent: outcome.result,
          isError: false,
        });
      }
      return;
    }
    default: {
      rpcError(res, 200, id, -32601, `Method not found: ${body.method}`);
      return;
    }
  }
}
