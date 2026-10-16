// The installer's Kubernetes target (SELF_HOSTING.md): the same release,
// the same steps' idea, but the installer runs in the cluster and applies
// what each Worker needs in its own namespace (manifests.ts) — then waits
// until it's up. Every step can run again (server-side apply).
//
//   installer:self   an update with a newer installer: its own Deployment to
//                    the new image first; the next steps wait until the new
//                    installer answers (steps.ts' guard)
//   secrets          generated once (steps.ts makeSecrets) — never regenerated
//   worker:<name>    its Secret, volume, Deployment and Service; done once it's
//                    rolled out (until then: retry, with what's holding it up)
//   login:uris       the public address registered at the login provider
//   verify           the bff answers inside the cluster
import { addClientUris } from '../auth-client';
import type { WorkerDescriptor } from '../contract';
import { generateSecret } from '../crypto';
import type { Messages } from '../i18n';
import { fetchReleaseJson } from '../releases';
import { deployedName, INSTALLER_KEY_SECRET, publicUrl, sealValue, unsealValue, type Blueprint, type InstallerState } from '../state';
import { bffSupportsInstaller, installContext, makeSecrets, secretsOf, type StepContext, type StepDef, type StepOutcome } from '../steps';
import type { Kube } from './client';
import { objectName, PORT, shortName, workerManifests, type KubeContext } from './manifests';

export const DEFAULT_IMAGE_PREFIX = 'ghcr.io/arcanum-pos/tresjr-';
// The installer's own names (the Helm chart's), unless told otherwise.
export const installerDeployment = (ctx: { env: { INSTALLER_DEPLOYMENT?: string }; state: InstallerState }) =>
  ctx.env.INSTALLER_DEPLOYMENT || deployedName(ctx.state, 'arcanum-installer');

// The login provider gets the address once it's known (and only this
// installation's own client at login.kaboutersoft.be).
export const needsKubeClientUris = (state: InstallerState) => !!state.bootstrap?.login && state.bootstrap.login.selfService !== false && !!state.kubernetes?.publicUrl;

export function planKubernetesSteps(blueprint: Blueprint, state: InstallerState, t: Messages): StepDef[] {
  const s = t.steps;
  const steps: StepDef[] = [];
  if (blueprint.installer) steps.push({ id: 'installer:self', title: s.selfUpdate });
  steps.push({ id: 'secrets', title: s.secrets });
  for (const w of blueprint.workers) {
    steps.push({ id: `worker:${w.name}`, title: s.worker(w.name) });
    if (w.public_entry && needsKubeClientUris(state)) steps.push({ id: 'login:uris', title: s.loginUris(new URL(state.kubernetes!.publicUrl!).host) });
  }
  steps.push({ id: 'verify', title: s.verify });
  return steps;
}

export function kubeContext(ctx: StepContext): KubeContext {
  const version = ctx.state.release!.version;
  const prefix = ctx.env.IMAGE_PREFIX || DEFAULT_IMAGE_PREFIX;
  const tag = ctx.env.IMAGE_TAG || version;
  return {
    instance: deployedName(ctx.state, 'arcanum-x').replace(/-x$/, ''),
    image: (short) => `${prefix}${short}:${tag}`,
    version,
    storageClassName: ctx.state.kubernetes?.storageClassName,
  };
}

function kubeOf(ctx: StepContext): Kube {
  if (!ctx.env.KUBE) throw new Error('This installer runs outside Kubernetes: no cluster to install in');
  return ctx.env.KUBE;
}

