// The Docker target's Node pieces (SELF_HOSTING.md, compose): the state in a
// file on the installer's volume, its key made there once, and the engine's
// API over a unix socket (a tiny server standing in for dockerd).
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Docker } from '../../src/docker/client';
import { composeEnv, dockerEnv } from '../../src/node';
import { dockerTransport } from '../../src/node/docker-transport';
import { FileKV } from '../../src/node/file-kv';
import { composeFolder } from '../../src/node/compose-folder';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tresjr-installer-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the state in a file', () => {
  it('get as text or JSON, put with an expiry, delete — kept across a restart', async () => {
    const dir = tempDir();
    const kv = new FileKV(join(dir, 'state.json'));
    await kv.put('state', JSON.stringify({ v: 1 }));
    await kv.put('session:a', 'x', { expirationTtl: 60 });
    expect(await kv.get('state', 'json')).toEqual({ v: 1 });
    expect(await kv.get('session:a')).toBe('x');
    expect(await new FileKV(join(dir, 'state.json')).get('state', 'json')).toEqual({ v: 1 });
    await kv.delete('session:a');
    expect(await kv.get('session:a')).toBeNull();
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
  });

  it('writes at the same time all land; expired keys are gone', async () => {
    const kv = new FileKV(join(tempDir(), 'state.json'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => kv.put(`k${i}`, String(i))));
    expect(await Promise.all(Array.from({ length: 20 }, (_, i) => kv.get(`k${i}`)))).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
    await kv.put('old', 'x', { expirationTtl: -1 });
    expect(await kv.get('old')).toBeNull();
  });
});

describe('the Docker environment', () => {
  it('the state key: made in the volume the first time, the same one after', () => {
    const dir = tempDir();
    const first = dockerEnv({ DATA_DIR: dir, INSTALLER_TARGET: 'docker' }, new Docker(async () => ({ status: 200, body: null, text: '' }), 'tresjr'));
    expect(first.INSTALLER_STATE_KEY!.length).toBeGreaterThanOrEqual(64);
    expect(readFileSync(join(dir, 'installer-state.key'), 'utf8')).toBe(first.INSTALLER_STATE_KEY);
    expect(dockerEnv({ DATA_DIR: dir }, first.DOCKER).INSTALLER_STATE_KEY).toBe(first.INSTALLER_STATE_KEY);
    expect(first.INSTALLER_CONTAINER).toBe('tresjr-installer');
    // One given: that one.
    expect(dockerEnv({ DATA_DIR: dir, INSTALLER_STATE_KEY: 'given' }, first.DOCKER).INSTALLER_STATE_KEY).toBe('given');
  });
});

describe('the engine over its socket', () => {
  it('nothing there (nerdctl has no API socket): says what the installer needs instead of ENOENT/ECONNREFUSED', async () => {
    const transport = dockerTransport({ DOCKER_SOCKET: join(tempDir(), 'docker.sock') });
    await expect(transport('GET', '/version')).rejects.toThrow(/No container engine at .*docker\.sock \(ENOENT\)\..*nerdctl has none.*dockerd \(moby\)/);
  });

  it('JSON answers, a 404, and a container log unframed', async () => {
    const socket = join(tempDir(), 'docker.sock');
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/containers/tresjr-bff/json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ Id: 'abc', State: { Running: true } }));
      if (req.url?.startsWith('/containers/abc/logs')) {
        const text = Buffer.from('listening on :8080\n');
        return res.writeHead(200).end(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, text.length]), text]));
      }
      return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'No such container' }));
    });
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      const docker = new Docker(dockerTransport({ DOCKER_SOCKET: socket }), 'tresjr');
      expect(await docker.inspect('tresjr-bff')).toEqual({ Id: 'abc', State: { Running: true } });
      expect(await docker.inspect('nope')).toBeNull();
      expect(await docker.logs('abc')).toBe('listening on :8080');
      expect(seen).toEqual(['GET /containers/tresjr-bff/json', 'GET /containers/nope/json', 'GET /containers/abc/logs?stdout=true&stderr=true&tail=20']);
    } finally {
      server.close();
    }
  });
});

// Compose mode: no socket — the folder compose.yaml is in.
describe('compose mode', () => {
  it('writes into the folder as a whole file, readable by its owner only', async () => {
    const dir = tempDir();
    await composeFolder(dir).write({ 'compose.yaml': 'name: tresjr\n' });
    expect(readFileSync(join(dir, 'compose.yaml'), 'utf8')).toBe('name: tresjr\n');
    expect(statSync(join(dir, 'compose.yaml')).mode & 0o777).toBe(0o600);
    await composeFolder(dir).write({ 'compose.yaml': 'name: tresjr # anew\n' });
    expect(readFileSync(join(dir, 'compose.yaml'), 'utf8')).toBe('name: tresjr # anew\n');
  });

  it('its environment: no engine, the folder, and what it passes on to its next container', () => {
    const env = composeEnv({ DATA_DIR: tempDir(), COMPOSE_DIR: tempDir(), INSTALLER_TARGET: 'compose', BOOTSTRAP_CONFIG: '{}', COMPOSE_COMMAND: 'nerdctl compose up -d', HOME: '/root' });
    expect(env.DOCKER).toBeUndefined();
    expect(env.COMPOSE).toBeDefined();
    expect(env.INSTALLER_ENV).toEqual({ INSTALLER_TARGET: 'compose', BOOTSTRAP_CONFIG: '{}', COMPOSE_COMMAND: 'nerdctl compose up -d', DATA_DIR: expect.any(String) });
  });
});
