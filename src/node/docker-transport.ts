// The Docker Engine API over its unix socket (DOCKER_SOCKET, default
// /var/run/docker.sock), or over http (DOCKER_HOST=tcp://host:2375 — a
// Docker-in-Docker for trying it out).
import http from 'node:http';
import type { DockerResponse, DockerTransport } from '../docker/client';

// No Docker or Podman API at the socket — typically nerdctl (Rancher Desktop
// on containerd), which has none: the installer can't manage containers there.
export function noEngine(socketPath: string, code: string): Error {
  return new Error(
    `No container engine at ${socketPath} (${code}). The installer needs the Docker or Podman API socket — nerdctl has none: with Rancher Desktop, choose the container engine "dockerd (moby)"; with Podman, start podman.socket and set DOCKER_SOCKET (see the compose page).`
  );
}

export function dockerTransport(environment: NodeJS.ProcessEnv): DockerTransport {
  const tcp = /^tcp:\/\/([^:/]+):(\d+)/.exec(environment.DOCKER_HOST ?? '');
  const target = tcp ? { host: tcp[1], port: Number(tcp[2]) } : { socketPath: environment.DOCKER_SOCKET || '/var/run/docker.sock' };
  return (method, path, body) =>
    new Promise<DockerResponse>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { ...target, path, method, headers: { Accept: 'application/json', Host: 'docker', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const text = bytes.toString('utf8');
            let parsed: unknown = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = { message: text.slice(0, 300) };
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, text, bytes: new Uint8Array(bytes) });
          });
        }
      );
      // Nothing listening there: say what's needed rather than "connect ECONNREFUSED".
      req.on('error', (err: NodeJS.ErrnoException) => reject('socketPath' in target && ['ECONNREFUSED', 'ENOENT', 'EACCES'].includes(err.code ?? '') ? noEngine(target.socketPath, err.code!) : err));
      // A pull can take minutes; everything else answers quickly.
      req.setTimeout(path.startsWith('/images/create') ? 15 * 60_000 : 60_000, () => req.destroy(new Error(`Docker: no answer to ${method} ${path}`)));
      if (payload) req.write(payload);
      req.end();
    });
}
