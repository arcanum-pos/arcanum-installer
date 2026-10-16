// The installer's own update with Docker (docker/steps.ts updateInstaller):
// run in a helper container of the NEW installer image —
//   node dist/node.mjs replace-installer <container> <image> <release>
// It recreates the installer's container as it was (its settings, volume,
// socket, ports, network, compose's labels) but of the new image, and puts
// the old one back if the new one can't be made.
import type { Docker } from './client';

export async function replaceInstaller(docker: Docker, name: string, image: string, release: string, pause = 2000): Promise<void> {
  const old = await docker.inspect(name);
  if (!old) throw new Error(`No container ${name} to update`);
  // The old installer is still answering the step that started this.
  await new Promise((r) => setTimeout(r, pause));
  const env = [...(old.Config?.Env ?? []).filter((e: string) => !e.startsWith('INSTALLER_RELEASE=')), `INSTALLER_RELEASE=${release}`];
  const endpoints = Object.fromEntries(
    Object.entries((old.NetworkSettings?.Networks ?? {}) as Record<string, { Aliases?: string[] }>).map(([network, v]) => [
      network,
      // Its old id as an alias (Docker adds it) goes; the rest stays.
      { Aliases: (v.Aliases ?? []).filter((a) => !String(old.Id).startsWith(a)) },
    ])
  );
  const { Hostname: _hostname, MacAddress: _mac, ...config } = old.Config ?? {};
  const body = { ...config, Image: image, Env: env, HostConfig: old.HostConfig, NetworkingConfig: { EndpointsConfig: endpoints } };
  const previous = `${name}-previous`;
  await docker.remove(previous);
  await docker.stop(old.Id);
  await docker.rename(old.Id, previous);
  try {
    const id = await docker.create(name, body);
    await docker.start(id);
  } catch (err) {
    await docker.remove(name).catch(() => undefined);
    await docker.rename(old.Id, name);
    await docker.start(old.Id);
    throw err;
  }
  await docker.remove(old.Id);
}
