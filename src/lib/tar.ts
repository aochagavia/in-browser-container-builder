// warning: vibe-coded tar writer ahead, reuse at your own risk

export interface TarFile {
  name: string;
  data: Uint8Array;
  mode?: number;
  mtime?: number;
}

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(buf: Uint8Array, offset: number, value: string, length: number): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length)
    throw new Error(`Field too long: "${value}" (${bytes.length} > ${length})`);
  buf.set(bytes, offset);
}

function writeOctal(buf: Uint8Array, offset: number, value: number, length: number): void {
  const s = value.toString(8).padStart(length - 1, '0');
  writeString(buf, offset, s, length - 1);
}

function header(file: TarFile): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeString(h, 0, file.name, 100);
  writeOctal(h, 100, file.mode ?? 0o644, 8);
  writeOctal(h, 108, 0, 8);
  writeOctal(h, 116, 0, 8);
  writeOctal(h, 124, file.data.length, 12);
  writeOctal(h, 136, file.mtime ?? Math.floor(Date.now() / 1000), 12);
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  h[156] = 0x30;
  writeString(h, 257, 'ustar', 6);
  writeString(h, 263, '00', 2);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  writeOctal(h, 148, sum, 7);
  h[155] = 0x20;
  return h;
}

export function makeTar(files: TarFile[]): Uint8Array {
  let total = 0;
  for (const f of files) {
    total += BLOCK + Math.ceil(f.data.length / BLOCK) * BLOCK;
  }
  total += BLOCK * 2;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of files) {
    out.set(header(f), offset);
    offset += BLOCK;
    out.set(f.data, offset);
    offset += Math.ceil(f.data.length / BLOCK) * BLOCK;
  }
  return out;
}
