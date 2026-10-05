// Reading published Arcanum releases (arcanum-pos/arcanum-releases): the
// releases.json index, a release's manifest, and its files — every file
// checked against the size and sha256 in the manifest before use.
import { sha256Hex } from './crypto';
import { TextError } from './i18n';

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
  // The installer itself (not one of the components); absent in older releases.
  installer?: { file: string; commit: string; sha256: string };
  files: Record<string, { size: number; sha256: string }>;
}

export class ReleaseError extends TextError {}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new ReleaseError((t) => t.release.fetchFailed(url, res.status));
  return (await res.json()) as T;
}

export async function fetchIndex(indexUrl: string): Promise<ReleaseIndex> {
  // Not from Cloudflare's cache: a release published minutes ago must show.
  const index = await getJson<ReleaseIndex>(indexUrl, { cache: 'no-store' });
  if (index?.format !== 'arcanum-releases-index' || !Array.isArray(index.releases)) throw new ReleaseError((t) => t.release.indexFormat);
  return index;
}

// -1 / 0 / 1: "0.1.24" < "0.1.25-dev.1" < "0.1.25-dev.2" < "0.1.25" —
// numeric parts, then a release above its own pre-releases, then the
// pre-release parts (numbers numerically). As arcanum-releases' lib.mjs.
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => [v.split('-')[0], v.split('-').slice(1).join('-')] as const;
  const [[ca, pa], [cb, pb]] = [split(a), split(b)];
  const x = ca.split('.').map((n) => Number(n) || 0);
  const y = cb.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1;
  const [xs, ys] = [pa.split('.'), pb.split('.')];
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    if (xs[i] === ys[i]) continue;
    const numeric = /^\d+$/.test(xs[i]) && /^\d+$/.test(ys[i]);
    return numeric ? (Number(xs[i]) < Number(ys[i]) ? -1 : 1) : xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

// The releases an installation may choose from: releases.json, and on the
// development channel also releases-dev.json next to it (development builds
// — never listed in releases.json, so older installers never see them).
// Newest first.
export async function releaseIndexFor(indexUrl: string, channel: 'stable' | 'dev' | undefined): Promise<ReleaseIndex> {
  const index = await fetchIndex(indexUrl);
  if (channel !== 'dev') return index;
  const dev = await fetchIndex(indexUrl.replace(/releases\.json$/, 'releases-dev.json')).catch(() => null);
  const releases = [...index.releases, ...(dev?.releases ?? [])].sort((p, q) => compareVersions(q.version, p.version));
  return { ...index, releases };
}

// Only releases this installer can install.
export function installable(index: ReleaseIndex): ReleaseIndexEntry[] {
  return index.releases.filter((r) => r.format_version === SUPPORTED_FORMAT_VERSION);
}

export async function fetchManifest(manifestUrl: string): Promise<Manifest> {
  const manifest = await getJson<Manifest>(manifestUrl);
  if (manifest?.format !== 'arcanum-release') throw new ReleaseError((t) => t.release.notARelease);
  if (manifest.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw new ReleaseError((t) => t.release.format(manifest.version, manifest.format_version, SUPPORTED_FORMAT_VERSION));
  }
  return manifest;
}

// A release file, verified against the manifest — never used unverified.
export async function fetchReleaseFile(manifestUrl: string, manifest: Manifest, name: string): Promise<ArrayBuffer> {
  const expected = manifest.files[name];
  if (!expected) throw new ReleaseError((t) => t.release.notInRelease(name, manifest.version));
  const url = manifestUrl.replace(/manifest\.json$/, encodeURIComponent(name));
  const res = await fetch(url);
  if (!res.ok) throw new ReleaseError((t) => t.release.fetchFailed(name, res.status));
  const data = await res.arrayBuffer();
  if (data.byteLength !== expected.size || (await sha256Hex(data)) !== expected.sha256) {
    throw new ReleaseError((t) => t.release.checksum(name));
  }
  return data;
}

export async function fetchReleaseJson<T>(manifestUrl: string, manifest: Manifest, name: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await fetchReleaseFile(manifestUrl, manifest, name))) as T;
}
