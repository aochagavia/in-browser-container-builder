import { makeTar, type TarFile } from './tar';

export const TARGET_OS = 'linux';

export interface Reference {
  repo: string;
  tag: string;
}

export function asRaw(r: Reference): string {
  return `${r.repo}:${r.tag}`;
}

export function fromRaw(raw: string): Reference {
  const idx = raw.lastIndexOf(':');
  if (idx === -1) {
    return {
      repo: raw,
      tag: 'latest',
    };
  }

  return {
    repo: raw.slice(0, idx),
    tag: raw.slice(idx + 1),
  };
}

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { os: string; architecture: string; variant?: string };
}

export interface Index {
  schemaVersion: number;
  mediaType?: string;
  manifests: Descriptor[];
}

export interface Manifest {
  schemaVersion: number;
  mediaType?: string;
  config: Descriptor;
  layers: Descriptor[];
}

async function fetchManifest<T>(registry: string, repo: string, tagOrDigest: string): Promise<T> {
  const url = `${registry}/v2/${repo}/manifests/${tagOrDigest}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Manifest request failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function fetchBlob(registry: string, repo: string, digest: string): Promise<Uint8Array> {
  const url = `${registry}/v2/${repo}/blobs/${digest}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blob request failed: ${res.status} ${res.statusText} (${digest})`);
  return new Uint8Array(await res.arrayBuffer());
}

export function formatSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(2)} ${units[unit]}`;
}

function digestHex(digest: string): string {
  const idx = digest.indexOf(':');
  return idx === -1 ? digest : digest.slice(idx + 1);
}

export async function fetchIndex(registry: string, reference: Reference): Promise<Index> {
  return fetchManifest<Index>(registry, reference.repo, reference.tag);
}

export function findPlatformManifest(index: Index, arch: any): Descriptor {
  const os = TARGET_OS;
  const match = index.manifests.find(
    (m) => m.platform?.os === os && m.platform?.architecture === arch && !m.platform?.variant,
  );
  if (!match) {
    throw new Error(`No manifest for ${os}/${arch} found in index`);
  }
  return match;
}

export async function fetchPlatformManifest(
  registry: string,
  repo: string,
  digest: string,
): Promise<Manifest> {
  return fetchManifest<Manifest>(registry, repo, digest);
}

export async function buildTar(
  registry: string,
  base_image_repo: string,
  final_image_reference: Reference,
  manifest: Manifest,
  onLog: (msg: string) => void,
): Promise<Uint8Array> {
  const configHex = digestHex(manifest.config.digest);
  const layerHexes = manifest.layers.map((l) => digestHex(l.digest));

  onLog(`\nFetching config blob (${formatSize(manifest.config.size)})...`);
  const configBytes = await fetchBlob(registry, base_image_repo, manifest.config.digest);
  onLog(` done.`);

  const layerBytes: Uint8Array[] = [];
  for (const [i, layer] of manifest.layers.entries()) {
    onLog(`\nFetching layer ${i + 1} of ${manifest.layers.length} (${formatSize(layer.size)})...`);
    layerBytes.push(await fetchBlob(registry, base_image_repo, layer.digest));
    onLog(' done.');
  }

  const dockerManifest = [
    {
      Config: `blobs/sha256/${configHex}`,
      RepoTags: [`${final_image_reference.repo}:${final_image_reference.tag}`],
      Layers: layerHexes.map((h) => `blobs/sha256/${h}`),
    },
  ];

  const encoder = new TextEncoder();
  const files: TarFile[] = [
    {
      name: 'manifest.json',
      data: encoder.encode(JSON.stringify(dockerManifest, null, 2)),
    },
    { name: `blobs/sha256/${configHex}`, data: configBytes },
    ...manifest.layers.map((_, i) => ({
      name: `blobs/sha256/${layerHexes[i]}`,
      data: layerBytes[i],
    })),
  ];

  onLog('\nPacking tar...');
  const tar = makeTar(files);
  onLog(' done.');

  return tar;
}

export function triggerDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/x-tar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
