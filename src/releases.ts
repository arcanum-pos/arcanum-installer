// Reading published Arcanum releases (arcanum-pos/arcanum-releases): the
// releases.json index, a release's manifest, and its files — every file
// checked against the size and sha256 in the manifest before use.
import { sha256Hex } from './crypto';

export const SUPPORTED_FORMAT_VERSION = 1;

export interface ReleaseIndexEntry {
  version: string;
  tag: string;
  prerelease: boolean;
  released_at: string;
  format_version?: number;
  manifest_url: string;
  notes_url: string;
}

export interface ReleaseIndex {
  format: 'arcanum-releases-index';
  latest: string | null;
  releases: ReleaseIndexEntry[];
}

export interface Manifest {
  format: 'arcanum-release';
  format_version: number;
  version: string;
  released_at: string;
  license: string;
  components: Record<string, { repo: string; commit: string; source: string }>;
  files: Record<string, { size: number; sha256: string }>;
}

export class ReleaseError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ReleaseError(`Kon ${url} niet ophalen (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export async function fetchIndex(indexUrl: string): Promise<ReleaseIndex> {
  const index = await getJson<ReleaseIndex>(indexUrl);
  if (index?.format !== 'arcanum-releases-index' || !Array.isArray(index.releases)) throw new ReleaseError('releases.json heeft een onbekend formaat');
  return index;
}

// Only releases this installer can install.
export function installable(index: ReleaseIndex): ReleaseIndexEntry[] {
  return index.releases.filter((r) => r.format_version === SUPPORTED_FORMAT_VERSION);
}

export async function fetchManifest(manifestUrl: string): Promise<Manifest> {
  const manifest = await getJson<Manifest>(manifestUrl);
  if (manifest?.format !== 'arcanum-release') throw new ReleaseError('Dit is geen Arcanum-release');
  if (manifest.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw new ReleaseError(`Release ${manifest.version} gebruikt formaat ${manifest.format_version}; deze installer kent formaat ${SUPPORTED_FORMAT_VERSION} — werk de installer bij`);
  }
  return manifest;
}

// A release file, verified against the manifest — never used unverified.
export async function fetchReleaseFile(manifestUrl: string, manifest: Manifest, name: string): Promise<ArrayBuffer> {
  const expected = manifest.files[name];
  if (!expected) throw new ReleaseError(`${name} hoort niet bij release ${manifest.version}`);
  const url = manifestUrl.replace(/manifest\.json$/, encodeURIComponent(name));
  const res = await fetch(url);
  if (!res.ok) throw new ReleaseError(`Kon ${name} niet ophalen (HTTP ${res.status})`);
  const data = await res.arrayBuffer();
  if (data.byteLength !== expected.size || (await sha256Hex(data)) !== expected.sha256) {
    throw new ReleaseError(`${name} komt niet overeen met de controlesom in het manifest — download afgebroken`);
  }
  return data;
}

export async function fetchReleaseJson<T>(manifestUrl: string, manifest: Manifest, name: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await fetchReleaseFile(manifestUrl, manifest, name))) as T;
}
