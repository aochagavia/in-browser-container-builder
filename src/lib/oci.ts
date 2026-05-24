import { makeTar, type TarFile } from './tar';

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

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { os: string; architecture: string; variant?: string };
}

interface Index {
  schemaVersion: number;
  mediaType?: string;
  manifests: Descriptor[];
}

interface Manifest {
  schemaVersion: number;
  config: Descriptor;
  layers: Descriptor[];
}

const OCI_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const TARGET_OS = 'linux';
const SUPPORTED_CPU_ARCHITECTURES = ['amd64', 'arm64'];
const ENTRYPOINT_PATH = '/opt/aochagavia/entrypoint.sh';

async function fetchManifest<T>(
  registry: string,
  repo: string,
  tagOrDigest: string,
): Promise<Response> {
  const url = `${registry}/v2/${repo}/manifests/${tagOrDigest}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status} ${res.statusText}`);
  return res;
}

async function fetchBlob(registry: string, repo: string, digest: string): Promise<Uint8Array> {
  const url = `${registry}/v2/${repo}/blobs/${digest}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status} ${res.statusText} (${digest})`);
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

function stripDigestPrefix(digest: string): string {
  const idx = digest.indexOf(':');
  return idx === -1 ? digest : digest.slice(idx + 1);
}

async function sha256(bytes: Uint8Array): Promise<{ digest: string; hex: string }> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { digest: `sha256:${hex}`, hex };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface EntrypointLayer {
  uncompressedDigest: string;
  compressedBytes: Uint8Array;
  compressedDigest: string;
  mediaType: string;
}

