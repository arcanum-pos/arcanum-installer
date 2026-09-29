# arcanum-installer

Installs [Arcanum](https://github.com/arcanum-pos) — kassa, customer
display, admin portal — on **your own** Cloudflare account, so your data
lives there and nowhere else. It deploys the five Arcanum Workers from a
published release ([arcanum-releases](https://github.com/arcanum-pos/arcanum-releases)),
creates their databases and storage, and generates every secret.

The easy way: sign in at **https://start.kaboutersoft.be**, choose
**Eigen installatie** and paste a Cloudflare API token — the bootstrapper
puts this installer on your account and hands it over (below). The Deploy
button is still there for doing it by hand.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/arcanum-pos/arcanum-installer)

## From start.kaboutersoft.be (bootstrapped)

1. Sign in at start.kaboutersoft.be → **Eigen installatie**. No Cloudflare
   account yet? The page explains how to make one (free). **Maak een
   token** opens Cloudflare's token page with the permissions filled in;
   paste the token back.
2. In that one request the bootstrapper checks the token, picks the
   account (or asks which), registers its workers.dev subdomain if it has
   none, creates this installation's own OAuth client at
   `login.kaboutersoft.be`, uploads this installer (from the latest
   release) with its KV and two secrets, and sends you to
   `https://arcanum-installer.<subdomain>.workers.dev/handoff?code=…`. The
   token is never stored on kaboutersoft.be's side.
3. The handoff signs you in and shows a **recovery code once** — keep it.
   From then on you sign in with your account (`login.kaboutersoft.be`), or
   with the recovery code if that ever can't be reached.
4. One screen: **Installeren** (the latest release, everything else filled
   in). **Geavanceerd** has your own domain, your own login provider, the
   token and the admins. When it's done: **Open je Arcanum**.

### The contract with the bootstrapper

Two secrets on the Worker (plus its KV `INSTALLER_STATE`, title
`arcanum-installer-INSTALLER_STATE`, reused when it exists):

- `INSTALLER_STATE_KEY` — random, set on the first upload and **never
  changed** (a re-run of the bootstrapper keeps it with `keep_bindings`):
  the root of the key that seals the state, like `INSTALLER_PASSWORD` for a
  Deploy-button installer (the password wins when both are set).
- `BOOTSTRAP_CONFIG` — JSON:

  ```json
  {
    "version": 1,
    "cloudflareToken": "…",
    "accountId": "…", "accountName": "…", "subdomain": "…",
    "login": { "issuer": "https://login.kaboutersoft.be", "clientId": "arc_…", "clientSecret": "…" },
    "owner": { "email": "…", "sub": "…" },
    "handoffCodeHash": "<hex SHA-256 of the code in the link>",
    "handoffExpiresAt": "<ISO time, 30 minutes after the upload>"
  }
  ```

  `login` is `null` when the bootstrapper reuses the client this installer
  already has (it reads `state.bootstrap.login.clientId` from the KV). The
  client has the redirect URIs `https://arcanum-bff.<sub>.workers.dev/callback`
  and `https://arcanum-installer.<sub>.workers.dev/auth/callback`, logout URL
  `https://arcanum-bff.<sub>.workers.dev`.

Paths: `GET /handoff?code=…` (the page, which posts the code to
`POST /api/handoff`), `GET /auth/login` → the provider → `GET /auth/callback`.

The first handoff imports the config into the state: the token sealed (as
"onthouden"), the client as Arcanum's login provider *and* as this page's
sign-in, the owner as admin. Then `BOOTSTRAP_CONFIG` is replaced by
`{"version":1,"imported":true}`, so the token only exists sealed in the
state. A code works once and until `handoffExpiresAt`. A later handoff (the
bootstrapper run again for the same account) refreshes the token, adds the
owner as admin and gives a new recovery code — it never replaces a login
provider the installer already has, nor anything installed.

Signing in with an account: authorization code + PKCE with the client
above; only addresses on the admin list, with `email_verified: true`.

## Updates — the installer first

Every release carries the installer (`manifest.installer` in
arcanum-releases). Updating to a release whose installer differs from the
running one (`INSTALLER_RELEASE`) starts with **"De installer zelf
bijwerken"**: the installer records the deployment that's live now, then
uploads the release's installer over itself — same Worker name, its own KV
(read from the Worker's settings), every secret it has re-sent unchanged.
The next step already runs on the new installer. If that upload fails,
nothing else runs and nothing changed: the old installer keeps running.
If the new installer doesn't start at all: Cloudflare dashboard → *Workers
& Pages* → *arcanum-installer* → *Deployments* → the previous version →
*Rollback*.

With your own domain (Geavanceerd) on a bootstrapped installation, the
step after the bff adds `https://<domain>/callback` and `https://<domain>`
to the installation's client at `login.kaboutersoft.be` (`PATCH
/clients/self`, with the client's own id and secret — the workers.dev
addresses keep working).

## With the Deploy button

## Development

```sh
npm ci
npm test          # end-to-end against a fake Cloudflare API, a fake release and a fake login provider
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
