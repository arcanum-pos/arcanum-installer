// The setup page: one self-contained HTML document (no build step, no
// external assets), talking to api/*. Dutch, like the rest of Arcanum. Every
// path is relative: the same page works on the installer's own address
// (at /) and behind Arcanum (at /installer/, forwarded by the bff).
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
    <p class="soft">Het wachtwoord dat je koos bij het installeren van deze installer (INSTALLER_PASSWORD).</p>
    <form data-form="login"><label for="password">Wachtwoord</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Aanmelden</button><p class="error" data-error></p></form>
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
      <p class="soft">Elke stap kan veilig opnieuw uitgevoerd worden — onderbroken of mislukt? Klik gewoon opnieuw.</p>
      <ol class="steps" data-steps></ol>
      <div class="row"><button data-run>Installeren</button></div><p class="error" data-error></p>
    </section>

    <section id="s-done" class="card hidden">
      <h2>Klaar</h2>
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
function show(loggedIn) { $('#login').classList.toggle('hidden', loggedIn); $('#app').classList.toggle('hidden', !loggedIn); }

function render() {
  const s = status;
  $('#token-link').href = s.tokenTemplateUrl;
  const set = (id, done, summary) => { const el = $(id); el.classList.toggle('done', !!done); $('[data-summary]', el) && ($('[data-summary]', el).textContent = summary || ''); };
  set('#s-cloudflare', s.cloudflare && s.cloudflare.tokenAvailable, s.cloudflare ? 'Account: ' + s.cloudflare.accountName + ' · adres: ' + (s.address ? s.address.publicUrl : '') + (s.cloudflare.tokenAvailable ? '' : ' · token opnieuw nodig') : '');
  $('[data-workersdev]').textContent = s.address ? s.address.workersDevUrl : '(eerst stap 1)';
  set('#s-address', false, s.address && s.address.customDomain ? 'Adres: ' + s.address.publicUrl + ' (workers.dev blijft ook werken)' : '');
  if (s.address && s.address.customDomain) $('#customDomain').value ||= s.address.customDomain;
  $('[data-callback]').textContent = s.address ? s.address.callbackUrl : '(eerst stap 1)';
  $('[data-logout]').textContent = s.address ? s.address.logoutUrl : '(eerst stap 1)';
  set('#s-login', s.login, s.login ? 'Issuer: ' + s.login.issuer + ' · client: ' + s.login.clientId : '');
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
  const ready = s.cloudflare && s.login && s.admins && s.release;
  $('[data-run]').disabled = !ready || running;
  $('[data-run]').textContent = s.installed && s.release && s.installed.version !== s.release.version ? 'Bijwerken' : s.steps.some(x => x.status === 'done') ? 'Verder installeren' : 'Installeren';
  set('#s-install', s.installed, '');
  $('#s-done').classList.toggle('hidden', !s.installed);
  if (s.installed) { $('[data-url]').href = s.address.publicUrl; $('[data-url]').textContent = s.address.publicUrl; probe(); }
  const viaArcanum = s.access && s.access.via === 'arcanum';
  $('[data-access]').classList.toggle('hidden', !viaArcanum);
  if (viaArcanum) $('[data-access]').textContent = 'Aangemeld via Arcanum als ' + s.access.email;
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
  } catch (e) { $('#s-release [data-error]').textContent = e.message; }
}

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
    for (const step of status.steps) {
      if (step.status === 'done') continue;
      for (let attempt = 0; ; attempt++) {
        const li = $('[data-id="' + CSS.escape(step.id) + '"]'); if (li) li.className = 'running';
        const r = await api('api/step', { id: step.id });
        if (r.status === 'done') break;
        if (r.status === 'retry' && attempt < 20) { if (li) { li.className = 'retry'; $('.detail', li).textContent = '— ' + r.detail + ' (opnieuw over 6 s)'; } await new Promise(res => setTimeout(res, 6000)); continue; }
        await refresh(); throw new Error(step.title + ': ' + r.detail);
      }
      await refresh();
    }
  } catch (e) { err.textContent = e.message; if (e.data && e.data.needsToken) $('#token').focus(); }
  finally { running = false; await refresh().catch(() => {}); }
}
$('[data-run]').addEventListener('click', runAll);
$('[data-logout-button]').addEventListener('click', async () => { await api('api/logout', {}); show(false); });

(async () => { try { await refresh(); show(true); await loadReleases(); } catch { show(false); } })();
</script>
</body>
</html>`;