// A Worker's manifests, applied — what the step and a settings change both do.
export async function applyWorker(ctx: StepContext, name: string): Promise<{ deployment: string; selector: string }> {
  const { state } = ctx;
  const release = state.release!;
  const kube = kubeOf(ctx);
  const worker = release.blueprint.workers.find((w) => w.name === name);
  if (!worker) throw new Error(ctx.t.steps.notInRelease(name));
  const descriptor = await fetchReleaseJson<WorkerDescriptor>(release.manifestUrl, release.manifest, worker.file);
  const secrets = await secretsOf(ctx);
  const k = kubeContext(ctx);
  // The bff forwards /installer/* to this installer from the start (a
  // release whose bff can): its Service, and a key they share.
  const linkInstaller = worker.public_entry && bffSupportsInstaller(descriptor);
  if (linkInstaller) {
    if (!secrets[INSTALLER_KEY_SECRET]) {
      secrets[INSTALLER_KEY_SECRET] = await generateSecret('hex32');
      state.secrets = await sealValue(ctx.env, state, JSON.stringify(secrets));
    }
    state.behindArcanum = { script: installerDeployment(ctx) };
  }
  const context = await installContext(ctx, name, secrets, linkInstaller);
  const manifests = await workerManifests(descriptor, context, k, linkInstaller ? { INSTALLER_URL: `http://${installerDeployment(ctx)}:${PORT}` } : {});
  for (const m of manifests) await kube.apply(m);
  return { deployment: objectName(k, name), selector: `app.kubernetes.io/name=${shortName(name)},app.kubernetes.io/instance=${k.instance}` };
}

export async function runKubernetesStep(id: string, ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx;
  const release = state.release!;
  const s = ctx.t.steps;

  if (id === 'installer:self') {
    const kube = kubeOf(ctx);
    const name = installerDeployment(ctx);
    const prefix = ctx.env.IMAGE_PREFIX || DEFAULT_IMAGE_PREFIX;
    const image = `${prefix}installer:${ctx.env.IMAGE_TAG || release.version}`;
    const current = await kube.get('apps/v1', 'Deployment', name);
    if (!current) throw new Error(s.noInstallerScript(name));
    const container = current.spec?.template?.spec?.containers?.[0]?.name ?? 'installer';
    await kube.apply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name },
      spec: { template: { spec: { containers: [{ name: container, image, env: [{ name: 'INSTALLER_RELEASE', value: release.version }] }] } } },
    });
    state.selfUpdate = { from: ctx.env.INSTALLER_RELEASE ?? null, to: release.version, at: new Date().toISOString(), previousDeploymentId: null, previousVersionId: null };
    return { status: 'done', detail: s.selfUpdated(release.version) };
  }

  if (id === 'secrets') {
    const { added, total } = await makeSecrets(ctx);
    return { status: 'done', detail: s.secretsMade(added, total) };
  }

  if (id.startsWith('worker:')) {
    const kube = kubeOf(ctx);
    const { deployment, selector } = await applyWorker(ctx, id.slice(7));
    const rollout = await kube.rollout(deployment);
    if (rollout.done) return { status: 'done', detail: `${deployment}: ${rollout.detail}` };
    const problems = await kube.podProblems(selector).catch(() => []);
    // Still coming up: the page asks again in a moment; a stuck pod says why.
    return { status: 'retry', detail: problems.length ? `${deployment}: ${problems.join('; ')}` : `${deployment}: ${rollout.detail}` };
  }

  if (id === 'login:uris') {
    const login = state.bootstrap!.login!;
    const url = publicUrl(state)!;
    const { added } = await addClientUris(login.issuer, { id: login.clientId, secret: await unsealValue(ctx.env, state, login.clientSecret) }, { redirectUris: [`${url}/callback`], postLogoutRedirectUris: [url] });
    return { status: 'done', detail: added.length ? s.urisAdded(added.length, new URL(login.issuer).host) : s.urisThere };
  }

  if (id === 'verify') {
    const bff = `http://${objectName(kubeContext(ctx), 'arcanum-bff')}:${PORT}/health`;
    const res = await fetch(bff).catch((err: Error) => {
      throw new Error(`${bff}: ${err.message}`);
    });
    if (!res.ok) throw new Error(`${bff}: ${res.status}`);
    state.installed = { version: release.version, at: new Date().toISOString() };
    return { status: 'done', detail: s.verified(release.blueprint.workers.length) };
  }

  throw new Error(ctx.t.api.unknownStep(id));
}
