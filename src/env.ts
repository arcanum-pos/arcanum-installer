export interface Env {
  // The installer's own state (see state.ts). Created by the Deploy button,
  // or by the bootstrapper (title arcanum-installer-INSTALLER_STATE).
  INSTALLER_STATE: KVNamespace;
  // Installers made with the Deploy button: protects the setup page, and is
  // the root of the key that encrypts the stored Cloudflare token and the
  // generated secrets (crypto.ts).
  INSTALLER_PASSWORD?: string;
  // Installers made by the bootstrapper (start.kaboutersoft.be): the same
  // root key, random, set once and never changed — the admins sign in with
  // their account (oidc.ts) or the recovery code instead of a password.
  INSTALLER_STATE_KEY?: string;
  // The bootstrapper's handoff (bootstrap.ts), imported into the state once.
  BOOTSTRAP_CONFIG?: string;
  // The release this installer was uploaded from (unset: the Deploy button).
  INSTALLER_RELEASE?: string;
  // releases.json of arcanum-releases (not the rate-limited GitHub API).
  RELEASES_INDEX_URL: string;
  // Tests only: the Cloudflare API base URL.
  CLOUDFLARE_API_BASE?: string;
}
