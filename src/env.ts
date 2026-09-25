export interface Env {
  // The installer's own state (see state.ts). Created by the Deploy button.
  INSTALLER_STATE: KVNamespace;
  // Protects the setup page; also the root of the key that encrypts the
  // stored Cloudflare token and the generated secrets (crypto.ts).
  INSTALLER_PASSWORD: string;
  // releases.json of arcanum-releases (not the rate-limited GitHub API).
  RELEASES_INDEX_URL: string;
  // Tests only: the Cloudflare API base URL.
  CLOUDFLARE_API_BASE?: string;
}
