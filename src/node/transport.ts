// The Kubernetes API from inside the cluster (SELF_HOSTING.md): the pod's
// service account — its token (re-read each time: it's rotated), the
// cluster's CA, its namespace. KUBE_API_URL instead talks to a plain HTTP
// API (`kubectl proxy`), for trying the installer outside a cluster.
import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { KubeResponse, KubeTransport } from '../kubernetes/client';

const ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

export function inClusterNamespace(): string {
  return readFileSync(`${ACCOUNT}/namespace`, 'utf8').trim();
}

export function inClusterTransport(): KubeTransport {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT || 443);
  if (!host) throw new Error('Not running in a Kubernetes cluster (no KUBERNETES_SERVICE_HOST)');
  const ca = readFileSync(`${ACCOUNT}/ca.crt`);
  return (method, path, body, contentType) =>
    new Promise<KubeResponse>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          host,
          port,
          path,
          method,
          ca,
          headers: {
            Authorization: `Bearer ${readFileSync(`${ACCOUNT}/token`, 'utf8').trim()}`,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': contentType || 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            let parsed: unknown = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = { message: text.slice(0, 300) };
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error(`Kubernetes API: no answer to ${method} ${path}`)));
      if (payload) req.write(payload);
      req.end();
    });
}

export function proxyTransport(baseUrl: string): KubeTransport {
  return async (method, path, body, contentType) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': contentType || 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { message: text.slice(0, 300) };
    }
    return { status: res.status, body: parsed };
  };
}
