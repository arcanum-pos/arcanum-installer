// The Docker Engine API, the few calls the installer's Docker target makes
// (SELF_HOSTING.md, compose): containers, volumes and images, through the
// socket compose.yaml gives the installer (/var/run/docker.sock — Podman's
// compatible API works too). The transport is given: Node's http over the
// socket (node/docker-transport.ts), or a fake engine in tests.

export interface DockerResponse {
  status: number;
  // Parsed JSON, or the raw text when it isn't JSON (a pull's progress lines, logs).
  body: any;
  text: string;
  // The raw answer (a container's logs are framed binary).
  bytes?: Uint8Array;
}

export type DockerTransport = (method: string, path: string, body?: unknown) => Promise<DockerResponse>;

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// `ghcr.io/arcanum-pos/tresjr-bff:0.1.70` → fromImage + tag.
export function splitImage(ref: string): { name: string; tag: string } {
  const at = ref.lastIndexOf(':');
  return at > ref.lastIndexOf('/') ? { name: ref.slice(0, at), tag: ref.slice(at + 1) } : { name: ref, tag: 'latest' };
}

// A container's log stream without a TTY: frames of [stream, 0, 0, 0, size×4, bytes].
export function demuxLogs(bytes: Uint8Array): string {
  if (bytes.length < 8 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 0 || bytes[0] > 2) return new TextDecoder().decode(bytes);
  // One decoder across frames: a character's bytes may straddle two of them.
  // Sizes unsigned: one of 2 GB or more must not step back (a loop forever).
  const decoder = new TextDecoder();
  let out = '';
  for (let i = 0; i + 8 <= bytes.length; ) {
    const size = ((bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]) >>> 0;
    out += decoder.decode(bytes.slice(i + 8, i + 8 + size), { stream: true });
    i += 8 + size;
  }
  return out + decoder.decode();
}

export class Docker {
  constructor(
    private readonly transport: DockerTransport,
    // The network every container joins (compose.yaml names it), so they
    // reach each other — and the installer them — by container name.
    readonly network: string
  ) {}

  private async call(method: string, path: string, body?: unknown, ok: number[] = []): Promise<DockerResponse> {
    const res = await this.transport(method, path, body);
    if (res.status >= 400 && !ok.includes(res.status)) throw new DockerError(res.status, res.body?.message || `Docker said ${res.status} to ${method} ${path}`);
    return res;
  }

  async inspect(name: string): Promise<any | null> {
    const res = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`, undefined, [404]);
    return res.status === 404 ? null : res.body;
  }

  async hasImage(ref: string): Promise<boolean> {
    return (await this.call('GET', `/images/${encodeURIComponent(ref)}/json`, undefined, [404])).status !== 404;
  }

  // Waits until it's downloaded; an error in the progress stream is an error.
  async pull(ref: string): Promise<void> {
    const { name, tag } = splitImage(ref);
    const res = await this.call('POST', `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`);
    for (const line of res.text.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.error) throw new DockerError(500, `${ref}: ${event.error}`);
      } catch (err) {
        if (err instanceof DockerError) throw err;
      }
    }
  }

  // Creating one that's there already is fine: it's the same volume.
  async volume(name: string, labels: Record<string, string>): Promise<void> {
    await this.call('POST', '/volumes/create', { Name: name, Labels: labels });
  }

  async create(name: string, config: Record<string, unknown>): Promise<string> {
    return (await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, config)).body.Id;
  }

  async start(id: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/start`, undefined, [304]);
  }

  async stop(id: string, seconds = 20): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`, undefined, [304, 404]);
  }

  async remove(id: string): Promise<void> {
    await this.call('DELETE', `/containers/${encodeURIComponent(id)}?force=true`, undefined, [404]);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
  }

  // Until it stops: its exit code.
  async wait(id: string): Promise<number> {
    return (await this.call('POST', `/containers/${encodeURIComponent(id)}/wait`)).body?.StatusCode ?? -1;
  }

  async logs(id: string, tail = 20): Promise<string> {
    const res = await this.call('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}`, undefined, [404]);
    return res.status === 404 ? '' : demuxLogs(res.bytes ?? new TextEncoder().encode(res.text)).trim();
  }
}
