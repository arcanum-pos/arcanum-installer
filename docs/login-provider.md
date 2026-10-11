# Choosing a login provider for Arcanum

Arcanum doesn't keep passwords itself: people sign in with a **login
provider** (an OpenID Connect provider). You set it in the installer under
**Geavanceerd → Aanmelden bij Arcanum**. A new installation already has one:
**login.kaboutersoft.be**, with its own client, created for you. You only
need this page if you want another provider (Google, Microsoft, Auth0,
Keycloak, …).

When you press **Controleren en bewaren**, the installer tests your
client(s) with the provider and tells you what's wrong before it keeps
anything.

## The two ways to sign in

- **In the browser** — the console, and a kassa where someone types their
  password (the OAuth *authorization code* flow).
- **With a QR code** — the sign-in screen of a kassa or customer display
  shows a QR code; you scan it with your phone and sign in there (the OAuth
  *device code* flow). Nobody types a password into a shared device.

Many providers do both with **one client**. Some (Google) need a **second
client** for the QR sign-in.

## The fields

| Field | What to fill in |
|---|---|
| **Issuer-URL** | The provider's issuer, e.g. `https://accounts.google.com`. Arcanum reads `<issuer>/.well-known/openid-configuration` from it — it must offer the device code flow too (a `device_authorization_endpoint`). |
| **Client ID / Client secret** | The client for signing in **in the browser** — and for the QR sign-in too, unless you fill in a separate one. |
| **Scopes** (optional) | Empty = `openid profile email offline_access`. Google refuses `offline_access`: there it becomes `openid profile email` by itself. |
| **Separate client for the QR sign-in** (optional, folded away) | Only if your provider needs a separate client for the device code flow (Google). Empty = the client above does it. |

In the provider, register these two addresses for the client (the installer
shows them with your installation's own address):

- **Callback / redirect URI:** `https://<your address>/callback`
- **Sign-out / post-logout redirect URI:** `https://<your address>`

People are recognised by the e-mail address the provider gives — it must be
**verified** by the provider (an invite only activates for a verified
address).

## Per provider

Provider consoles change their screens now and then; the names below are a
guide. The installer's test has the last word.

### login.kaboutersoft.be (the default)

Nothing to do: the bootstrapper made a client for your installation, which
does both ways of signing in.

### Google

Google needs **two** OAuth clients (Google Cloud Console → *APIs & Services
→ Credentials → Create credentials → OAuth client ID*), and an *OAuth consent
screen*:

1. Type **Web application**, with the callback URL under *Authorized
   redirect URIs* → **Client ID / Client secret** in the installer.
2. Type **TVs and Limited Input devices** → the **separate client for the QR
   sign-in**.

Scopes: `openid profile email` (filled in by itself).

### Keycloak

Issuer: `https://<your keycloak>/realms/<realm>`. One client:

- *Client authentication* **on** (a confidential client, with a secret);
- *Standard flow* **and** *OAuth 2.0 Device Authorization Grant* enabled;
- the callback URL under *Valid redirect URIs*, your address under *Valid
  post logout redirect URIs*.

No separate QR client needed.

### Microsoft (Entra ID)

Issuer: `https://login.microsoftonline.com/<tenant id>/v2.0`. An *App
registration* with a *Web* redirect URI (the callback URL) and a client
secret. For the QR sign-in Microsoft asks *Allow public client flows* to be
switched on (*Authentication*). If the installer's test refuses the client
for the QR sign-in, make a second registration for it and fill that one in
as the separate QR client.

### Auth0

A *Regular Web Application* with the callback URL under *Allowed Callback
URLs* and your address under *Allowed Logout URLs* → **Client ID / Client
secret**. Auth0 offers the device code flow on *Native* applications (with
the *Device Code* grant switched on under *Advanced settings → Grant
types*): make one for the QR sign-in and fill it in as the separate QR
client. If the installer's test refuses it, its message says why.

## Changing the provider later

Once Arcanum is installed, every member is tied to the provider (and
client) they first signed in with. Another provider or client therefore goes
through **Aanmelding wijzigen**: you set it up, test it with a real sign-in,
and only then apply it — nobody gets locked out, and it can be undone for 7
days. A new secret or other scopes for the same client save directly.
