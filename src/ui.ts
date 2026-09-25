// The setup page: one self-contained HTML document (no build step, no
// external assets), talking to /api/*. Dutch, like the rest of Arcanum.
export const PAGE = /* html */ `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>arcanum · installeren</title>
<link rel="icon" type="image/png" href="/assets/kabouter.png">
<style>
  /* The platform's own look (arcanum-frontends src/shared/globals.css +
     shadcn components): neutral oklch tokens, Geist, radius 0.625rem, and
     the "arcanum" wordmark in Montserrat Bold next to the kabouter logo. */
  @font-face { font-family: "Geist Variable"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(/assets/geist.woff2) format("woff2-variations"); }
  @font-face { font-family: "Montserrat"; font-style: normal; font-display: swap; font-weight: 700; src: url(/assets/montserrat-700.woff2) format("woff2"); }
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
  .hidden { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand"><img src="/assets/kabouter.png" alt=""><span>arcanum</span></div>
    <h1>Installeren</h1>
    <p class="soft">Installeert Arcanum op je eigen Cloudflare-account. Je gegevens blijven daar.</p>
  </header>

  <section id="login" class="card hidden">
    <h2>Aanmelden</h2>
    <p class="soft">Het wachtwoord dat je koos bij het installeren van deze installer (INSTALLER_PASSWORD).</p>
    <form data-form="login"><label for="password">Wachtwoord</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Aanmelden</button><p class="error" data-error></p></form>
  </section>

  <div id="app" class="hidden" style="display:grid;gap:16px">
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

    <section id="s-login" class="card">
      <h2>2. Aanmelden bij Arcanum</h2>
      <p>Arcanum gebruikt een bestaande login-provider (Google, Microsoft, Auth0, Keycloak…). Maak daar een OAuth-client aan met:</p>
      <p>Callback-URL: <code data-callback>—</code><br>Afmeld-URL: <code data-logout>—</code></p>
      <p data-summary class="soft"></p>
      <form data-form="login-provider">
        <label for="issuer">Issuer-URL</label><input id="issuer" name="issuer" type="url" placeholder="https://accounts.google.com" required>
        <label for="clientId">Client ID</label><input id="clientId" name="clientId" type="text" required>
        <label for="clientSecret">Client secret</label><input id="clientSecret" name="clientSecret" type="password" autocomplete="off">
        <label for="connectionName">Auth0-connectie (optioneel)</label><input id="connectionName" name="connectionName" type="text">
        <button>Controleren en bewaren</button><p class="error" data-error></p>
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

    <p class="row"><button class="secondary" data-logout-button>Afmelden</button></p>
  </div>
</main>
<footer>
  <img src="/assets/kabouter.png" alt="">
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
  if (res.status === 401 && path !== '/api/login') { show(false); throw new Error('Niet aangemeld'); }
  if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { data });
  return data;
}

function show(loggedIn) { $('#login').classList.toggle('hidden', loggedIn); $('#app').classList.toggle('hidden', !loggedIn); }

function render() {
  const s = status;
  $('#token-link').href = s.tokenTemplateUrl;
  const set = (id, done, summary) => { const el = $(id); el.classList.toggle('done', !!done); $('[data-summary]', el) && ($('[data-summary]', el).textContent = summary || ''); };
  set('#s-cloudflare', s.cloudflare && s.cloudflare.tokenAvailable, s.cloudflare ? 'Account: ' + s.cloudflare.accountName + ' · adres: ' + (s.address ? s.address.publicUrl : '') + (s.cloudflare.tokenAvailable ? '' : ' · token opnieuw nodig') : '');
  $('[data-callback]').textContent = s.address ? s.address.callbackUrl : '(eerst stap 1)';
  $('[data-logout]').textContent = s.address ? s.address.logoutUrl : '(eerst stap 1)';
  set('#s-login', s.login, s.login ? 'Issuer: ' + s.login.issuer + ' · client: ' + s.login.clientId : '');
  if (s.login) { $('#issuer').value ||= s.login.issuer; $('#clientId').value ||= s.login.clientId; $('#clientSecret').placeholder = '(bewaard — leeg laten om te behouden)'; }
  set('#s-admins', s.admins, s.admins ? s.admins : '');
  if (s.admins) $('#emails').value ||= s.admins;
  set('#s-release', s.release, s.release ? 'Arcanum ' + s.release.version : '');
  const list = $('[data-steps]'); list.innerHTML = '';
  for (const step of s.steps) {
    const li = document.createElement('li'); li.className = step.status; li.dataset.id = step.id;
    li.innerHTML = '<span class="icon"></span><span><span class="title"></span> <span class="detail"></span></span>';
    $('.title', li).textContent = step.title; $('.detail', li).textContent = step.detail ? '— ' + step.detail : '';
    list.append(li);
  }
  const ready = s.cloudflare && s.login && s.admins && s.release;
  $('[data-run]').disabled = !ready || running; $('[data-run]').textContent = s.steps.some(x => x.status === 'done') ? 'Verder installeren' : 'Installeren';
  set('#s-install', s.installed, '');
  $('#s-done').classList.toggle('hidden', !s.installed);
  if (s.installed) { $('[data-url]').href = s.address.publicUrl; $('[data-url]').textContent = s.address.publicUrl; probe(); }
}

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

async function refresh() { status = await api('/api/status'); render(); }

async function loadReleases() {
  try {
    const r = await api('/api/releases');
    const sel = $('#version'); sel.innerHTML = '';
    for (const rel of r.releases) { const o = document.createElement('option'); o.value = rel.version; o.textContent = 'Arcanum ' + rel.version + (rel.prerelease ? ' (voorlopige versie)' : '') + (rel.version === r.latest ? ' — nieuwste' : ''); sel.append(o); }
    if (status && status.release) sel.value = status.release.version;
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
    const result = await api('/api/' + form.dataset.form, data);
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
    if (form.dataset.form === 'cloudflare') form.token.value = '';
    if (form.dataset.form === 'login-provider') form.clientSecret.value = '';
  } catch (e) { err.textContent = e.message; } finally { button.disabled = false; }
});

let running = false;
async function runAll() {
  running = true; render(); const err = $('#s-install [data-error]'); err.textContent = '';
  try {
    for (const step of status.steps) {
      if (step.status === 'done') continue;
      for (let attempt = 0; ; attempt++) {
        const li = $('[data-id="' + CSS.escape(step.id) + '"]'); if (li) li.className = 'running';
        const r = await api('/api/steps/' + encodeURIComponent(step.id), {});
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
$('[data-logout-button]').addEventListener('click', async () => { await api('/api/logout', {}); show(false); });

(async () => { try { await refresh(); show(true); await loadReleases(); } catch { show(false); } })();
</script>
</body>
</html>`;
