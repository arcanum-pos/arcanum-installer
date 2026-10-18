// The installer's Docker target (SELF_HOSTING.md, compose): the steps of
// the Kubernetes target (kubernetes/steps.ts), with these two its own.
//
//   installer:self   a newer installer: its image downloaded, then a helper
//                    container of it swaps the installer's own container
//                    for one of the new image (replace.ts) — the next steps
//                    wait until the new installer answers
//   worker:<name>    its image downloaded (in the background: the step asks
//                    again), its volume, the backend's database brought up
//                    to date in a one-off container (the old one stopped
//                    first), then its container replaced — only when what
//                    it runs or its settings changed; done once it answers
import type { StepContext, StepOutcome } from '../steps';
import { DEFAULT_IMAGE_PREFIX, installerDeployment, prepareWorker } from '../kubernetes/steps';
import { PORT } from '../kubernetes/manifests';
import type { Docker } from './client';
import { containerSpec, LABEL, publishOf } from './containers';

export const DEFAULT_PUBLISH_BFF = '127.0.0.1:8000';

function dockerOf(ctx: StepContext): Docker {
  if (!ctx.env.DOCKER) throw new Error('This installer has no Docker to install with');
  return ctx.env.DOCKER;
}

// Downloads in progress (or failed), by image: a pull outlasts a request.
const pulls = new Map<string, { error?: string }>();

// null: it's here. Else what's happening (the step asks again).
export async function ensureImage(docker: Docker, ref: string): Promise<string | null> {
  const pull = pulls.get(ref);
  if (pull?.error) {
    pulls.delete(ref);
    throw new Error(pull.error);
  }
  if (pull) return `downloading ${ref}…`;
  if (await docker.hasImage(ref)) return null;
  const started = {};
  pulls.set(ref, started);
  docker.pull(ref).then(
    () => pulls.delete(ref),
    (err: Error) => pulls.set(ref, { error: err.message })
  );
  return `downloading ${ref}…`;
}

async function answers(name: string): Promise<boolean> {
  try {
    await fetch(`http://${name}:${PORT}/`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

const lastLine = (log: string) => log.split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? '';

// A Worker's container, as it should be — what the step and a settings change both do.
export async function putUpContainer(ctx: StepContext, name: string): Promise<StepOutcome> {
  const docker = dockerOf(ctx);
  const { descriptor, context, k, extraEnv } = await prepareWorker(ctx, name);
  const spec = await containerSpec(descriptor, context, k, docker.network, { extraEnv, publish: publishOf(ctx.env.PUBLISH_BFF || DEFAULT_PUBLISH_BFF) });
  const current = await docker.inspect(spec.name);

  if (current && current.Config?.Labels?.[`${LABEL}.settings`] === spec.digest) {
    const state = current.State ?? {};
    if (state.Running && !state.Restarting) {
      return (await answers(spec.name)) ? { status: 'done', detail: `${spec.name}: running` } : { status: 'retry', detail: `${spec.name}: starting` };
    }
    // Stopped by hand: start it again. Crashing: say why.
    if (!state.Restarting && state.Status !== 'dead') await docker.start(current.Id);
    const log = lastLine(await docker.logs(current.Id));
    return { status: 'retry', detail: `${spec.name}: ${state.Restarting ? 'restarting' : state.Status}${state.ExitCode ? ` (exit ${state.ExitCode})` : ''}${log ? ` — ${log}` : ''}` };
  }

  const waiting = await ensureImage(docker, spec.image);
  if (waiting) return { status: 'retry', detail: waiting };
  const labels = { [`${LABEL}.instance`]: k.instance, [`${LABEL}.managed-by`]: 'tresjr-installer' };
  if (spec.volume) await docker.volume(spec.volume, labels);
  if (current) await docker.stop(current.Id);
  if (spec.migrate) {
    const job = `${spec.name}-migrate`;
    await docker.remove(job);
    const id = await docker.create(job, spec.migrate);
    await docker.start(id);
    const code = await docker.wait(id);
    const log = await docker.logs(id, 15);
    await docker.remove(id);
    if (code !== 0) {
      // The old one runs on, on its own database.
      if (current) await docker.start(current.Id);
      throw new Error(`${spec.name}: the database update failed (exit ${code})${log ? `\n${log}` : ''}`);
    }
  }
  if (current) await docker.remove(current.Id);
  const id = await docker.create(spec.name, spec.config);
  await docker.start(id);
  return { status: 'retry', detail: `${spec.name}: started` };
}

// The installer's own update: a helper container of the new image does the swap.
async function updateInstaller(ctx: StepContext): Promise<StepOutcome> {
  const docker = dockerOf(ctx);
  const release = ctx.state.release!;
  const name = installerDeployment(ctx);
  const image = `${ctx.env.IMAGE_PREFIX || DEFAULT_IMAGE_PREFIX}installer:${ctx.env.IMAGE_TAG || release.version}`;
  const current = await docker.inspect(name);
  if (!current) throw new Error(ctx.t.steps.noInstallerScript(name));
  const waiting = await ensureImage(docker, image);
  if (waiting) return { status: 'retry', detail: waiting };
  const socket = (current.Mounts ?? []).find((m: { Destination?: string }) => m.Destination === '/var/run/docker.sock')?.Source;
  const helper = `${name}-update`;
  await docker.remove(helper);
  const id = await docker.create(helper, {
    Image: image,
    User: '0',
    // The image's own entrypoint is node (distroless; an Alpine one adds it).
    Cmd: ['dist/node.mjs', 'replace-installer', name, image, release.version],
    Env: ctx.env.DOCKER_HOST ? [`DOCKER_HOST=${ctx.env.DOCKER_HOST}`] : [],
    Labels: { [`${LABEL}.managed-by`]: 'tresjr-installer', [`${LABEL}.job`]: 'update-installer' },
    HostConfig: { ...(socket ? { Binds: [`${socket}:/var/run/docker.sock`] } : {}), NetworkMode: docker.network },
  });
  await docker.start(id);
  ctx.state.selfUpdate = { from: ctx.env.INSTALLER_RELEASE ?? null, to: release.version, at: new Date().toISOString(), previousDeploymentId: null, previousVersionId: null };
  return { status: 'done', detail: ctx.t.steps.selfUpdated(release.version) };
}

export async function runDockerStep(id: string, ctx: StepContext): Promise<StepOutcome> {
  if (id === 'installer:self') return updateInstaller(ctx);
  return putUpContainer(ctx, id.slice('worker:'.length));
}
