# arcanum-installer

Installs [Arcanum](https://github.com/arcanum-pos) — kassa, customer
display, admin portal — on **your own** Cloudflare account, so your data
lives there and nowhere else. It deploys the five Arcanum Workers from a
published release ([arcanum-releases](https://github.com/arcanum-pos/arcanum-releases)),
creates their databases and storage, and generates every secret.

To install: sign in at **https://arcanum.kaboutersoft.be**, choose
**Eigen installatie** and paste a Cloudflare API token — the bootstrapper
puts this installer on your account and hands it over (below). That's the
only supported way to install it.

## From arcanum.kaboutersoft.be (bootstrapped)

1. Sign in at arcanum.kaboutersoft.be → **Eigen installatie**. No Cloudflare
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
   token, the admins and the installer's own address. When it's done:
   **Open je Arcanum** — which also moves the installer behind Arcanum
   (below).

### The contract with the bootstrapper

Two secrets on the Worker (plus its KV `INSTALLER_STATE`, title
`arcanum-installer-INSTALLER_STATE`, reused when it exists):

- `INSTALLER_STATE_KEY` — random, set on the first upload and **never
  changed** (a re-run of the bootstrapper keeps it with `keep_bindings`):
  the root of the key that seals the state.
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

  Optionally `"instance": { "kind": "single" | "admins" | "internal",
  "channel": "stable" | "dev" }` — only for the platform's own
  installations (the bootstrapper's platform admins). `kind` is the
  backend's `ORG_CREATION` (one org / the admins create several / the demo),
  `channel: "dev"` also offers development builds (`releases-dev.json`, next
  to `releases.json`). Kept in the installer's state, so every update and
  self-update keeps it; there's no setting for it in the installer itself.
  Absent: the installation keeps what it has (new: `single`, `stable`).

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

## Behind Arcanum — by itself

Once Arcanum is installed, the installer lives at
`https://<arcanum>/installer/`: the bff forwards it for anyone signed in to
Arcanum whose address is on the admin list (with a shared key,
`INSTALLER_INTERNAL_KEY`). Nobody has to do anything for that:

1. **Linked when the bff is deployed.** The first bff of a release that can
   forward `/installer/*` gets a service binding to this installer and the
   key — on a fresh install, or with the next update of an older one.
2. **Its own address goes off on the first visit through Arcanum.**
   *Open je Arcanum* on the installer's own address goes to
   `/login?returnTo=/installer/?naar=console`: sign in, the installer (now
   through Arcanum) switches its own workers.dev address off
   (`POST /api/public-access/close`, refused unless the request came
   through Arcanum — that request is the proof it stays reachable), then
   on to the console. Afterwards *Open je Arcanum* simply opens the console,
   and any later visit through Arcanum closes the address again if
   something switched it back on (the bootstrapper run again). A
   self-update through Arcanum leaves it off.
3. **Geavanceerd → Toegang tot de installer** switches it back on
   (`POST /api/public-access/open`) — then visits through Arcanum leave it
   on, until the next *Open je Arcanum* (which always closes it, `closable`)
   or until it's switched off there again (through Arcanum).
4. **Aanmelding wijzigen** needs it (the test sign-in only works there):
   staging a change switches it on, and it stays on while a provider is
   staged or a switch stopped half way. Once applied (or cancelled), the
   next "Open je Arcanum" closes it again; undoing works through Arcanum.

With the own address off and Arcanum's sign-in broken, the way back in is
the bootstrapper: *Eigen installatie* again re-uploads this installer onto
its own address with a new handoff link (and recovery code).

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

## Changing the login provider ("Aanmelding wijzigen")

Arcanum binds every membership to the `(issuer, sub)` of its first login,
so once Arcanum is installed another provider (or client) can't simply be
saved — `POST /api/login-provider` refuses it (409, `useLoginChange`); the
same provider and clients with a new secret or other scopes still saves
directly. Instead (`src/login-change.ts`):

1. **Klaarzetten** — the step 2 form, with the same live checks; kept as
   *staged*, nothing changes. The page lists the callback URLs to register
   at the new provider (for its browser client): the installer's
   `/auth/test-callback` and `/auth/callback`, and Arcanum's `/callback`.
2. **Test-aanmelding** — `GET /auth/test-login` (needs an installer session
   on the installer's own address) → the new provider (code + PKCE + nonce)
   → `/auth/test-callback`. Shows the e-mail, `sub` and `email_verified`
   that came back.
3. **Toepassen** (`POST /api/login-change/apply`, same session as the test,
   verified e-mail) — first a sealed snapshot of the login settings and every
   membership, then the backend re-deployed with the new `DEFAULT_IDP_*`,
   its `default` provider row cleared (re-seeds), and one `UPDATE`: the
   tester's memberships (by the installer session's e-mail or the new one)
   bound to the new `(issuer, sub)`, every other active membership back to
   `pending` by e-mail (role kept — it re-activates at that person's next
   login). Refused when the tester has no membership. Then this page's own
   sign-in moves to the new provider. A switch that stops half way is
   finished by applying again (the snapshot is kept, the writes are
   idempotent).
4. **Terugzetten** (`POST /api/login-change/undo`) for 7 days: the previous
   provider and every membership exactly as in the snapshot. Then the
   snapshot is dropped.

The recovery code works whatever the provider: sign in with it on the
installer's own address to undo when neither provider works. That's why
applying needs the installer's own address switched on.

## Languages

Dutch, French and English: the page follows the browser's language, or the
NL · FR · EN picker in its header (remembered in the browser as
`arcanum-installer-locale`, and carried as `?lang=`). The page holds only
its own language's texts and sends that language as `Accept-Language` on
every API call, so errors, step titles and step details come back in it
(the bff forwards the header at `/installer/*`). The texts are in
`src/messages/{nl,fr,en}.ts` — nl is the source; `test/messages.test.ts`
keeps the other two in step. Messages from Cloudflare or a login provider
are passed through untranslated, inside a translated sentence.

## Development

```sh
npm ci
npm test          # end-to-end against a fake Cloudflare API, a fake release and a fake login provider
npx wrangler dev  # needs a .dev.vars with INSTALLER_STATE_KEY and BOOTSTRAP_CONFIG (.dev.vars.example)
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
