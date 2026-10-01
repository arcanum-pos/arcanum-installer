export interface Env {
  // The installer's own state (see state.ts). Created by the bootstrapper
  // (title arcanum-installer-INSTALLER_STATE).
  INSTALLER_STATE: KVNamespace;
  // Set once by the bootstrapper (start.kaboutersoft.be), random, never
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
}
