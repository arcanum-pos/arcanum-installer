# arcanum-installer

Installs [Arcanum](https://github.com/arcanum-pos) — kassa, customer
display, admin portal — on **your own** Cloudflare account, so your data
lives there and nowhere else. It deploys the five Arcanum Workers from a
published release ([arcanum-releases](https://github.com/arcanum-pos/arcanum-releases)),
creates their databases and storage, and generates every secret.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/arcanum-pos/arcanum-installer)

## How it works

0. **New Cloudflare account?** First open *Workers & Pages* once in the
   [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
   and choose your **workers.dev subdomain** (the `<name>.workers.dev` part).
   Without it the installer gets no address to open. (The installer can
   register one for Arcanum itself, but not for itself.)
1. Click **Deploy to Cloudflare** above. It asks for a GitHub (or GitLab)
   account: it copies this installer into a new repository there and
   deploys from it — nothing else in that account is touched, and Arcanum
   itself is installed from the public releases, not from GitHub. It deploys this installer (one
   Worker + one KV namespace for its state) to your account and asks for
   `INSTALLER_PASSWORD` — choose a long, unique value; it protects the
   setup page.
2. Open the installer's workers.dev address and log in with that password.
3. Answer four questions:
   - a **Cloudflare API token** — the page links to Cloudflare's token page
     with exactly the needed permissions filled in (Workers Scripts, D1 and
     Workers KV Storage: Edit; Account Settings: Read);
   - your **login provider** (Google, Microsoft, Auth0, Keycloak…): issuer
     URL, client id and secret — the page shows the callback URL to
     register, and checks the provider supports device login (needed for
     the kassa);
   - the **admins** allowed to create or import organizations;
   - the **version** to install.
4. Click **Installeren**. Around 20 small steps run one by one; each can
   safely be run again, so an interrupted install just continues.
5. Open Arcanum on `https://arcanum-bff.<your-subdomain>.workers.dev`, log
   in as an admin, and create your organization — or import it from an
   export of your previous installation (*Instellingen → Gegevens*).

Everything else (five generated keys, all internal wiring between the
Workers) is taken care of. The Cloudflare token (if "onthouden"), the login
provider's client secret and the generated keys are stored encrypted in
the installer's KV and are never shown again.

Status: first version — fresh installs on workers.dev. Updating to a newer
release and custom domains come next.

## Development

```sh
npm ci
npm test          # end-to-end against a fake Cloudflare API and a fake release
npx wrangler dev  # needs a .dev.vars with INSTALLER_PASSWORD
```

## License

Copyright (C) 2026 kaboutersoft.be

Arcanum is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: free to use, self-host, modify, host for others and charge for
hosting or support — but if you run a modified version for users over a
network, you must offer those users its source code (AGPL §13). The app's
"Broncode" link (the `SOURCE_URL` setting of arcanum-bff) is how an
installation points its users to that source.
