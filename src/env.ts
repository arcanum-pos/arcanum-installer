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
  // Where the images come from: `<prefix><worker>:<version>` (default
  // ghcr.io/arcanum-pos/tresjr-), and a tag to use instead of the version
  // (a test cluster with images built on the spot).
  IMAGE_PREFIX?: string;
  IMAGE_TAG?: string;
}
