import type { Docker } from './docker/client';
import type { Kube } from './kubernetes/client';

export interface Env {
  // The installer's own state (see state.ts). Created by the bootstrapper
  // (title arcanum-installer-INSTALLER_STATE).
  INSTALLER_STATE: KVNamespace;
  // Set once by the bootstrapper (arcanum.kaboutersoft.be), random, never
  // changed: the root of the key that encrypts the stored Cloudflare token
  // and the generated secrets (crypto.ts), and signs the session cookies.
  // Admins sign in with their account (oidc.ts) or the recovery code.
  INSTALLER_STATE_KEY?: string;
  // The bootstrapper's handoff (bootstrap.ts), imported into the state once.
  BOOTSTRAP_CONFIG?: string;
  // The release this installer was uploaded from.
  INSTALLER_RELEASE?: string;
  // releases.json of arcanum-releases (not the rate-limited GitHub API).
  RELEASES_INDEX_URL: string;
  // Tests only: the Cloudflare API base URL.
  CLOUDFLARE_API_BASE?: string;
  // Self-hosted on Kubernetes (SELF_HOSTING.md): the cluster's API, in this
  // installer's own namespace (set by node.ts; never on Cloudflare).
  KUBE?: Kube;
  // This installer's own Deployment and Service (the Helm chart's names),
  // and the Secret its BOOTSTRAP_CONFIG comes from (emptied after the handoff).
  INSTALLER_DEPLOYMENT?: string;
  BOOTSTRAP_SECRET?: string;
  // Self-hosted with Docker or Podman (compose): the engine's API, its
  // network (set by node.ts); this installer's own container; where the bff
  // is published on the machine (default 127.0.0.1:8000).
  DOCKER?: Docker;
  INSTALLER_CONTAINER?: string;
  PUBLISH_BFF?: string;
  // The engine over tcp instead of the socket (passed on to the self-update helper).
  DOCKER_HOST?: string;
  // Compose mode instead (docker/compose-file.ts): no engine socket — the
  // folder compose.yaml is in, which the installer writes; what to tell the
  // owner to run there (default `docker compose up -d`); and its own
  // environment to pass on to its next container.
  COMPOSE?: ComposeFolder;
  COMPOSE_COMMAND?: string;
  INSTALLER_ENV?: Record<string, string>;
  // Where the images come from: `<prefix><worker>:<version>` (default
  // ghcr.io/arcanum-pos/tresjr-), and a tag to use instead of the version
  // (a test cluster with images built on the spot).
  IMAGE_PREFIX?: string;
  IMAGE_TAG?: string;
}

export interface ComposeFolder {
  write(files: Record<string, string>): Promise<void>;
}
