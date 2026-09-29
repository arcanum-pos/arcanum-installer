// Durable Object migration payloads — what a mistake here would break is a
// live installation's Durable Objects, so every case is spelled out.
import { describe, expect, it } from 'vitest';
import { ContractError, migrationsPayload, netClasses, uploadMetadata, type InstallContext, type WorkerDescriptor } from '../src/contract';
import { suggestSubdomain } from '../src/api';

// arcanum-devicehub's real history, and arcanum-backend's.
const DEVICEHUB = [
  { tag: 'v1', new_sqlite_classes: ['DeviceHub'] },
  { tag: 'v2', deleted_classes: ['DeviceHub'] },
  { tag: 'v3', new_sqlite_classes: ['DeviceHub'] },
];
const BACKEND = [
  { tag: 'v1', new_sqlite_classes: ['SumupChargeCoordinator'] },
  { tag: 'v2', renamed_classes: [{ from: 'SumupChargeCoordinator', to: 'ChargePoller' }] },
  { tag: 'v3', deleted_classes: ['ChargePoller'] },
  { tag: 'v4', new_sqlite_classes: ['ChargePoller'] },
];

describe('netClasses', () => {
  it('replays creates, renames (keeping the storage type) and deletes', () => {
    expect(netClasses(DEVICEHUB)).toEqual({ sqlite: ['DeviceHub'], kv: [] });
    expect(netClasses(BACKEND)).toEqual({ sqlite: ['ChargePoller'], kv: [] });
    expect(netClasses([{ tag: 'v1', new_classes: ['Old'] }, { tag: 'v2', renamed_classes: [{ from: 'Old', to: 'New' }] }])).toEqual({ sqlite: [], kv: ['New'] });
  });

  it('refuses what it cannot replay safely', () => {
    expect(() => netClasses([{ tag: 'v1', transferred_classes: [{ from: 'A', from_script: 'x', to: 'A' }] }])).toThrow(ContractError);
    expect(() => netClasses([{ tag: 'v1', renamed_classes: [{ from: 'Missing', to: 'B' }] }])).toThrow(/Missing/);
  });
});

describe('migrationsPayload', () => {
  it("gives a new script the history's net effect as one step under the latest tag", () => {
    expect(migrationsPayload(DEVICEHUB, null)).toEqual({ new_tag: 'v3', steps: [{ new_sqlite_classes: ['DeviceHub'] }] });
    expect(migrationsPayload(BACKEND, null)).toEqual({ new_tag: 'v4', steps: [{ new_sqlite_classes: ['ChargePoller'] }] });
  });

  it('gives an existing script only the steps after its current tag (like wrangler)', () => {
    expect(migrationsPayload(BACKEND, 'v2')).toEqual({ old_tag: 'v2', new_tag: 'v4', steps: [{ deleted_classes: ['ChargePoller'] }, { new_sqlite_classes: ['ChargePoller'] }] });
    expect(migrationsPayload(BACKEND, 'v4')).toBeUndefined();
  });

  it('sends everything after an unknown current tag, and nothing without a history', () => {
    expect(migrationsPayload(DEVICEHUB, 'v9')!.steps).toHaveLength(3);
    expect(migrationsPayload([], null)).toBeUndefined();
  });
});

describe('suggestSubdomain', () => {
  it('turns an account name into a valid workers.dev name', () => {
    expect(suggestSubdomain("Bertcarels@gmail.com's Account")).toBe('bertcarels-gmail-com');
    expect(suggestSubdomain('Scouts Elewijt')).toBe('scouts-elewijt');
    expect(suggestSubdomain('Café Élan')).toBe('cafe-elan');
    expect(suggestSubdomain('***')).toBe('arcanum');
  });
});

describe('own-instance settings', () => {
  const ctx: InstallContext = {
    publicUrl: 'https://arcanum-bff.club.workers.dev',
    issuerUrl: 'https://login.test',
    answers: {},
    optional: {},
    secrets: {},
    resources: { d1: {}, kv: {}, ratelimitNamespaceId: 'r' },
    currentMigrationTag: null,
  };
  const descriptor = (name: string, env: WorkerDescriptor['env']): WorkerDescriptor => ({
    name,
    main_module: 'index.js',
    compatibility_date: '2026-09-11',
    compatibility_flags: [],
    public_entry: false,
    observability: null,
    bindings: [],
    durable_object_migrations: [],
    assets: null,
    env,
  });
  const envOf = (d: WorkerDescriptor) => (uploadMetadata(d, ctx).bindings as { name: string; text?: string }[]).filter((b) => b.name === 'ORG_CREATION');

  it("always makes the backend 'single' — whatever the descriptor says, or when it says nothing", () => {
    const expected = [{ type: 'plain_text', name: 'ORG_CREATION', text: 'single' }];
    expect(envOf(descriptor('arcanum-backend', {}))).toEqual(expected);
    expect(envOf(descriptor('arcanum-backend', { ORG_CREATION: { kind: 'var', source: 'fixed', value: 'internal' } }))).toEqual(expected);
    expect(envOf(descriptor('arcanum-backend', { ORG_CREATION: { kind: 'var', source: 'fixed', value: 'single' } }))).toEqual(expected);
    expect(envOf(descriptor('arcanum-bff', {}))).toEqual([]);
  });

  it('never sets the demo-instance settings (optional, and the installer gives no value)', () => {
    const d = descriptor('arcanum-backend', {
      DEMO_INSTALL_URL: { kind: 'var', source: 'optional' },
      BOOTSTRAP_API_KEY: { kind: 'secret', source: 'optional' },
    });
    const names = (uploadMetadata(d, ctx).bindings as { name: string }[]).map((b) => b.name);
    expect(names).toEqual(['ORG_CREATION']);
  });
});
