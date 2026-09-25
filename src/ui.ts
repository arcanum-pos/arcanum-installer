// The setup page: one self-contained HTML document (no build step, no
// external assets), talking to /api/*. Dutch, like the rest of Arcanum.
export const PAGE = /* html */ `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Arcanum installeren</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#15181e; --soft:#5b6472; --line:#dde1e7; --accent:#1f6f78; --ok:#1d7a4f; --bad:#b3261e; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f26; --ink:#e8ecf1; --soft:#9aa5b3; --line:#2c343f; --accent:#5fc4cd; --ok:#5fce9c; --bad:#ff8a80; --warn:#e6b567; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding:24px 16px 64px; }
  main { max-width: 720px; margin: 0 auto; display: grid; gap: 16px; }
  h1 { font-size: 1.6rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 0 0 8px; display:flex; gap:8px; align-items:center; }
  p { margin: 6px 0; } .soft { color: var(--soft); } code { background: var(--bg); border:1px solid var(--line); border-radius:4px; padding:1px 5px; word-break: break-all; }
  .card { background: var(--card); border:1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .done h2::after { content:"✓"; color: var(--ok); } .locked { opacity:.75; }
  label { display:block; font-weight:600; margin: 10px 0 4px; } input[type=text], input[type=password], input[type=url], select, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); font:inherit; }
  button { margin-top: 12px; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); } button:disabled { opacity:.5; cursor: default; }
  .error { color: var(--bad); font-weight: 600; } .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  ol.steps { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 4px; }
  ol.steps li { display:flex; gap:10px; align-items:baseline; } ol.steps .icon { width: 1.2em; text-align:center; flex:none; }
  .todo .icon::before{content:"○";color:var(--soft)} .running .icon::before{content:"◌";color:var(--accent)} .done .icon::before{content:"●";color:var(--ok)} .failed .icon::before{content:"✕";color:var(--bad)} .retry .icon::before{content:"◌";color:var(--warn)}
  ol.steps .detail { color: var(--soft); font-size: .9em; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<main>
  <header><h1>Arcanum installeren</h1><p class="soft">Installeert Arcanum op je eigen Cloudflare-account. Je gegevens blijven daar.</p></header>

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
        <label class="row" style="font-weight:normal"><input type="checkbox" name="remember" checked> Token onthouden voor latere updates (veilig versleuteld, nooit opnieuw zichtbaar)</label>
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
      <p>Meld je daar aan met een beheerdersadres en maak je organisatie aan — of importeer ze via <em>Instellingen → Gegevens</em> uit een export van je vorige installatie.</p>
    </section>

    <p class="row"><button class="secondary" data-logout-button>Afmelden</button></p>
  </div>
</main>
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
  if (s.installed) { $('[data-url]').href = s.address.publicUrl; $('[data-url]').textContent = s.address.publicUrl; }
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
