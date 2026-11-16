import { createHash } from 'node:crypto';

export function hashObject(type: string, raw: Buffer | Uint8Array): string {
  return createHash('sha1').update(`${type} ${raw.length}\0`).update(raw).digest('hex');
}

// Malformed loose objects throw rather than returning a partial or ambiguous body.
export function parseObjectHeader(buf: Buffer): { type: string; size: number; body: Buffer } {
  const end = buf.indexOf(0);
  if (end < 0) throw new Error('Missing object header terminator');
  const header = buf.subarray(0, end).toString('utf8');
  const match = /^(commit|tree|blob|tag) ([0-9]+)$/.exec(header);
  if (!match || match[0].length !== header.length) throw new Error('Invalid object header');
  const size = Number(match[2]);
  const body = buf.subarray(end + 1);
  if (!Number.isSafeInteger(size) || size !== body.length) throw new Error('Object size mismatch');
  return { type: match[1], size, body };
}
