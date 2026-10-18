// Compose mode's steps (compose-file.ts): instead of a step per container,
//   compose:write   compose.yaml written into the folder — every Worker of
//                   the release with its settings, and the installer itself
//                   (a newer one replaces this one when compose runs)
//   compose:apply   done once the owner ran `compose up -d` there: this
//                   installer is the release's, the bff shows this file's
//                   fingerprint, and every container answers (asked again
//                   until then — the page says what to run)
import type { StepContext, StepOutcome } from '../steps';
import { DEFAULT_IMAGE_PREFIX, kubeContext, prepareWorker } from '../kubernetes/steps';
import { objectName, PORT } from '../kubernetes/manifests';
import { composeYaml, settingsFingerprint, type ComposeInstaller } from './compose-file';
import { containerSpec, publishOf, type ContainerSpec } from './containers';
import { DEFAULT_PUBLISH_BFF } from './steps';

export const DEFAULT_COMPOSE_COMMAND = 'docker compose up -d';
const command = (ctx: StepContext) => ctx.env.COMPOSE_COMMAND || DEFAULT_COMPOSE_COMMAND;

// compose.yaml as it should be — what the step and a settings change both do.
export async function writeCompose(ctx: StepContext): Promise<string> {
  if (!ctx.env.COMPOSE) throw new Error('This installer has no compose folder to write');
  const release = ctx.state.release!;
  const specs: ContainerSpec[] = [];
  for (const worker of release.blueprint.workers) {
    const { descriptor, context, k, extraEnv } = await prepareWorker(ctx, worker.name);
    specs.push(await containerSpec(descriptor, context, k, 'tresjr', { extraEnv, publish: publishOf(ctx.env.PUBLISH_BFF || DEFAULT_PUBLISH_BFF) }));
  }
  const installer: ComposeInstaller = {
    image: `${ctx.env.IMAGE_PREFIX || DEFAULT_IMAGE_PREFIX}installer:${ctx.env.IMAGE_TAG || release.version}`,
    release: release.version,
    env: ctx.env.INSTALLER_ENV ?? {},
  };
  const fingerprint = await settingsFingerprint(specs, installer);
  const k = kubeContext(ctx);
  const extra: Record<string, Record<string, string>> = {
    // No step before it starts: the backend copies its database aside and migrates as it starts.
    [objectName(k, 'arcanum-backend')]: { TRESJR_MIGRATE: '1', TRESJR_VERSION: release.version, ...(k.restoreFrom ? { TRESJR_RESTORE_FROM: k.restoreFrom } : {}) },
    [objectName(k, 'arcanum-bff')]: { TRESJR_SETTINGS: fingerprint },
  };
  await ctx.env.COMPOSE.write({ 'compose.yaml': composeYaml(specs, installer, extra) });
  ctx.state.docker = { ...ctx.state.docker, compose: true, fingerprint };
  return fingerprint;
}

async function answers(name: string): Promise<boolean> {
  try {
    await fetch(`http://${name}:${PORT}/`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function bffVersion(name: string): Promise<{ release?: string | null; settings?: string } | null> {
  try {
    const res = await fetch(`http://${name}:${PORT}/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()) as { release?: string | null; settings?: string }) : null;
  } catch {
    return null;
  }
}

export async function runComposeStep(id: string, ctx: StepContext): Promise<StepOutcome> {
  const s = ctx.t.steps;
  const release = ctx.state.release!;
  if (id === 'compose:write') {
    await writeCompose(ctx);
    return { status: 'done', detail: s.composeWritten(command(ctx)) };
  }
  // compose:apply
  const k = kubeContext(ctx);
  const bff = await bffVersion(objectName(k, 'arcanum-bff'));
  const applied = ctx.env.INSTALLER_RELEASE === release.version && bff?.release === release.version && bff.settings === ctx.state.docker?.fingerprint;
  if (!applied) return { status: 'retry', detail: s.composeRun(command(ctx)) };
  for (const worker of release.blueprint.workers) {
    const name = objectName(k, worker.name);
    if (!(await answers(name))) return { status: 'retry', detail: s.composeStarting(name) };
  }
  return { status: 'done', detail: s.composeApplied };
}
