// The setup page: one self-contained HTML document (no build step, no
// external assets), talking to api/*. Dutch, like the rest of Arcanum. Every
// path is relative: the same page works on the installer's own address
// (at / and /handoff) and behind Arcanum (at /installer/, forwarded by the bff).
// Made by the bootstrapper, it's one screen: "Installeren", with the rest
// (domain, own login provider, token, admins) under "Geavanceerd".
export const PAGE = /* html */ `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>arcanum · installeren</title>
<link rel="icon" type="image/png" href="assets/kabouter.png">
<style>
  /* The platform's own look (arcanum-frontends src/shared/globals.css +
     shadcn components): neutral oklch tokens, Geist, radius 0.625rem, and
     the "arcanum" wordmark in Montserrat Bold next to the kabouter logo. */
  @font-face { font-family: "Geist Variable"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(assets/geist.woff2) format("woff2-variations"); }
  @font-face { font-family: "Montserrat"; font-style: normal; font-display: swap; font-weight: 700; src: url(assets/montserrat-700.woff2) format("woff2"); }
  :root {
    --background: oklch(1 0 0); --foreground: oklch(0.145 0 0); --card: oklch(1 0 0); --primary: oklch(0.205 0 0); --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.97 0 0); --muted: oklch(0.97 0 0); --muted-foreground: oklch(0.556 0 0); --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.922 0 0); --input: oklch(0.922 0 0); --ring: oklch(0.708 0 0); --radius: 0.625rem; --success: oklch(0.55 0.13 150);
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) { :root {
    --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0); --card: oklch(0.205 0 0); --primary: oklch(0.922 0 0); --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0); --muted: oklch(0.269 0 0); --muted-foreground: oklch(0.708 0 0); --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%); --input: oklch(1 0 0 / 15%); --ring: oklch(0.556 0 0); --success: oklch(0.72 0.14 150);
    color-scheme: dark;
  } .brand img { filter: invert(1); } }
  * { box-sizing: border-box; border-color: var(--border); }
  html { font-family: "Geist Variable", ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; min-height: 100svh; background: var(--background); color: var(--foreground); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; padding: 32px 16px 24px; display: flex; flex-direction: column; }
  main { width: 100%; max-width: 42rem; margin: 0 auto; display: grid; gap: 16px; flex: 1; align-content: start; }
  a { color: var(--foreground); text-underline-offset: 4px; }
  /* Header — like KioskShell: brand mark, then the page title. */
  header { display: grid; justify-items: center; gap: 6px; text-align: center; margin-bottom: 8px; }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 1.5rem; }
  .brand img { width: 1em; height: 1em; object-fit: contain; }
  .brand span { font-family: "Montserrat", ui-sans-serif, sans-serif; font-weight: 700; letter-spacing: -0.025em; }
  header h1 { font-size: 1rem; font-weight: 600; margin: 4px 0 0; }
  .soft { color: var(--muted-foreground); }
  p { margin: 4px 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: var(--muted); border-radius: calc(var(--radius) * 0.6); padding: 1px 6px; word-break: break-all; }
  /* Card — rounded-xl, ring-1 ring-foreground/10, 16px spacing. */
  .card { background: var(--card); border-radius: calc(var(--radius) * 1.4); box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 10%, transparent); padding: 16px; display: grid; gap: 8px; }
  .card h2 { font-size: 1rem; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
  .done > h2::after { content: "Klaar"; font-size: 0.75rem; font-weight: 500; color: var(--success); border: 1px solid color-mix(in oklch, var(--success) 40%, transparent); border-radius: 999px; padding: 0 8px; line-height: 1.4rem; }
  form { display: grid; gap: 6px; }
  label { font-weight: 500; margin-top: 6px; }
  label.check { display: flex; gap: 8px; align-items: center; font-weight: 400; }
  /* Input — h-8, rounded-lg, border-input. */
  input[type=text], input[type=password], input[type=url], select { height: 2rem; width: 100%; border: 1px solid var(--input); border-radius: var(--radius); background: transparent; color: var(--foreground); padding: 0 10px; font: inherit; outline: none; transition: border-color .15s, box-shadow .15s; }
  input::placeholder { color: var(--muted-foreground); }
  input:focus-visible, select:focus-visible, button:focus-visible { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 50%, transparent); }
  input[type=checkbox] { accent-color: var(--primary); width: 16px; height: 16px; }
  /* Button — default and outline variants. */
  button { justify-self: start; height: 2rem; padding: 0 10px; border-radius: var(--radius); border: 1px solid transparent; background: var(--primary); color: var(--primary-foreground); font: inherit; font-weight: 500; cursor: pointer; margin-top: 8px; transition: background .15s; }
  button:hover { background: color-mix(in oklch, var(--primary) 80%, transparent); }
  button:active { transform: translateY(1px); }
  button.secondary { background: var(--background); color: var(--foreground); border-color: var(--border); }
  button.secondary:hover { background: var(--muted); }
  button:disabled { opacity: .5; pointer-events: none; }
  a.button { display: inline-flex; align-items: center; justify-self: start; height: 2rem; padding: 0 10px; border-radius: var(--radius); background: var(--primary); color: var(--primary-foreground); font-weight: 500; text-decoration: none; margin-top: 8px; }
  a.button:hover { background: color-mix(in oklch, var(--primary) 80%, transparent); }
  button.big, a.button.big { height: 2.75rem; padding: 0 20px; font-size: 1rem; }
  .recovery-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.35rem; font-weight: 600; letter-spacing: 0.06em; text-align: center; background: var(--muted); border-radius: var(--radius); padding: 12px; margin: 8px 0; user-select: all; }
  details.card > summary { font-weight: 600; cursor: pointer; }
  details.card[open] > summary { margin-bottom: 8px; }
  details.card > div { display: grid; gap: 16px; }
  .error { color: var(--destructive); font-weight: 500; margin: 2px 0 0; }
  .error:empty { display: none; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  ol.steps { list-style: none; padding: 0; margin: 4px 0 0; display: grid; gap: 2px; }
  ol.steps li { display: flex; gap: 10px; align-items: baseline; padding: 2px 0; }
  ol.steps .icon { width: 1.1em; text-align: center; flex: none; }
  .todo .icon::before { content: "○"; color: var(--muted-foreground); }
  .running .icon::before, .retry .icon::before { content: "◌"; color: var(--foreground); }
  ol.steps li.done .icon::before { content: "✓"; color: var(--success); font-weight: 700; }
  .failed .icon::before { content: "✕"; color: var(--destructive); font-weight: 700; }
  ol.steps .detail { color: var(--muted-foreground); }
  ol.steps li.failed .detail { color: var(--destructive); }
  /* Footer — like the console's. */
  footer { display: flex; align-items: center; justify-content: center; gap: 8px; border-top: 1px solid var(--border); margin-top: 32px; padding-top: 12px; font-size: 12px; color: var(--muted-foreground); flex-wrap: wrap; }
  footer img { width: 20px; height: 20px; object-fit: contain; }
  @media (prefers-color-scheme: dark) { footer img { filter: invert(1); } }
  footer a { color: var(--muted-foreground); text-decoration: none; }
  footer a:hover { color: var(--foreground); text-decoration: underline; }
  ul.checks { list-style: none; padding: 0; margin: 4px 0 0; display: grid; gap: 2px; }
  ul.checks li::before { display: inline-block; width: 1.3em; font-weight: 700; }
  ul.checks li.ok::before { content: "✓"; color: var(--success); }
  ul.checks li.bad { color: var(--destructive); } ul.checks li.bad::before { content: "✕"; }
  ul.checks li.note { color: var(--muted-foreground); } ul.checks li.note::before { content: "!"; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand"><img src="assets/kabouter.png" alt=""><span>arcanum</span></div>
    <h1>Installeren</h1>
    <p class="soft">Installeert Arcanum op je eigen Cloudflare-account. Je gegevens blijven daar.</p>
  </header>

  <section id="login" class="card hidden">
    <h2>Aanmelden</h2>
    <p class="error" data-login-error></p>
    <div data-login-account class="hidden">
      <p class="soft">Met het account waarmee je Arcanum installeert (<span data-login-issuer></span>).</p>
      <a class="button" href="auth/login">Aanmelden met je account</a>
    </div>
    <p data-login-handoff class="soft hidden">Deze installer staat klaar op je Cloudflare-account, maar werd nog niet overgedragen. Open hem via de link die je op start.kaboutersoft.be kreeg — of start daar "Eigen installatie" opnieuw.</p>
    <form data-form="login" class="hidden">
      <p class="soft" data-login-hint></p>
      <label for="password" data-login-label>Wachtwoord</label><input id="password" name="password" type="password" autocomplete="current-password" required><button class="secondary">Aanmelden</button><p class="error" data-error></p>
    </form>
  </section>

  <section id="recovery" class="card hidden">
    <h2>Bewaar je herstelcode</h2>
    <p>Je bent aangemeld als <strong data-recovery-email></strong>. Voortaan meld je je hier aan met dat account. Lukt dat ooit niet (bijvoorbeeld omdat de login-provider onbereikbaar is), dan kom je binnen met deze herstelcode:</p>
    <p class="recovery-code" data-recovery-code></p>
    <p class="soft">Hij wordt maar één keer getoond — bewaar hem op een veilige plek, bijvoorbeeld in je wachtwoordbeheerder. Wie hem heeft, kan deze installer bedienen. De vorige herstelcode (als er een was) werkt niet meer.</p>
    <p class="soft">Start de installer na een update ooit niet meer? Zet hem terug in het Cloudflare-dashboard: <em>Workers &amp; Pages → arcanum-installer → Deployments</em> → de vorige versie → <em>Rollback</em>.</p>
    <label class="check"><input type="checkbox" data-recovery-saved> Ik heb de herstelcode bewaard</label>
    <button data-recovery-continue disabled>Verder</button>
  </section>

  <section id="denied" class="card hidden">
    <h2>Geen toegang</h2>
    <p data-denied></p>
    <p class="soft">Alleen de beheerders van deze installatie (stap 3) kunnen de installer openen.</p>
  </section>

  <div id="app" class="hidden" style="display:grid;gap:16px">
    <p data-access class="soft hidden" style="text-align:center;margin:0"></p>
    <section id="s-cloudflare" class="card">
      <h2>1. Cloudflare</h2>
      <p>Maak een API-token met precies de nodige rechten: <a id="token-link" target="_blank" rel="noopener">token aanmaken bij Cloudflare</a> (opent met de rechten al ingevuld), kopieer het en plak het hier.</p>
      <p data-summary class="soft"></p>
      <form data-form="cloudflare">
        <label for="token">API-token</label><input id="token" name="token" type="password" autocomplete="off" required>
        <div data-accounts class="hidden"><label for="accountId">Account</label><select id="accountId" name="accountId"></select></div>
        <div data-subdomain class="hidden"><label for="subdomain">Kies je workers.dev-naam</label><input id="subdomain" name="subdomain" type="text" autocomplete="off"><p class="soft">Dit account heeft nog geen workers.dev-adres. Arcanum komt dan op <code>arcanum-bff.<span data-subdomain-preview>…</span>.workers.dev</code>. De naam geldt voor het hele Cloudflare-account en is later moeilijk te wijzigen.</p></div>
        <label class="check"><input type="checkbox" name="remember" checked> Token onthouden voor latere updates (veilig versleuteld, nooit opnieuw zichtbaar)</label>
        <button>Controleren en bewaren</button><p class="error" data-error></p>
      </form>
    </section>

    <section id="s-address" class="card">
      <h2>Adres</h2>
      <p class="soft">Arcanum komt op <code data-workersdev>—</code>. Heb je een domein in dit Cloudflare-account? Dan kan het ook op een eigen adres, bv. <code>arcanum.jouwdomein.be</code> — Cloudflare maakt het DNS-record en het certificaat zelf aan.</p>
      <p data-summary class="soft"></p>
      <form data-form="address"><label for="customDomain">Eigen domein (optioneel)</label><input id="customDomain" name="customDomain" type="text" placeholder="arcanum.jouwdomein.be" autocomplete="off"><button>Bewaren</button><p class="error" data-error></p></form>
    </section>

    <section id="s-login" class="card">
      <h2>2. Aanmelden bij Arcanum</h2>
      <p data-login-default class="soft hidden">Arcanum gebruikt nu <code data-login-current></code> — je hoeft hier niets te doen. Alleen voor een eigen login-provider:</p>
      <p>Arcanum gebruikt een bestaande login-provider (Google, Microsoft, Auth0, Keycloak…). Maak daar een OAuth-client aan met:</p>
      <p>Callback-URL: <code data-callback>—</code><br>Afmeld-URL: <code data-logout>—</code></p>
      <p data-summary class="soft"></p>
      <form data-form="login-provider">
        <label for="issuer">Issuer-URL</label><input id="issuer" name="issuer" type="url" placeholder="https://accounts.google.com" required>
        <label for="clientId">Client ID</label><input id="clientId" name="clientId" type="text" required>
        <label for="clientSecret">Client secret</label><input id="clientSecret" name="clientSecret" type="password" autocomplete="off">
        <p data-google class="soft hidden">Google heeft <strong>twee</strong> OAuth-clients nodig: een client van het type <em>TVs and Limited Input devices</em> hierboven (voor aanmelden op de kassa) en een client van het type <em>Web application</em> hieronder, met de callback-URL als <em>Authorized redirect URI</em>. De scopes worden <code>openid profile email</code> (Google weigert <code>offline_access</code>).</p>
        <label for="scopes">Scopes (optioneel)</label><input id="scopes" name="scopes" type="text" placeholder="openid profile email offline_access">
        <label for="authCodeClientId">Aparte client voor aanmelden in de browser (optioneel)</label><input id="authCodeClientId" name="authCodeClientId" type="text" placeholder="Client ID">
        <input id="authCodeClientSecret" name="authCodeClientSecret" type="password" autocomplete="off" placeholder="Client secret">
        <label for="connectionName">Auth0-connectie (optioneel)</label><input id="connectionName" name="connectionName" type="text">
        <button>Controleren en bewaren</button><p class="error" data-error></p>
        <ul class="checks" data-checks></ul>
      </form>
    </section>

    <section id="s-admins" class="card">
      <h2>3. Beheerders</h2>
      <p class="soft">Alleen deze mensen kunnen op deze installatie een organisatie aanmaken of importeren. Anderen kunnen wel uitgenodigd worden. Gebruik <code>*@jouwdomein.be</code> voor een heel domein.</p>
      <p data-summary class="soft"></p>
      <form data-form="admins"><label for="emails">E-mailadressen</label><input id="emails" name="emails" type="text" placeholder="jij@jouwdomein.be" required><button>Bewaren</button><p class="error" data-error></p></form>
    </section>

    <section id="s-release" class="card">
      <h2>4. Versie</h2>
      <p data-summary class="soft"></p>
      <p data-update></p>
      <form data-form="release"><label for="version">Versie</label><select id="version" name="version"></select><button>Kiezen</button><p class="error" data-error></p></form>
    </section>

    <section id="s-install" class="card">
      <h2>5. Installeren</h2>
      <p data-quick class="hidden">Arcanum komt op <code data-quick-url></code>, op je Cloudflare-account <strong data-quick-account></strong>. Beheerder: <span data-quick-admins></span>. Al de rest is ingevuld — klik op Installeren.</p>
      <div data-quick-version class="hidden" style="display:grid;gap:6px"><label for="quick-version">Versie</label><select id="quick-version"></select></div>
      <p class="soft">Elke stap kan veilig opnieuw uitgevoerd worden — onderbroken of mislukt? Klik gewoon opnieuw.</p>
      <p class="soft hidden" data-self-note>Deze update brengt een nieuwe installer mee. Die wordt eerst geïnstalleerd, over deze heen, en voert daarna de rest van de update uit. Lukt dat niet, dan verandert er niets en blijft deze installer werken. Start de nieuwe installer niet (deze pagina laadt niet meer)? Zet hem terug in het Cloudflare-dashboard: <em>Workers &amp; Pages → <span data-self-script>arcanum-installer</span> → Deployments</em> → de vorige versie → <em>Rollback</em>.</p>
      <ol class="steps" data-steps></ol>
      <div class="row"><button data-run>Installeren</button></div><p class="error" data-error></p>
    </section>

    <details id="advanced" class="card hidden">
      <summary>Geavanceerd</summary>
      <p class="soft">Niet nodig voor een gewone installatie: een eigen domein, een eigen login-provider, het Cloudflare-token en de beheerders.</p>
      <div data-advanced></div>
    </details>

    <section id="s-done" class="card hidden">
      <h2>Klaar</h2>
      <p><a class="button big" data-open target="_blank" rel="noopener">Open je Arcanum</a></p>
      <p>Arcanum draait op <a data-url target="_blank" rel="noopener"></a>.</p>
      <p data-live class="soft">Bereikbaarheid controleren…</p>
      <p>Meld je daar aan met een beheerdersadres en maak je organisatie aan — of importeer ze via <em>Instellingen → Gegevens</em> uit een export van je vorige installatie.</p>
    </section>

    <section id="s-public" class="card hidden">
      <h2>Openbare toegang verwijderen</h2>
      <p class="soft">Nu Arcanum draait, kan de installer achter Arcanum: bereikbaar via <code data-installer-url>—</code> voor wie als beheerder aangemeld is, zonder wachtwoord. Daarna kan zijn eigen openbare adres uit.</p>
      <ol class="steps" data-public-steps>
        <li data-public="link"><span class="icon"></span><span><span class="title">Bereikbaar via Arcanum</span> <span class="detail"></span></span></li>
        <li data-public="open"><span class="icon"></span><span><span class="title">Geopend via Arcanum</span> <span class="detail"></span></span></li>
        <li data-public="direct"><span class="icon"></span><span><span class="title">Eigen openbaar adres uitgeschakeld</span> <span class="detail"></span></span></li>
      </ol>
      <div class="row">
        <button data-public-link>Bereikbaar maken via Arcanum</button>
        <a data-public-open class="hidden" href="#">Open de installer via Arcanum →</a>
        <button data-public-remove class="hidden">Openbaar adres uitschakelen</button>
        <button data-public-restore class="secondary hidden">Openbaar adres weer inschakelen</button>
      </div>
      <p class="soft" data-public-note></p>
      <p class="error" data-error></p>
    </section>

    <p class="row"><button class="secondary" data-logout-button>Afmelden</button></p>
  </div>
</main>
<footer>
  <img src="assets/kabouter.png" alt="">
  <a href="https://kaboutersoft.be" target="_blank" rel="noopener noreferrer">Voor u geserveerd door kaboutersoft.be</a>
  <span aria-hidden="true">·</span>
  <a href="https://github.com/arcanum-pos/arcanum-installer" target="_blank" rel="noopener noreferrer" title="Arcanum is vrije software (AGPL-3.0)">Broncode</a>
</footer>
<script>
const $ = (s, el = document) => el.querySelector(s);
let status = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'api/login') { show(false); throw new Error('Niet aangemeld'); }
  if (res.status === 403 && data.forbidden) { denied(data.error); throw new Error(data.error); }
  if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { data });
  return data;
}

function denied(message) { $('#denied').classList.remove('hidden'); $('[data-denied]').textContent = message; $('#login').classList.add('hidden'); $('#app').classList.add('hidden'); }
function show(loggedIn) { $('#login').classList.toggle('hidden', loggedIn); $('#app').classList.toggle('hidden', !loggedIn); $('#recovery').classList.add('hidden'); if (!loggedIn) loadLoginOptions(); }

// The ways in this installer has: its password (Deploy button), or — made
// by the bootstrapper — the admin's account and the recovery code.
async function loadLoginOptions() {
  let o = null; try { o = await (await fetch('api/login-options', { credentials: 'same-origin' })).json(); } catch { return; }
  $('[data-login-account]').classList.toggle('hidden', !o.account);
  if (o.account) $('[data-login-issuer]').textContent = new URL(o.account.issuer).host;
  $('[data-login-handoff]').classList.toggle('hidden', !o.awaitingHandoff);
  const form = $('form[data-form="login"]'); form.classList.toggle('hidden', !o.password && !o.recoveryCode);
  $('[data-login-label]').textContent = o.password && o.recoveryCode ? 'Wachtwoord of herstelcode' : o.password ? 'Wachtwoord' : 'Herstelcode';
  $('[data-login-hint]').textContent = o.password ? 'Het wachtwoord dat je koos bij het installeren van deze installer (INSTALLER_PASSWORD).' : 'Lukt aanmelden met je account niet? Gebruik de herstelcode die je bij de start kreeg.';
  $('#password').autocomplete = o.password ? 'current-password' : 'off';
}

// Why signing in with an account didn't work (oidc.ts sends ?fout=).
const SIGN_IN_ERRORS = {
  'geen-beheerder': ' staat niet in de lijst met beheerders van deze installatie.',
  'niet-bevestigd': 'Je e-mailadres is nog niet bevestigd bij de login-provider — bevestig het en probeer opnieuw.',
  'aanmelden-verlopen': 'Het aanmelden duurde te lang of werd in een ander venster gestart — probeer opnieuw.',
  'aanmelden-geweigerd': 'Aanmelden werd geannuleerd of geweigerd.',
  'aanmelden-mislukt': 'Aanmelden is mislukt — probeer opnieuw.',
  'provider-onbereikbaar': 'De login-provider is niet bereikbaar. Gebruik je herstelcode.',
  'geen-account-aanmelding': 'Deze installer kent geen aanmelding met een account.',
};
function signInError(params) {
  const reason = params.get('fout'); if (!reason) return '';
  return reason === 'geen-beheerder' ? (params.get('email') || 'Dit account') + SIGN_IN_ERRORS[reason] : (SIGN_IN_ERRORS[reason] || 'Aanmelden is mislukt.');
}

function showRecovery(r) {
  $('#login').classList.add('hidden'); $('#app').classList.add('hidden'); $('#recovery').classList.remove('hidden');
  $('[data-recovery-email]').textContent = r.email; $('[data-recovery-code]').textContent = r.recoveryCode;
}
$('[data-recovery-saved]').addEventListener('change', (ev) => { $('[data-recovery-continue]').disabled = !ev.target.checked; });
$('[data-recovery-continue]').addEventListener('click', async () => { $('[data-recovery-code]').textContent = ''; await refresh(); show(true); await loadReleases(); });

// Made by the bootstrapper: one screen. The detailed cards move under "Geavanceerd".
const ADVANCED = { 's-address': 'Eigen domein', 's-login': 'Eigen login-provider', 's-cloudflare': 'Cloudflare-token', 's-admins': 'Beheerders' };
let arranged = false;
function arrange(s) {
  const quick = !!s.bootstrapped;
  $('#advanced').classList.toggle('hidden', !quick);
  $('#s-release').classList.toggle('hidden', quick);
  $('[data-quick]').classList.toggle('hidden', !quick);
  $('[data-quick-version]').classList.toggle('hidden', !quick);
  $('[data-login-default]').classList.toggle('hidden', !quick);
  if (!quick || arranged) return;
  arranged = true;
  for (const [id, title] of Object.entries(ADVANCED)) { const el = $('#' + id); $('h2', el).textContent = title; $('[data-advanced]').append(el); }
  $('#s-install h2').textContent = 'Installeren';
  $('[data-run]').classList.add('big');
}

function render() {
  const s = status;
  arrange(s);
  $('#token-link').href = s.tokenTemplateUrl;
  const set = (id, done, summary) => { const el = $(id); el.classList.toggle('done', !!done); $('[data-summary]', el) && ($('[data-summary]', el).textContent = summary || ''); };
  set('#s-cloudflare', s.cloudflare && s.cloudflare.tokenAvailable, s.cloudflare ? 'Account: ' + s.cloudflare.accountName + ' · adres: ' + (s.address ? s.address.publicUrl : '') + (s.cloudflare.tokenAvailable ? '' : ' · token opnieuw nodig') : '');
  $('[data-workersdev]').textContent = s.address ? s.address.workersDevUrl : '(eerst stap 1)';
  set('#s-address', false, s.address && s.address.customDomain ? 'Adres: ' + s.address.publicUrl + ' (workers.dev blijft ook werken)' : '');
  if (s.address && s.address.customDomain) $('#customDomain').value ||= s.address.customDomain;
  $('[data-callback]').textContent = s.address ? s.address.callbackUrl : '(eerst stap 1)';
  $('[data-logout]').textContent = s.address ? s.address.logoutUrl : '(eerst stap 1)';
  set('#s-login', s.login, s.login ? 'Issuer: ' + s.login.issuer + ' · client: ' + s.login.clientId : '');
  if (s.login) $('[data-login-current]').textContent = new URL(s.login.issuer).host;
  if (s.bootstrapped) {
    $('[data-quick-url]').textContent = s.address ? s.address.publicUrl : '';
    $('[data-quick-account]').textContent = s.cloudflare ? s.cloudflare.accountName : '';
    $('[data-quick-admins]').textContent = s.admins || '';
  }
  if (s.login) {
    $('#issuer').value ||= s.login.issuer; $('#clientId').value ||= s.login.clientId; $('#clientSecret').placeholder = '(bewaard — leeg laten om te behouden)';
    $('#scopes').value ||= s.login.scopes || ''; $('#authCodeClientId').value ||= s.login.authCodeClientId || '';
    if (s.login.authCodeClientSecretSet) $('#authCodeClientSecret').placeholder = '(bewaard — leeg laten om te behouden)';
  }
  googleHint();
  set('#s-admins', s.admins, s.admins ? s.admins : '');
  if (s.admins) $('#emails').value ||= s.admins;
  set('#s-release', s.release, s.release ? 'Arcanum ' + s.release.version + (s.installed && s.installed.version !== s.release.version ? ' (bijwerken van ' + s.installed.version + ')' : '') : '');
  $('#s-release button').textContent = s.installed ? 'Bijwerken naar deze versie' : 'Kiezen';
  const list = $('[data-steps]'); list.innerHTML = '';
  for (const step of s.steps) {
    const li = document.createElement('li'); li.className = step.status; li.dataset.id = step.id;
    li.innerHTML = '<span class="icon"></span><span><span class="title"></span> <span class="detail"></span></span>';
    $('.title', li).textContent = step.title; $('.detail', li).textContent = step.detail ? '— ' + step.detail : '';
    list.append(li);
  }
  // One screen: the version is chosen right here, when Installeren is clicked.
  const ready = s.cloudflare && s.login && s.admins && (s.release || s.bootstrapped);
  $('[data-run]').disabled = !ready || running;
  const chosen = s.bootstrapped ? $('#quick-version').value : (s.release && s.release.version);
  const updating = s.installed && chosen && s.installed.version !== chosen;
  const sameRelease = s.release && chosen === s.release.version;
  $('[data-run]').textContent = updating ? 'Bijwerken naar ' + chosen : sameRelease && s.steps.some(x => x.status === 'done') && !s.installed ? 'Verder installeren' : 'Installeren';
  const selfStep = s.steps.some(x => x.id === 'installer:self');
  $('[data-self-note]').classList.toggle('hidden', !selfStep);
  set('#s-install', s.installed, '');
  $('#s-done').classList.toggle('hidden', !s.installed);
  if (s.installed) { $('[data-url]').href = s.address.publicUrl; $('[data-url]').textContent = s.address.publicUrl; $('[data-open]').href = s.address.publicUrl + '/console'; probe(); }
  const viaArcanum = s.access && s.access.via === 'arcanum';
  $('[data-access]').classList.toggle('hidden', !(s.access && s.access.email));
  if (s.access && s.access.email) $('[data-access]').textContent = (viaArcanum ? 'Aangemeld via Arcanum als ' : 'Aangemeld als ') + s.access.email;
  $('[data-logout-button]').classList.toggle('hidden', !!viaArcanum);
  $('#s-public').classList.toggle('hidden', !s.installed);
  if (s.installed) loadPublicAccess();
}

// "Openbare toegang verwijderen": link the installer to Arcanum, prove it
// works by opening it there, and only then switch its own address off.
let publicLoading = false;
async function loadPublicAccess() {
  if (publicLoading) return; publicLoading = true;
  const box = $('#s-public'); const err = $('[data-error]', box);
  try {
    const p = await api('api/public-access');
    const via = p.via === 'arcanum';
    const mark = (id, state, detail) => { const li = $('[data-public="' + id + '"]', box); li.className = state; $('.detail', li).textContent = detail ? '— ' + detail : ''; };
    $('[data-installer-url]').textContent = p.installerUrl;
    mark('link', p.linked ? 'done' : 'todo', p.linked ? '' : (p.supported ? '' : 'deze versie van Arcanum kan dat nog niet — werk eerst bij (stap 4)'));
    mark('open', via ? 'done' : 'todo', via ? '' : (p.linked ? 'open ' + p.installerUrl + ' en ga daar verder' : ''));
    mark('direct', p.directEnabled === false ? 'done' : 'todo', p.directEnabled === null ? 'onbekend (Cloudflare-token nodig)' : p.directEnabled ? p.directUrl + ' is nog openbaar' : '');
    $('[data-public-link]').classList.toggle('hidden', p.linked);
    $('[data-public-link]').disabled = !p.supported;
    const open = $('[data-public-open]'); open.href = p.installerUrl; open.classList.toggle('hidden', !p.linked || via);
    $('[data-public-remove]').classList.toggle('hidden', !(via && p.directEnabled !== false));
    $('[data-public-restore]').classList.toggle('hidden', !(via && p.directEnabled === false));
    box.classList.toggle('done', p.linked && p.directEnabled === false);
    $('[data-public-note]').textContent = p.directEnabled === false
      ? 'De installer is alleen nog bereikbaar via Arcanum. Werk je de installer zelf bij (een nieuwe versie van je kopie), dan zet Cloudflare zijn openbare adres weer aan — schakel het dan hier opnieuw uit. Het wachtwoord (INSTALLER_PASSWORD) blijft als noodtoegang op de Worker staan.'
      : '';
  } catch (e) { err.textContent = e.message; } finally { publicLoading = false; }
}
async function publicAction(path) {
  const err = $('#s-public [data-error]'); err.textContent = '';
  try { status = await api(path, {}); render(); } catch (e) { err.textContent = e.message; }
}
$('[data-public-link]').addEventListener('click', () => publicAction('api/public-access/link'));
$('[data-public-remove]').addEventListener('click', () => publicAction('api/public-access/remove'));
$('[data-public-restore]').addEventListener('click', () => publicAction('api/public-access/restore'));

// Live check from the browser: load one real asset of the installation
// (bff → frontends). The installer itself can't fetch its own account's
// workers.dev addresses (Cloudflare blocks Worker-to-Worker fetches there).
let probing = false;
function probe(attempt = 0) {
  if (probing || !status.probeUrl) return; probing = true;
  const img = new Image();
  img.onload = () => { probing = false; $('[data-live]').textContent = '✓ Arcanum is bereikbaar vanuit je browser.'; };
  img.onerror = () => {
    probing = false;
    if (attempt >= 24) { $('[data-live]').textContent = 'Arcanum antwoordt nog niet vanuit je browser. Een nieuw workers.dev-adres kan enkele minuten nodig hebben — probeer het adres hierboven straks opnieuw.'; return; }
    $('[data-live]').textContent = 'Wachten tot het adres bereikbaar is… (Cloudflare zet het klaar)';
    setTimeout(() => probe(attempt + 1), 5000);
  };
  img.src = status.probeUrl + '?check=' + Date.now();
}

// Results of the provider test of step 2 (kassa client, its secret, browser client).
function showChecks(checks) {
  const list = $('[data-checks]'); list.innerHTML = '';
  for (const c of checks) { const li = document.createElement('li'); li.className = c.ok ? 'ok' : c.blocking ? 'bad' : 'note'; li.textContent = c.message; list.append(li); }
}

function googleHint() {
  // No regex here: this page is a template string, where \/ would collapse to / .
  let google = false; try { google = new URL($('#issuer').value.trim()).host === 'accounts.google.com'; } catch {}
  $('[data-google]').classList.toggle('hidden', !google);
  if (google && !$('#scopes').value) $('#scopes').value = 'openid profile email';
}
document.addEventListener('input', (ev) => { if (ev.target.id === 'issuer') googleHint(); });

async function refresh() { status = await api('api/status'); render(); }

function newerThan(a, b) {
  const x = a.split('-')[0].split('.').map(Number), y = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function loadReleases() {
  try {
    const r = await api('api/releases');
    fillVersions($('#quick-version'), r);
    const sel = $('#version'); sel.innerHTML = '';
    const newer = r.installed ? r.releases.map((x) => x.version).filter((v) => newerThan(v, r.installed)).sort((a, b) => (newerThan(a, b) ? -1 : 1)) : [];
    for (const rel of r.releases) {
      const o = document.createElement('option'); o.value = rel.version;
      const tag = rel.version === r.installed ? ' — geïnstalleerd' : newer.includes(rel.version) ? ' — nieuwer' : rel.version === r.latest ? ' — nieuwste' : '';
      o.textContent = 'Arcanum ' + rel.version + (rel.prerelease ? ' (voorlopige versie)' : '') + tag; sel.append(o);
    }
    // Installed: preselect the newest version above it; otherwise the chosen one.
    if (newer.length) sel.value = newer[0];
    else if (status && status.release) sel.value = status.release.version;
    $('[data-update]').textContent = newer.length ? 'Nieuwere versie beschikbaar: Arcanum ' + newer[0] + ' — kies ze en klik op "Bijwerken naar deze versie".' : '';
    if (status) render();
  } catch (e) { $('#s-release [data-error]').textContent = e.message; $('#s-install [data-error]').textContent = e.message; }
}

// The one-screen version choice: the newest release (or the newest above the installed one).
function fillVersions(sel, r) {
  const keep = sel.value; sel.innerHTML = '';
  for (const rel of r.releases) {
    if (r.installed && newerThan(r.installed, rel.version)) continue;
    const o = document.createElement('option'); o.value = rel.version;
    o.textContent = 'Arcanum ' + rel.version + (rel.prerelease ? ' (voorlopige versie)' : '') + (rel.version === r.installed ? ' — geïnstalleerd' : ''); sel.append(o);
  }
  sel.value = keep && [...sel.options].some(o => o.value === keep) ? keep : (sel.options[0] ? sel.options[0].value : '');
}
$('#quick-version').addEventListener('change', () => { if (status) render(); });

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]'); if (!form) return;
  ev.preventDefault();
  const err = $('[data-error]', form); err.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.form === 'cloudflare') data.remember = form.remember.checked;
  const button = $('button', form); button.disabled = true;
  try {
    const result = await api('api/' + form.dataset.form, data);
    if (form.dataset.form === 'login') { show(true); await refresh(); await loadReleases(); return; }
    if (result.needsSubdomain) {
      const box = $('[data-subdomain]', form); box.classList.remove('hidden');
      if (!form.subdomain.value) form.subdomain.value = result.suggestion;
      $('[data-subdomain-preview]').textContent = form.subdomain.value;
      form.subdomain.oninput = () => { $('[data-subdomain-preview]').textContent = form.subdomain.value || '…'; };
      err.textContent = 'Kies een workers.dev-naam en bevestig opnieuw.'; return;
    }
    if (result.needsAccount) {
      const sel = $('#accountId'); sel.innerHTML = ''; for (const a of result.accounts) { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; sel.append(o); }
      $('[data-accounts]', form).classList.remove('hidden'); err.textContent = 'Kies het account en bevestig opnieuw.'; return;
    }
    status = result; render();
    if (result.checks) showChecks(result.checks);
    if (form.dataset.form === 'cloudflare') form.token.value = '';
    if (form.dataset.form === 'login-provider') { form.clientSecret.value = ''; form.authCodeClientSecret.value = ''; }
  } catch (e) { err.textContent = e.message; if (e.data && e.data.checks) showChecks(e.data.checks); } finally { button.disabled = false; }
});

let running = false;
async function runAll() {
  running = true; render(); const err = $('#s-install [data-error]'); err.textContent = '';
  try {
    // One screen: choose the version picked right here first (a fresh install, or an update).
    if (status.bootstrapped) {
      const version = $('#quick-version').value;
      if (!version) throw new Error('Geen versie beschikbaar — probeer straks opnieuw.');
      if (!status.release || status.release.version !== version) { status = await api('api/release', { version }); render(); }
    }
    for (const step of status.steps) {
      if (step.status === 'done') continue;
      for (let attempt = 0; ; attempt++) {
        const li = $('[data-id="' + CSS.escape(step.id) + '"]'); if (li) li.className = 'running';
        const r = await api('api/step', { id: step.id });
        if (r.status === 'done') break;
        if (r.status === 'retry' && attempt < 20) { if (li) { li.className = 'retry'; $('.detail', li).textContent = '— ' + r.detail + ' (opnieuw over 6 s)'; } await new Promise(res => setTimeout(res, 6000)); continue; }
        await refresh(); throw new Error(step.title + ': ' + r.detail);
      }
      // The new installer takes over from the next request: give Cloudflare a moment.
      if (step.id === 'installer:self') await new Promise(res => setTimeout(res, 3000));
      await refresh();
    }
  } catch (e) { err.textContent = e.message; if (e.data && e.data.needsToken) $('#token').focus(); }
  finally { running = false; await refresh().catch(() => {}); }
}
$('[data-run]').addEventListener('click', runAll);
$('[data-logout-button]').addEventListener('click', async () => { await api('api/logout', {}); show(false); });

(async () => {
  const params = new URLSearchParams(location.search);
  // The bootstrapper's link: hand the code over once, then show the recovery code.
  if (location.pathname.endsWith('/handoff')) {
    const code = params.get('code') || '';
    history.replaceState(null, '', './');
    try { showRecovery(await api('api/handoff', { code })); } catch (e) { show(false); $('[data-login-error]').textContent = e.message; }
    return;
  }
  const failure = signInError(params);
  if (failure) history.replaceState(null, '', location.pathname);
  try { await refresh(); show(true); await loadReleases(); } catch { show(false); $('[data-login-error]').textContent = failure; }
})();
</script>
</body>
</html>`;
