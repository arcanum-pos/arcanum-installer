// A small Docker Engine for the Docker target's tests: images (pulled on
// request, or failing to), named volumes, containers that run once
// started — or keep restarting — and one-off containers that exit with a
// chosen code; everything that happens, in order, in `log`.
import { Docker, type DockerTransport } from '../src/docker/client';

type Container = { Id: string; Name: string; Config: Record<string, any>; HostConfig: Record<string, any>; NetworkSettings: Record<string, any>; Mounts: any[]; State: Record<string, any> };

export class FakeDockerEngine {
  images = new Set<string>();
  volumes = new Set<string>();
  containers = new Map<string, Container>();
  log: string[] = [];
  // Images that can't be pulled, with the engine's message.
  pullErrors: Record<string, string> = {};
  // Exit codes of one-off containers (by name), default 0.
  exitCodes: Record<string, number> = {};
  // Containers (by name) that crash and keep restarting, with their last log line.
  crashing: Record<string, string> = {};
  private next = 1;

  private find(ref: string): Container | undefined {
    return this.containers.get(ref) ?? [...this.containers.values()].find((c) => c.Id === ref || c.Id.startsWith(ref));
  }

  // The installer's own container, as compose.yaml makes it.
  seedInstaller(name = 'tresjr-installer', image = 'ghcr.io/arcanum-pos/tresjr-installer:0.1.0') {
    this.images.add(image);
    const Id = `f00d${'0'.repeat(60)}`;
    this.containers.set(name, {
      Id,
      Name: `/${name}`,
      Config: { Image: image, Env: ['INSTALLER_TARGET=docker', 'INSTALLER_RELEASE=0.1.0'], Hostname: Id.slice(0, 12), Labels: { 'com.docker.compose.project': 'tresjr' } },
      HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'], PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } },
      NetworkSettings: { Networks: { tresjr: { Aliases: ['installer', Id.slice(0, 12)] } } },
      Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
      State: { Running: true, Status: 'running' },
    });
  }

  transport: DockerTransport = async (method, path, body) => {
    const url = new URL(path, 'http://docker');
    const p = decodeURIComponent(url.pathname);
    const json = (status: number, value: unknown) => ({ status, body: value, text: JSON.stringify(value) });
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/containers\/(.+)\/json$/.exec(p))) {
      const c = this.find(m[1]);
      return c ? json(200, structuredClone(c)) : json(404, { message: `No such container: ${m[1]}` });
    }
    if (method === 'GET' && (m = /^\/images\/(.+)\/json$/.exec(p))) return this.images.has(m[1]) ? json(200, { Id: m[1] }) : json(404, { message: 'No such image' });
    if (method === 'POST' && p === '/images/create') {
      const ref = `${url.searchParams.get('fromImage')}:${url.searchParams.get('tag')}`;
      this.log.push(`pull ${ref}`);
      const error = this.pullErrors[ref];
      if (error) return { status: 200, body: null, text: `{"status":"Pulling"}\n{"error":${JSON.stringify(error)}}\n` };
      this.images.add(ref);
      return { status: 200, body: null, text: '{"status":"Pulling"}\n{"status":"Downloaded newer image"}\n' };
    }
    if (method === 'POST' && p === '/volumes/create') {
      const name = (body as any).Name;
      if (!this.volumes.has(name)) this.log.push(`volume ${name}`);
      this.volumes.add(name);
      return json(201, { Name: name });
    }
    if (method === 'POST' && p === '/containers/create') {
      const name = url.searchParams.get('name')!;
      if (this.containers.has(name)) return json(409, { message: `Conflict. The container name "/${name}" is already in use` });
      const config = structuredClone(body as Record<string, any>);
      if (!this.images.has(config.Image)) return json(404, { message: `No such image: ${config.Image}` });
      const { HostConfig, NetworkingConfig, ...rest } = config;
      const Id = `c${this.next++}`.padEnd(64, '0');
      const networks = Object.fromEntries(Object.entries(NetworkingConfig?.EndpointsConfig ?? {}).map(([n, v]: [string, any]) => [n, { Aliases: [...(v.Aliases ?? []), Id.slice(0, 12)] }]));
      const mounts = [...(HostConfig?.Mounts ?? []).map((x: any) => ({ Type: x.Type, Source: x.Source, Destination: x.Target })), ...(HostConfig?.Binds ?? []).map((b: string) => ({ Type: 'bind', Source: b.split(':')[0], Destination: b.split(':')[1] }))];
      this.containers.set(name, { Id, Name: `/${name}`, Config: rest, HostConfig: HostConfig ?? {}, NetworkSettings: { Networks: networks }, Mounts: mounts, State: { Running: false, Status: 'created' } });
      this.log.push(`create ${name} ${config.Image}`);
      return json(201, { Id });
    }
    if (method === 'POST' && (m = /^\/containers\/([^/]+)\/(start|stop|wait|rename)$/.exec(p))) {
      const c = this.find(m[1]);
      if (!c) return json(404, { message: 'No such container' });
      const name = c.Name.slice(1);
      if (m[2] === 'start') {
        if (c.State.Running) return json(304, null);
        c.State = this.crashing[name] ? { Running: true, Restarting: true, Status: 'restarting', ExitCode: 1 } : { Running: true, Status: 'running' };
        this.log.push(`start ${name}`);
        return json(204, null);
      }
      if (m[2] === 'stop') {
        if (!c.State.Running) return json(304, null);
        c.State = { Running: false, Status: 'exited', ExitCode: 0 };
        this.log.push(`stop ${name}`);
        return json(204, null);
      }
      if (m[2] === 'wait') {
        const code = this.exitCodes[name] ?? 0;
        c.State = { Running: false, Status: 'exited', ExitCode: code };
        return json(200, { StatusCode: code });
      }
      const to = url.searchParams.get('name')!;
      this.containers.delete(name);
      c.Name = `/${to}`;
      this.containers.set(to, c);
      this.log.push(`rename ${name} ${to}`);
      return json(204, null);
    }
    if (method === 'GET' && (m = /^\/containers\/([^/]+)\/logs$/.exec(p))) {
      const c = this.find(m[1]);
      if (!c) return json(404, { message: 'No such container' });
      const line = this.crashing[c.Name.slice(1)] ?? (this.exitCodes[c.Name.slice(1)] ? 'migration 0041 failed: no such table' : 'ok');
      // Framed like a real engine's (stream 2 = stderr).
      const text = `${line}\n`;
      const bytes = new Uint8Array(8 + text.length);
      bytes.set([2, 0, 0, 0, 0, 0, 0, text.length]);
      bytes.set(new TextEncoder().encode(text), 8);
      return { status: 200, body: null, text, bytes };
    }
    if (method === 'DELETE' && (m = /^\/containers\/([^/]+)$/.exec(p))) {
      const c = this.find(m[1]);
      if (!c) return json(404, { message: 'No such container' });
      this.containers.delete(c.Name.slice(1));
      this.log.push(`remove ${c.Name.slice(1)}`);
      return json(204, null);
    }
    return json(500, { message: `fake engine: ${method} ${path} not handled` });
  };

  docker(network = 'tresjr') {
    return new Docker(this.transport, network);
  }

  get(name: string) {
    return this.containers.get(name);
  }

  envOf(name: string): Record<string, string> {
    return Object.fromEntries((this.get(name)?.Config.Env ?? []).map((e: string) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  }
}
