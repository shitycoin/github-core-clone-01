export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('Pkt-line payload too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
export function pktLineFlush(): Buffer { return Buffer.from('0000'); }
export function pktLineDelim(): Buffer { return Buffer.from('0001'); }
export function pktLineResponseEnd(): Buffer { return Buffer.from('0002'); }
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  return Buffer.concat(items.map(item => item === 'flush' ? pktLineFlush()
    : item === 'delim' ? pktLineDelim()
    : item === 'response-end' ? pktLineResponseEnd() : encodePktLine(item)));
}

export class PktLineDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private start = 0;
  private end = 0;
  private ended = false;
  get bufferedBytes(): number { return this.end - this.start; }
  get complete(): boolean { return this.ended && this.bufferedBytes === 0; }
  push(chunk: Buffer | Uint8Array): void {
    if (this.ended) throw new Error('Pkt-line stream already finished');
    if (!chunk.length) return;
    if (this.end + chunk.length > this.buffer.length) {
      const pending = this.bufferedBytes;
      const capacity = Math.max(256, pending + chunk.length, pending * 2);
      const next = Buffer.allocUnsafe(capacity);
      next.set(this.buffer.subarray(this.start, this.end));
      this.buffer = next;
      this.start = 0;
      this.end = pending;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }
  finish(): void { this.ended = true; }
  next(): GitPacket | null {
    if (this.bufferedBytes === 0) return null;
    if (this.bufferedBytes < 4) return this.incomplete();
    const prefix = this.buffer.subarray(this.start, this.start + 4).toString('utf8');
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) throw new Error('Invalid pkt-line length');
    const length = Number.parseInt(prefix, 16);
    if (length <= 2) {
      this.start += 4;
      return length === 0 ? { kind: 'flush' } : length === 1 ? { kind: 'delim' } : { kind: 'response-end' };
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error('Invalid pkt-line length');
    if (this.bufferedBytes < length) return this.incomplete();
    const raw = this.buffer.subarray(this.start, this.start + length);
    this.start += length;
    return { kind: 'data', payload: raw.subarray(4), raw };
  }
  private incomplete(): null {
    if (this.ended) throw new Error('Truncated pkt-line');
    return null;
  }
}

export function encodeSideband(band: 1 | 2 | 3, data: Buffer | Uint8Array): Buffer {
  if (band !== 1 && band !== 2 && band !== 3) throw new Error('Invalid sideband');
  if (data.length + 1 > PKT_LINE_MAX_PAYLOAD) throw new Error('Sideband payload too large');
  return encodePktLine(Buffer.concat([Buffer.from([band]), data]));
}
export function splitSideband(band: 1 | 2 | 3, data: Buffer | Uint8Array): Buffer[] {
  const packets: Buffer[] = [];
  const limit = PKT_LINE_MAX_PAYLOAD - 1;
  if (!data.length) return [encodeSideband(band, data)];
  for (let offset = 0; offset < data.length; offset += limit) {
    packets.push(encodeSideband(band, data.subarray(offset, offset + limit)));
  }
  return packets;
}
