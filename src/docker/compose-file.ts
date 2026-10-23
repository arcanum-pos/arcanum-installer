// Compose mode (SELF_HOSTING.md): for an engine whose socket the installer
// can't use — nerdctl has none — or that its owner doesn't hand over. The
// installer doesn't make the containers: it writes the compose.yaml that
// does (every Worker, and itself), into the folder it was started from; the
// owner runs `<engine> compose up -d` there. The same containers as the
// socket mode (containers.ts containerSpec: settings, volumes, read-only, no
// capabilities), as compose services. Pure — tested in test/compose.test.ts.
import type { ContainerSpec } from './containers';
import { LABEL } from './containers';

// The installer's own service: its key and container name as the starter
// compose.yaml from the bootstrapper has them, so `compose up -d` keeps it
// (or replaces it with a newer image) instead of adding a second one.
export const INSTALLER_SERVICE = 'installer';
// What the installer passes on to its own next container, from its environment.
export const INSTALLER_ENV_KEYS = ['INSTALLER_TARGET', 'BOOTSTRAP_CONFIG', 'PUBLISH_BFF', 'COMPOSE_COMMAND', 'RELEASES_INDEX_URL', 'IMAGE_PREFIX', 'IMAGE_TAG', 'DATA_DIR'];

export interface ComposeInstaller {
  image: string;
  release: string;
  // Its own environment to keep (INSTALLER_ENV_KEYS that are set).
  env: Record<string, string>;
}

// A scalar as YAML: JSON's double-quoted string is valid YAML. `$` doubled:
// compose would read ${…} in a value as one of its own variables.
const q = (value: string) => JSON.stringify(value.replace(/\$/g, '$$$$'));

function envMap(list: string[]): Record<string, string> {
  return Object.fromEntries(list.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
}

function block(lines: string[], indent: number): string {
  return lines.map((l) => ' '.repeat(indent) + l).join('\n');
}

function serviceYaml(spec: ContainerSpec, env: Record<string, string>): string {
  const host = spec.config.HostConfig as { PortBindings?: Record<string, { HostIp?: string; HostPort: string }[]> };
  const publish = Object.values(host.PortBindings ?? {})[0]?.[0];
  const labels = spec.config.Labels as Record<string, string>;
  const lines = [
    `${spec.name}:`,
    `  image: ${q(spec.image)}`,
    `  container_name: ${q(spec.name)}`,
    '  restart: unless-stopped',
    '  read_only: true',
    '  cap_drop: [ALL]',
    '  security_opt: ["no-new-privileges:true"]',
    '  labels:',
    ...Object.keys(labels)
      .sort()
      .map((k) => `    ${q(k)}: ${q(labels[k])}`),
    '  environment:',
    ...Object.keys(env)
      .sort()
      .map((k) => `    ${q(k)}: ${q(env[k])}`),
    ...(spec.volume ? ['  volumes:', `    - ${q(`${spec.volume}:/data`)}`] : []),
    ...(publish ? ['  ports:', `    - ${q(`${publish.HostIp ? `${publish.HostIp}:` : ''}${publish.HostPort}:8080`)}`] : []),
  ];
  return block(lines, 2);
}

function installerYaml(installer: ComposeInstaller): string {
  const env: Record<string, string> = { ...installer.env, INSTALLER_TARGET: 'compose', INSTALLER_RELEASE: installer.release };
  const lines = [
    `${INSTALLER_SERVICE}:`,
    `  image: ${q(installer.image)}`,
    '  container_name: "tresjr-installer"',
    '  # It writes this folder (as its owner) and keeps its state in its volume.',
    '  user: "0"',
    '  restart: unless-stopped',
    '  ports:',
    '    - "127.0.0.1:8080:8080"',
    '  environment:',
    ...Object.keys(env)
      .sort()
      .map((k) => `    ${q(k)}: ${q(env[k])}`),
    '  volumes:',
    '    - "./:/project"',
    '    - "installer:/data"',
  ];
  return block(lines, 2);
}

// The settings' fingerprint: every service as it's written. The bff carries
// it (TRESJR_SETTINGS) and shows it in /version — the installer sees there
// that `compose up -d` was run with this file.
export async function settingsFingerprint(specs: ContainerSpec[], installer: ComposeInstaller): Promise<string> {
  const text = JSON.stringify({ services: specs.map((s) => [s.name, s.digest]).sort(), installer });
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The whole compose.yaml. `extraEnv`: per container name, what compose mode
// adds (the backend migrating as it starts, the bff's fingerprint).
export function composeYaml(specs: ContainerSpec[], installer: ComposeInstaller, extraEnv: Record<string, Record<string, string>> = {}): string {
  const services = specs.map((spec) => serviceYaml(spec, { ...envMap(spec.config.Env as string[]), ...(extraEnv[spec.name] ?? {}) }));
  const volumes = specs.filter((s) => s.volume).map((s) => `  ${q(s.volume!)}:\n    name: ${q(s.volume!)}`);
  return [
    '# tresjr with compose - written by its installer (Instellingen there):',
    '# every container, and the installer itself. Run `compose up -d` in this',
    '# folder after the installer asks you to. Your own additions go in',
    '# compose.override.yaml: this file is written anew.',
    `# It holds the installation's secrets: keep it to yourself. (${LABEL})`,
    'name: tresjr',
    'services:',
    installerYaml(installer),
    ...services,
    'volumes:',
    '  installer:',
    ...volumes,
    'networks:',
    '  default:',
    '    name: tresjr',
    '',
  ].join('\n');
}
