import type { IncomingMessage, ServerResponse } from 'node:http';
import { nextSeq } from './clock.ts';
import { globalId } from './ids.ts';
import { nextIssueNumber, type Repo } from './store.ts';
import { paginate, readJson } from './rest.ts';
import { sendJson } from './server.ts';

export interface Issue { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; createdSeq: number }
export interface Comment { id: number; body: string }
/** Shared record builders (M6): GraphQL mutations + REST handlers call these, never a second copy. */
export function createIssueRecord(repo: Repo, title: string, body: string): Issue {
  const issue: Issue = { number: nextIssueNumber(repo), title, body, state: 'open', labels: [], createdSeq: nextSeq() };
  repo.issues.set(issue.number, issue);
  return issue;
}
export function closeIssueRecord(issue: Issue): void { issue.state = 'closed'; }
export function addCommentRecord(repo: Repo, issueNumber: number, body: string): Comment {
  const comment: Comment = { id: nextSeq(), body };
  const comments = repo.comments.get(issueNumber) ?? [];
  comments.push(comment); repo.comments.set(issueNumber, comments);
  return comment;
}
export const labelJson = (label: { name: string; color?: string }) => ({ name: label.name, color: label.color ?? 'ededed' });
// M7: REST issue objects carry the same global id GraphQL uses for the issue
// (checks-mcp rest-parity reads .id off the REST view and requires it stable).
export const issueJson = (repo: Repo, issue: Issue) => ({ id: globalId('Issue', `${repo.databaseId}:${issue.number}`), number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map(name => ({ name })) });
export const commentJson = (comment: Comment) => ({ id: comment.id, body: comment.body });
export function sortedIssues(repo: Repo, query: URLSearchParams): Issue[] {
  const state = query.get('state') ?? 'open';
  return ([...repo.issues.values()] as Issue[]).filter(i => state === 'all' || i.state === state)
    .sort((a, b) => (a.createdSeq - b.createdSeq) * (query.get('direction') === 'desc' ? -1 : 1));
}

/** Called only after handleRest's shared requireRepo auth/ownership boundary. */
export async function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], url: URL): Promise<void> {
  const error = (status: number, message: string) => sendJson(res, status, { message });
  const list = (items: unknown[]) => {
    const page = paginate(items, url.searchParams, req.headers.host ?? 'entry', url.pathname);
    sendJson(res, 200, page.items, page.headers);
  };
  if (tail[0] === 'labels') {
    const fields = await readJson(req, res); if (!fields) return;
    if (typeof fields.name !== 'string' || !fields.name.trim()) { error(422, 'name is required'); return; }
    const label = repo.labels.get(fields.name) ?? { name: fields.name, color: typeof fields.color === 'string' ? fields.color : 'ededed' };
    repo.labels.set(label.name, label);
    sendJson(res, 201, labelJson(label)); return;
  }
  if (tail.length === 1) {
    if (req.method === 'GET') { list(sortedIssues(repo, url.searchParams).map((issue) => issueJson(repo, issue))); return; }
    if (req.method === 'POST') {
      const fields = await readJson(req, res); if (!fields) return;
      const labels = fields.labels ?? [];
      if (!Array.isArray(labels) || labels.some(name => typeof name !== 'string' || !repo.labels.has(name))) { error(422, 'Unknown label'); return; }
      const issue = createIssueRecord(repo, typeof fields.title === 'string' ? fields.title : '', typeof fields.body === 'string' ? fields.body : '');
      issue.labels = labels;
      sendJson(res, 201, issueJson(repo, issue)); return;
    }
  } else {
    const issue = repo.issues.get(Number(tail[1])) as Issue | undefined;
    if (!issue) { error(404, 'Not Found'); return; }
    if (tail.length === 2) {
      if (req.method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (req.method === 'PATCH') {
        const fields = await readJson(req, res); if (!fields) return;
        if (fields.state !== undefined && fields.state !== 'open' && fields.state !== 'closed') { error(422, 'Invalid state'); return; }
        if (fields.state !== undefined) issue.state = fields.state;
        if (typeof fields.title === 'string') issue.title = fields.title;
        if (typeof fields.body === 'string') issue.body = fields.body;
        sendJson(res, 200, issueJson(repo, issue)); return;
      }
    } else if (tail[2] === 'comments') {
      if (req.method === 'GET') { list(((repo.comments.get(issue.number) ?? []) as Comment[]).map(commentJson)); return; }
      if (req.method === 'POST') {
        const fields = await readJson(req, res); if (!fields) return;
        if (typeof fields.body !== 'string') { error(422, 'body is required'); return; }
        sendJson(res, 201, commentJson(addCommentRecord(repo, issue.number, fields.body))); return;
      }
    }
  }
  error(404, 'Not Found');
}
