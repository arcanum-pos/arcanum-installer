// Cloudflare API client — only the calls the installer needs. Endpoint and
// payload shapes follow what wrangler itself sends (checked against its
// source): script uploads as multipart with `metadata` + module parts
// (application/javascript+module), D1 bindings as { type: 'd1', id }, DO
// migrations as { old_tag?, new_tag, steps }, asset uploads with the
// upload-session JWT instead of the API token. `data` modules (a wrangler
// "Data" rule: the installer's logo and fonts) go as application/octet-stream,
// like wrangler sends them.

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number
  ) {
    super(message);
  }
}

export interface Account {
  id: string;
  name: string;
}

export interface ScriptModule {
  name: string;
  type: 'esm' | 'compiled_wasm' | 'text' | 'data';
  content?: string;
  base64?: string;
}

const MODULE_TYPES: Record<ScriptModule['type'], string> = {
  esm: 'application/javascript+module',
  compiled_wasm: 'application/wasm',
  text: 'text/plain',
  data: 'application/octet-stream',
};

export class Cloudflare {
  constructor(
    private readonly token: string,
    private readonly base = 'https://api.cloudflare.com/client/v4'
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, init: { form?: FormData; auth?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${init.auth ?? this.token}` };
    let payload: BodyInit | undefined;
    if (init.form) payload = init.form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, body: payload });
    const data = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] } | null;
    if (!res.ok || !data?.success) {
      const first = data?.errors?.[0];
      throw new CloudflareError(first ? `${first.message} (${first.code})` : `Cloudflare API ${method} ${path}: HTTP ${res.status}`, res.status, first?.code);
    }
    return data.result as T;
  }

  listAccounts() {
    return this.call<Account[]>('GET', '/accounts?per_page=50');
  }

  async getWorkersSubdomain(accountId: string): Promise<string | null> {
    try {
      return (await this.call<{ subdomain: string }>('GET', `/accounts/${accountId}/workers/subdomain`)).subdomain || null;
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return null;
      throw err;
    }
  }

  // A brand-new account has no workers.dev subdomain until one is chosen.
  async registerWorkersSubdomain(accountId: string, subdomain: string): Promise<string> {
    return (await this.call<{ subdomain: string }>('PUT', `/accounts/${accountId}/workers/subdomain`, { subdomain })).subdomain;
  }

  async findD1(accountId: string, name: string): Promise<string | null> {
    const list = await this.call<{ uuid: string; name: string }[]>('GET', `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=50`);
    return list.find((d) => d.name === name)?.uuid ?? null;
  }

  async createD1(accountId: string, name: string): Promise<string> {
    return (await this.call<{ uuid: string }>('POST', `/accounts/${accountId}/d1/database`, { name })).uuid;
  }

  // Several statements separated by ';' run as one batch (D1 HTTP API).
  // `params` bind ?1, ?2, … — used here only with a single statement (how
  // params combine with several statements is not verified).
  queryD1(accountId: string, databaseId: string, sql: string, params?: string[]) {
    return this.call<unknown[]>('POST', `/accounts/${accountId}/d1/database/${databaseId}/query`, params ? { sql, params } : { sql });
  }

  async findKv(accountId: string, title: string): Promise<string | null> {
    const list = await this.call<{ id: string; title: string }[]>('GET', `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
    return list.find((n) => n.title === title)?.id ?? null;
  }

  async createKv(accountId: string, title: string): Promise<string> {
    return (await this.call<{ id: string }>('POST', `/accounts/${accountId}/storage/kv/namespaces`, { title })).id;
  }

  // The Durable Object migration tag of an existing script (null if the
  // script doesn't exist yet or has none) — what wrangler reads too.
  async getMigrationTag(accountId: string, scriptName: string): Promise<string | null> {
    try {
      const service = await this.call<{ default_environment?: { script?: { migration_tag?: string } } }>('GET', `/accounts/${accountId}/workers/services/${scriptName}`);
      return service.default_environment?.script?.migration_tag ?? null;
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return null;
      throw err;
    }
  }

  uploadScript(accountId: string, scriptName: string, metadata: Record<string, unknown>, modules: ScriptModule[]) {
    const form = new FormData();
    form.set('metadata', JSON.stringify(metadata));
    for (const m of modules) {
      const bytes = m.base64 !== undefined ? Uint8Array.from(atob(m.base64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(m.content ?? '');
      form.set(m.name, new File([bytes], m.name, { type: MODULE_TYPES[m.type] }));
    }
    return this.call<{ id: string }>('PUT', `/accounts/${accountId}/workers/scripts/${scriptName}`, undefined, { form });
  }

  // A script's current bindings (without secret values) — how the
  // installer finds its own KV namespace before uploading itself.
  // NOT VERIFIED against a live account: GET …/scripts/:name/settings.
  // A secret the Worker no longer needs: an upload keeps the secrets it
  // doesn't mention, so they're removed one by one.
  async deleteSecret(accountId: string, scriptName: string, name: string): Promise<void> {
    await this.call('DELETE', `/accounts/${accountId}/workers/scripts/${scriptName}/secrets/${encodeURIComponent(name)}`);
  }

  async scriptBindings(accountId: string, scriptName: string): Promise<{ type: string; name: string; namespace_id?: string }[] | null> {
    try {
      return (await this.call<{ bindings?: { type: string; name: string; namespace_id?: string }[] }>('GET', `/accounts/${accountId}/workers/scripts/${scriptName}/settings`)).bindings ?? [];
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return null;
      throw err;
    }
  }

  // The deployment serving the script now (Workers → Deployments in the
  // dashboard, where it can be rolled back to). NOT VERIFIED against a live
  // account: GET …/scripts/:name/deployments, newest first.
  async currentDeployment(accountId: string, scriptName: string): Promise<{ id: string; versionId: string | null } | null> {
    const result = await this.call<{ deployments?: { id: string; versions?: { version_id: string; percentage: number }[] }[] }>('GET', `/accounts/${accountId}/workers/scripts/${scriptName}/deployments`);
    const latest = result.deployments?.[0];
    if (!latest) return null;
    const version = [...(latest.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
    return { id: latest.id, versionId: version?.version_id ?? null };
  }

  // One secret of a script (what `wrangler secret put` does).
  putSecret(accountId: string, scriptName: string, name: string, text: string) {
    return this.call<unknown>('PUT', `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, { name, text, type: 'secret_text' });
  }

  async scriptExists(accountId: string, scriptName: string): Promise<boolean> {
    try {
      await this.call<unknown>('GET', `/accounts/${accountId}/workers/services/${scriptName}`);
      return true;
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return false;
      throw err;
    }
  }

  async isOnWorkersDev(accountId: string, scriptName: string): Promise<boolean> {
    return !!(await this.call<{ enabled?: boolean }>('GET', `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`)).enabled;
  }

  // What wrangler does after an upload for a route with `custom_domain: true`:
  // attach the hostname to the Worker (Cloudflare creates the DNS record and
  // certificate; the hostname must be in a zone of this account).
  attachCustomDomain(accountId: string, hostname: string, service: string) {
    return this.call<{ id: string }>('PUT', `/accounts/${accountId}/workers/domains`, { hostname, service, environment: 'production' });
  }

  async customDomainService(accountId: string, hostname: string): Promise<string | null> {
    const list = await this.call<{ hostname: string; service: string }[]>('GET', `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`);
    return list.find((d) => d.hostname === hostname)?.service ?? null;
  }

  setWorkersDev(accountId: string, scriptName: string, enabled: boolean) {
    return this.call<unknown>('POST', `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, { enabled, previews_enabled: false });
  }

  assetsUploadSession(accountId: string, scriptName: string, manifest: Record<string, { hash: string; size: number }>) {
    return this.call<{ jwt: string; buckets?: string[][] }>('POST', `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, { manifest });
  }

  // Authenticated with the upload session's JWT, not the API token. The
  // response carries the completion JWT once every file has been uploaded.
  uploadAssets(accountId: string, uploadJwt: string, files: { hash: string; base64: string; contentType: string }[]) {
    const form = new FormData();
    for (const f of files) form.set(f.hash, new File([f.base64], f.hash, { type: f.contentType }));
    return this.call<{ jwt?: string }>('POST', `/accounts/${accountId}/workers/assets/upload?base64=true`, undefined, { form, auth: uploadJwt });
  }
}
