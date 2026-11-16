import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject } from './objects.ts';
import { getObject, putObjectRaw } from './store.ts';
import type { Store } from './store.ts';

const names: Readonly<Record<number, string>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const codes: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

class Reader {
  offset = 0;
  readonly bytes: Buffer | Uint8Array;
  constructor(bytes: Buffer | Uint8Array) { this.bytes = bytes; }
  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error('Truncated pack or delta');
    return this.bytes[this.offset++];
  }
  varint(): number {
    let value = 0;
    for (let shift = 0; shift <= 63; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) throw new Error('Unsafe delta size');
      if (!(byte & 128)) return value;
    }
    throw new Error('Delta varint too long');
  }
}

export function applyDelta(base: Buffer | Uint8Array, delta: Buffer | Uint8Array): Buffer {
  const reader = new Reader(delta);
  if (reader.varint() !== base.length) throw new Error('Delta source size mismatch');
  const targetSize = reader.varint();
  const output = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (reader.offset < delta.length) {
    const op = reader.byte();
    if (op & 128) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) offset += reader.byte() * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (op & (16 << bit)) size += reader.byte() * 2 ** (8 * bit);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > targetSize) throw new Error('Delta copy out of bounds');
      output.set(base.subarray(offset, offset + size), written);
      written += size;
    } else {
      if (op === 0) throw new Error('Invalid delta opcode');
      if (reader.offset + op > delta.length || written + op > targetSize) throw new Error('Delta insert out of bounds');
      output.set(delta.subarray(reader.offset, reader.offset + op), written);
      reader.offset += op;
      written += op;
    }
  }
  if (written !== targetSize) throw new Error('Delta target size mismatch');
  return output;
}

type Resolved = { type: string; raw: Buffer; oid: string };
type Entry = { offset: number; code: number; data: Buffer; baseOffset?: number; baseOid?: string; result?: Resolved };

export function parsePack(buf: Buffer, store: Store): string[] {
  if (buf.length < 32 || buf.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('Invalid pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('Unsupported pack version');
  const end = buf.length - 20;
  if (!createHash('sha1').update(buf.subarray(0, end)).digest().equals(buf.subarray(end))) throw new Error('Bad pack trailer');
  const reader = new Reader(buf.subarray(0, end));
  reader.offset = 12;
  const count = buf.readUInt32BE(8);
  const entries: Entry[] = [];
  const offsets = new Map<number, Entry>();
  for (let index = 0; index < count; index++) {
    const offset = reader.offset;
    let byte = reader.byte();
    const code = (byte >> 4) & 7;
    if (!names[code] && code !== 6 && code !== 7) throw new Error('Unknown pack type');
    let size = byte & 15;
    let shift = 4;
    while (byte & 128) {
      if (shift > 63) throw new Error('Pack varint too long');
      byte = reader.byte();
      size += (byte & 127) * 2 ** shift;
      shift += 7;
      if (!Number.isSafeInteger(size)) throw new Error('Unsafe pack size');
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) {
      byte = reader.byte();
      let distance = byte & 127;
      while (byte & 128) {
        byte = reader.byte();
        distance = (distance + 1) * 128 + (byte & 127);
        if (!Number.isSafeInteger(distance)) throw new Error('Unsafe base offset');
      }
      baseOffset = offset - distance;
      if (baseOffset <= 0 || baseOffset > offset) throw new Error('Invalid delta base offset');
    } else if (code === 7) {
      if (reader.offset + 20 > end) throw new Error('Truncated REF_DELTA base');
      baseOid = buf.subarray(reader.offset, reader.offset + 20).toString('hex');
      reader.offset += 20;
    }
    // info exposes the exact compressed byte count, leaving the following stream untouched.
    const inflated = inflateSync(buf.subarray(reader.offset, end), { info: true, maxOutputLength: Math.max(1, size) }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    const data = inflated.buffer;
    if (data.length !== size) throw new Error('Pack entry size mismatch');
    reader.offset += inflated.engine.bytesWritten;
    const entry: Entry = { offset, code, data, baseOffset, baseOid };
    entries.push(entry);
    offsets.set(offset, entry);
  }
  if (reader.offset !== end) throw new Error('Stray bytes after pack entries');

  const resolved = new Map<string, Resolved>();
  const resolving = new Set<number>();
  function resolve(entry: Entry, depth: number): Resolved {
    if (depth > 64) throw new Error('Delta recursion limit');
    if (entry.result) return entry.result;
    if (resolving.has(entry.offset)) throw new Error('Delta cycle');
    resolving.add(entry.offset);
    let type: string;
    let raw: Buffer;
    if (entry.code === 6 || entry.code === 7) {
      let base: { type: string; raw: Buffer } | undefined;
      if (entry.baseOffset !== undefined) {
        const previous = offsets.get(entry.baseOffset);
        if (!previous) throw new Error('Missing delta base offset');
        base = resolve(previous, depth + 1);
      } else if (entry.baseOid !== undefined) {
        base = resolved.get(entry.baseOid) ?? getObject(store, entry.baseOid);
      }
      if (!base) throw new Error('Missing delta base');
      type = base.type;
      raw = applyDelta(base.raw, entry.data);
    } else {
      type = names[entry.code];
      raw = entry.data;
    }
    const result = { type, raw, oid: hashObject(type, raw) };
    entry.result = result;
    resolved.set(result.oid, result);
    resolving.delete(entry.offset);
    return result;
  }
  const oids = new Set<string>();
  for (const entry of entries) oids.add(resolve(entry, 0).oid);
  // Publish only after the entire pack has resolved successfully.
  for (const oid of oids) {
    const object = resolved.get(oid)!;
    putObjectRaw(store, oid, object.type, object.raw);
  }
  return [...oids];
}

function entryHeader(code: number, length: number): Buffer {
  const bytes: number[] = [];
  let byte = (code << 4) | (length % 16);
  length = Math.floor(length / 16);
  while (length > 0) {
    bytes.push(byte | 128);
    byte = length % 128;
    length = Math.floor(length / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

export function buildPack(oids: string[], store: Store): Buffer {
  const rank: Readonly<Record<string, number>> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const objects = [...new Set(oids)].map(oid => {
    const object = getObject(store, oid);
    if (!object) throw new Error(`Unknown object: ${oid}`);
    if (!Object.hasOwn(codes, object.type)) throw new Error('Unknown object type');
    return { oid, ...object };
  });
  objects.sort((a, b) => rank[a.type] - rank[b.type]
    || (a.type === 'commit' ? 0 : a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const chunks = [header];
  for (const object of objects) {
    chunks.push(entryHeader(codes[object.type], object.raw.length), deflateSync(object.raw, { level: 6 }));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