async function buildEntrypointLayer(script: string): Promise<EntrypointLayer> {
  const scriptBytes = new TextEncoder().encode(script);
  const layerTar = makeTar([
    { name: ENTRYPOINT_PATH.replace(/^\//, ''), data: scriptBytes, mode: 0o755 },
  ]);
  const uncompressed = await sha256(layerTar);
  const compressedBytes = await gzip(layerTar);
  const compressed = await sha256(compressedBytes);
  return {
    uncompressedDigest: uncompressed.digest,
    compressedBytes,
    compressedDigest: compressed.digest,
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
  };
}

async function buildNewImageMetadata(
  baseImage: PlatformSpecificImage,
  entrypointLayer: EntrypointLayer,
): Promise<NewImageMetadata> {
  // Add new layer to config (rootfs + history)
  const config = JSON.parse(new TextDecoder().decode(baseImage.configBytes));
  config.config = config.config ?? {};
  config.config.Entrypoint = [ENTRYPOINT_PATH];
  config.config.Cmd = [];
  config.rootfs = config.rootfs ?? { type: 'layers', diff_ids: [] };
  config.rootfs.diff_ids = [...(config.rootfs.diff_ids ?? []), entrypointLayer.uncompressedDigest];
  config.history = [
    ...(config.history ?? []),
    {
      created: new Date().toISOString(),
      created_by: `entrypoint layer added in-browser`,
    },
  ];
  const configBytes = new TextEncoder().encode(JSON.stringify(config));
  const configHash = await sha256(configBytes);

  // Add new layer to manifest
  const manifest = JSON.parse(new TextDecoder().decode(baseImage.manifestBytes));
  manifest.config = {
    ...manifest.config,
    digest: configHash.digest,
    size: configBytes.length,
  };
  manifest.layers = [
    ...manifest.layers,
    {
      mediaType: entrypointLayer.mediaType,
      digest: entrypointLayer.compressedDigest,
      size: entrypointLayer.compressedBytes.length,
    },
  ];
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestHash = await sha256(manifestBytes);
  const manifestMediaType: string = manifest.mediaType ?? baseImage.manifestDescriptor.mediaType;

  const layers = baseImage.manifest.layers.map((layer, i) => ({
    digest: layer.digest,
    bytes: baseImage.layerBytes[i],
  }));
  layers.push({
    digest: entrypointLayer.compressedDigest,
    bytes: entrypointLayer.compressedBytes,
  });

  return {
    arch: baseImage.arch,
    manifestBytes,
    manifestMediaType,
    manifestDigest: manifestHash.digest,
    configBytes,
    configDigest: configHash.digest,
    layers,
  };
}

export async function fetchIndex(registry: string, reference: Reference): Promise<Index> {
  const index = await fetchManifest<Index>(registry, reference.repo, reference.tag);
  return await index.json();
}

// Expand an image reference to its fully-qualified canonical form
// (e.g. `my-image:latest` -> `docker.io/library/my-image:latest`).
// This is necessary for `docker load -i <image>` to work properly.
function canonicalImageReference(ref: Reference): string {
  let repo = ref.repo;
  const firstSlash = repo.indexOf('/');
  if (firstSlash === -1) {
    repo = `docker.io/library/${repo}`;
  } else {
    const firstPart = repo.slice(0, firstSlash);
    const isRegistry =
      firstPart.includes('.') || firstPart.includes(':') || firstPart === 'localhost';
    if (!isRegistry) {
      repo = `docker.io/${repo}`;
    }
  }
  return `${repo}:${ref.tag}`;
}

export function findPlatformManifest(index: Index, arch: string): Descriptor {
  const match = index.manifests.find(
    (m) => m.platform?.os === TARGET_OS && m.platform?.architecture === arch,
  );
  if (!match) {
    throw new Error(`No manifest for ${TARGET_OS}/${arch} found in the base image's index`);
  }
  return match;
}

interface PlatformSpecificImage {
  arch: string;
  manifestDescriptor: Descriptor;
  manifestBytes: Uint8Array;
  manifest: Manifest;
  configBytes: Uint8Array;
  layerBytes: Uint8Array[];
}

interface NewImageMetadata {
  arch: string;
  manifestBytes: Uint8Array;
  manifestDigest: string;
  manifestMediaType: string;
  configBytes: Uint8Array;
  configDigest: string;
  layers: { digest: string; bytes: Uint8Array }[];
}

async function fetchPlatformSpecificImage(
  registry: string,
  baseImageReference: Reference,
  index: Index,
  arch: string,
  onLog: (msg: string) => void,
): Promise<PlatformSpecificImage> {
  const manifestDescriptor = findPlatformManifest(index, arch);

  onLog(
    `\n\n[${arch}] Fetching base image manifest for ${arch} (${formatSize(manifestDescriptor.size)})...`,
  );
  const manifestResponse = await fetchManifest(
    registry,
    baseImageReference.repo,
    manifestDescriptor.digest,
  );
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  onLog(' done.');

  onLog(`\n[${arch}] Fetching base image config blob (${formatSize(manifest.config.size)})...`);
  const configBytes = await fetchBlob(registry, baseImageReference.repo, manifest.config.digest);
  onLog(' done.');

  const layerBytes: Uint8Array[] = [];
  for (const [i, layer] of manifest.layers.entries()) {
    onLog(
      `\n[${arch}] Fetching base image layer ${i + 1} of ${manifest.layers.length} (${formatSize(layer.size)})...`,
    );
    layerBytes.push(await fetchBlob(registry, baseImageReference.repo, layer.digest));
    onLog(' done.');
  }

  return { arch, manifestDescriptor, manifestBytes, manifest, configBytes, layerBytes };
}

// Build a multi-arch container image and package it as an OCI image layout in a tar archive
// (to be loaded through `docker load -i <file>`)
export async function buildImageAsDockerTar(
  registry: string,
  baseImageReference: Reference,
  finalImageReference: Reference,
  entrypointScript: string,
  onLog: (msg: string) => void,
): Promise<Uint8Array> {
  onLog('Fetching base image index...');
  const baseImageIndex = await fetchIndex(registry, baseImageReference);
  onLog(' done.');

  const platformSpecificImages: PlatformSpecificImage[] = [];
  for (const arch of SUPPORTED_CPU_ARCHITECTURES) {
    platformSpecificImages.push(
      await fetchPlatformSpecificImage(registry, baseImageReference, baseImageIndex, arch, onLog),
    );
  }

  // Build the entrypoint layer once (the script is identical across architectures).
  onLog(`\n\nBuilding entrypoint layer...`);
  const entrypointLayer = await buildEntrypointLayer(entrypointScript);
  onLog(` done (${formatSize(entrypointLayer.compressedBytes.length)}).`);

  onLog('\nBuilding new image manifests and configs...');
  const newImages: NewImageMetadata[] = [];
  for (const img of platformSpecificImages) {
    newImages.push(await buildNewImageMetadata(img, entrypointLayer));
  }
  onLog(' done.');

  // Build the multi-arch index referencing the new image's manifests
  const newImageIndex = {
    schemaVersion: 2,
    mediaType: OCI_INDEX_MEDIA_TYPE,
    manifests: newImages.map(({ arch, manifestMediaType, manifestDigest, manifestBytes }) => ({
      mediaType: manifestMediaType,
      digest: manifestDigest,
      size: manifestBytes.length,
      platform: { os: TARGET_OS, architecture: arch },
    })),
  };
  const newImageIndexBytes = new TextEncoder().encode(JSON.stringify(newImageIndex));
  const newImageIndexHash = await sha256(newImageIndexBytes);
  const newImageReference = canonicalImageReference(finalImageReference);

  // This additional tar index is what tells Docker how to import the image (e.g., the image's tag)
  const tarIndex = {
    schemaVersion: 2,
    mediaType: OCI_INDEX_MEDIA_TYPE,
    manifests: [
      {
        mediaType: OCI_INDEX_MEDIA_TYPE,
        digest: newImageIndexHash.digest,
        size: newImageIndexBytes.length,
        annotations: {
          'io.containerd.image.name': newImageReference,
          'org.opencontainers.image.ref.name': finalImageReference.tag,
        },
      },
    ],
  };
  const tarIndexBytes = new TextEncoder().encode(JSON.stringify(tarIndex, null, 2));
  const ociLayoutBytes = new TextEncoder().encode(
    JSON.stringify({ imageLayoutVersion: '1.0.0' }, null, 2),
  );

  // Collect all blobs, deduplicated by digest
  const blobsByDigest = new Map<string, Uint8Array>();
  blobsByDigest.set(newImageIndexHash.digest, newImageIndexBytes);
  for (const newImage of newImages) {
    blobsByDigest.set(newImage.manifestDigest, newImage.manifestBytes);
    blobsByDigest.set(newImage.configDigest, newImage.configBytes);
    for (const layer of newImage.layers) {
      blobsByDigest.set(layer.digest, layer.bytes);
    }
  }

  const files: TarFile[] = [
    { name: 'oci-layout', data: ociLayoutBytes },
    { name: 'index.json', data: tarIndexBytes },
    ...Array.from(blobsByDigest.entries()).map(([digest, data]) => ({
      name: `blobs/sha256/${stripDigestPrefix(digest)}`,
      data,
    })),
  ];

  onLog('\n\nPacking multi-platform image as a docker-compatible tar archive...');
  const tar = makeTar(files);
  onLog(` done.\nImage built (${formatSize(tar.length)}).`);

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
