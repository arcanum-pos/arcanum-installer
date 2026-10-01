// The setup page: one self-contained HTML document (no build step, no
// external assets), talking to api/*. In Dutch, French or English (i18n.ts):
// served in one language, with only that language's texts in it — the
// NL · FR · EN picker reloads the page with ?lang=. Every
// path is relative: the same page works on the installer's own address
// (at / and /handoff) and behind Arcanum (at /installer/, forwarded by the bff).
// One screen: "Installeren", with the rest (domain, own login provider,
// token, admins, the installer's own address) under "Geavanceerd".
import { MESSAGES, type Locale, type Messages } from './i18n';

// The inline script's texts, as a JS object literal — every "<" escaped, so
// no text can end the <script> early.
const scriptTexts = (texts: Messages['script']) => JSON.stringify(texts).replace(/</g, '\\u003c');

export const page = (locale: Locale) => render(locale, MESSAGES[locale].page, scriptTexts(MESSAGES[locale].script));

const current = (lang: Locale, l: Locale) => (lang === l ? ' aria-current="true"' : '');

// test/check-page-script.mjs evaluates this template itself, with (lang, p,
// texts, current) — keep it the last thing in this file.
const render = (lang: Locale, p: Messages['page'], texts: string) => /* html */ `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${p.title}</title>
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
  /* The language picker: NL · FR · EN, top right. */
  .langs { justify-self: end; display: flex; gap: 6px; font-size: 12px; margin-top: -16px; color: var(--muted-foreground); }
  .langs a { color: var(--muted-foreground); text-decoration: none; }
  .langs a:hover { color: var(--foreground); }
  .langs a[aria-current] { color: var(--foreground); font-weight: 600; }
  .soft { color: var(--muted-foreground); }
  p { margin: 4px 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: var(--muted); border-radius: calc(var(--radius) * 0.6); padding: 1px 6px; word-break: break-all; }
  /* Card — rounded-xl, ring-1 ring-foreground/10, 16px spacing. */
  .card { background: var(--card); border-radius: calc(var(--radius) * 1.4); box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 10%, transparent); padding: 16px; display: grid; gap: 8px; }
  .card h2 { font-size: 1rem; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
  .done > h2::after { content: "${p.done}"; font-size: 0.75rem; font-weight: 500; color: var(--success); border: 1px solid color-mix(in oklch, var(--success) 40%, transparent); border-radius: 999px; padding: 0 8px; line-height: 1.4rem; }
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
  /* The install's steps, one by one: there when wanted, folded away by default. */
  details[data-steps-box] > summary { cursor: pointer; }
  details[data-steps-box][open] > summary { margin-bottom: 8px; }
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
  ul.people { margin: 2px 0 0; padding-left: 1.2em; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <nav class="langs" aria-label="${p.language}"><a href="?lang=nl" hreflang="nl" lang="nl" data-lang="nl" title="Nederlands"${current(lang, 'nl')}>NL</a><span aria-hidden="true">·</span><a href="?lang=fr" hreflang="fr" lang="fr" data-lang="fr" title="Français"${current(lang, 'fr')}>FR</a><span aria-hidden="true">·</span><a href="?lang=en" hreflang="en" lang="en" data-lang="en" title="English"${current(lang, 'en')}>EN</a></nav>
    <div class="brand"><img src="assets/kabouter.png" alt=""><span>arcanum</span></div>
    <h1>${p.heading}</h1>
    <p class="soft">${p.intro}</p>
  </header>

  <section id="login" class="card hidden">
    <h2>${p.signIn}</h2>
    <p class="error" data-login-error></p>
    <div data-login-account class="hidden">
      <p class="soft">${p.signInAccountHint}</p>
      <a class="button" href="auth/login">${p.signInWithAccount}</a>
    </div>
    <p data-login-handoff class="soft hidden">${p.awaitingHandoff}</p>
    <form data-form="login" class="hidden">
      <p class="soft" data-login-hint></p>
      <label for="recoveryCode" data-login-label></label><input id="recoveryCode" name="recoveryCode" type="password" autocomplete="off" required><button class="secondary">${p.signIn}</button><p class="error" data-error></p>
    </form>
  </section>

  <section id="recovery" class="card hidden">
    <h2>${p.recoveryTitle}</h2>
    <p>${p.recoveryIntro}</p>
    <p class="recovery-code" data-recovery-code></p>
    <p class="soft">${p.recoveryOnce}</p>
    <p class="soft">${p.recoveryRollback}</p>
    <label class="check"><input type="checkbox" data-recovery-saved> ${p.recoverySaved}</label>
    <button data-recovery-continue disabled>${p.continue}</button>
  </section>

  <section id="moving" class="card hidden">
    <p class="soft" style="margin:0;text-align:center">${p.publicMoving}</p>
  </section>

  <section id="denied" class="card hidden">
    <h2>${p.deniedTitle}</h2>
    <p data-denied></p>
    <p class="soft">${p.deniedHint}</p>
  </section>

  <div id="app" class="hidden" style="display:grid;gap:16px">
    <p data-access class="soft hidden" style="text-align:center;margin:0"></p>
    <section id="s-cloudflare" class="card">
      <h2>${p.cloudflareTitle}</h2>
      <p>${p.cloudflareIntro}</p>
      <p data-summary class="soft"></p>
      <form data-form="cloudflare">
        <label for="token">${p.token}</label><input id="token" name="token" type="password" autocomplete="off" required>
        <div data-accounts class="hidden"><label for="accountId">${p.account}</label><select id="accountId" name="accountId"></select></div>
        <div data-subdomain class="hidden"><label for="subdomain">${p.subdomain}</label><input id="subdomain" name="subdomain" type="text" autocomplete="off"><p class="soft">${p.subdomainHint}</p></div>
        <label class="check"><input type="checkbox" name="remember" checked> ${p.rememberToken}</label>
        <button>${p.checkAndSave}</button><p class="error" data-error></p>
      </form>
    </section>

    <section id="s-address" class="card">
      <h2>${p.addressTitle}</h2>
      <p class="soft">${p.addressIntro}</p>
      <p data-summary class="soft"></p>
      <form data-form="address"><label for="customDomain">${p.customDomain}</label><input id="customDomain" name="customDomain" type="text" placeholder="${p.customDomainPlaceholder}" autocomplete="off"><button>${p.save}</button><p class="error" data-error></p></form>
    </section>

    <section id="s-login" class="card">
      <h2>${p.loginTitle}</h2>
      <p data-login-default class="soft">${p.loginDefault}</p>
      <p>${p.loginIntro}</p>
      <p>${p.loginUrls}</p>
      <p data-summary class="soft"></p>
      <p data-login-installed class="soft hidden">${p.loginInstalled}</p>
      <form data-form="login-provider">
        <label for="issuer">${p.issuer}</label><input id="issuer" name="issuer" type="url" placeholder="https://accounts.google.com" required>
        <label for="clientId">${p.clientId}</label><input id="clientId" name="clientId" type="text" required>
        <label for="clientSecret">${p.clientSecret}</label><input id="clientSecret" name="clientSecret" type="password" autocomplete="off">
        <p data-google class="soft hidden">${p.googleHint}</p>
        <label for="scopes">${p.scopes}</label><input id="scopes" name="scopes" type="text" placeholder="openid profile email offline_access">
        <label for="authCodeClientId">${p.browserClient}</label><input id="authCodeClientId" name="authCodeClientId" type="text" placeholder="${p.clientId}">
        <input id="authCodeClientSecret" name="authCodeClientSecret" type="password" autocomplete="off" placeholder="${p.clientSecret}">
        <label for="connectionName">${p.connection}</label><input id="connectionName" name="connectionName" type="text">
        <button>${p.checkAndSave}</button><p class="error" data-error></p>
        <ul class="checks" data-checks></ul>
      </form>
    </section>

    <section id="s-admins" class="card">
      <h2>${p.adminsTitle}</h2>
      <p class="soft">${p.adminsIntro}</p>
      <p data-summary class="soft"></p>
      <form data-form="admins"><label for="emails">${p.emails}</label><input id="emails" name="emails" type="text" placeholder="${p.emailsPlaceholder}" required><button>${p.save}</button><p class="error" data-error></p></form>
    </section>

    <section id="s-install" class="card">
      <h2>${p.installTitle}</h2>
      <p data-quick>${p.quick}</p>
      <div data-quick-version style="display:grid;gap:6px"><label for="quick-version">${p.version}</label><select id="quick-version"></select></div>
      <div class="row"><button data-run>${p.install}</button></div>
      <p class="soft hidden" data-progress></p>
      <p class="error" data-error></p>
      <details data-steps-box>
        <summary class="soft">${p.stepsDetails}</summary>
        <p class="soft">${p.rerun}</p>
        <p class="soft hidden" data-self-note>${p.selfNote}</p>
        <ol class="steps" data-steps></ol>
      </details>
    </section>

    <section id="s-change" class="card hidden">
      <h2>${p.changeTitle}</h2>
      <p class="soft" data-change-notice></p>
      <div data-change-staged class="hidden" style="display:grid;gap:8px">
        <p>${p.changeStaged}</p>
        <p>${p.changeCallbacks}</p>
        <ul class="people" data-change-callbacks></ul>
        <p>${p.changeTest}</p>
        <p data-change-test-result class="soft">${p.notTested}</p>
        <p><a class="button" href="auth/test-login" data-change-test>${p.testButton}</a></p>
        <p class="soft hidden" data-change-own>${p.changeOwnAddress}</p>
        <p>${p.changeApply}</p>
        <p data-change-tester></p>
        <div data-change-resign></div>
        <p class="error" data-change-problem></p>
        <div class="row"><button data-change-apply disabled>${p.apply}</button><button class="secondary" data-change-cancel>${p.cancel}</button></div>
      </div>
      <div data-change-applied class="hidden" style="display:grid;gap:8px">
        <p data-change-applied-summary></p>
        <p data-change-applied-tester></p>
        <div data-change-applied-resign></div>
        <p class="soft">${p.changeAppliedHint}</p>
        <div class="row"><button data-change-finish class="hidden">${p.finish}</button><button class="secondary" data-change-undo>${p.undo}</button></div>
      </div>
      <p class="error" data-error></p>
    </section>

    <details id="advanced" class="card">
      <summary>${p.advanced}</summary>
      <p class="soft">${p.advancedIntro}</p>
      <div data-advanced></div>
    </details>

    <section id="s-done" class="card hidden">
      <h2>${p.done}</h2>
      <p><a class="button big" data-open target="_blank" rel="noopener">${p.openArcanum}</a></p>
      <p>${p.runsAt}</p>
      <p data-live class="soft">${p.checkingLive}</p>
      <p>${p.doneNext}</p>
    </section>

    <section id="s-public" class="card hidden">
      <h2>${p.publicTitle}</h2>
      <p class="soft">${p.publicIntro}</p>
      <p data-public-state></p>
      <div class="row">
        <button data-public-open class="secondary hidden">${p.publicOpen}</button>
        <button data-public-close class="hidden">${p.publicClose}</button>
      </div>
      <p class="error" data-error></p>
    </section>

    <p class="row"><button class="secondary" data-logout-button>${p.signOut}</button></p>
  </div>
</main>
<footer>
  <img src="assets/kabouter.png" alt="">
  <a href="https://kaboutersoft.be" target="_blank" rel="noopener noreferrer">${p.servedBy}</a>
  <span aria-hidden="true">·</span>
  <a href="https://github.com/arcanum-pos/arcanum-installer" target="_blank" rel="noopener noreferrer" title="${p.freeSoftware}">${p.sourceCode}</a>
  <span aria-hidden="true">·</span>
  <span data-installer-version title="${p.installerVersion}"></span>
</footer>
<script>
const $ = (s, el = document) => el.querySelector(s);
let status = null;
// This page's texts, in the language it was served in (i18n.ts); {name} placeholders.
const M = ${texts};
const LANG = document.documentElement.lang;
const fmt = (text, values) => text.replace(/[{]([a-zA-Z]+)[}]/g, (_, name) => String(values[name]));

// The language: ?lang= or the browser's (the server's choice), unless one was
// picked before in this browser (NL · FR · EN) — then back with that one.
const LOCALE_KEY = 'arcanum-installer-locale';
const pageParams = new URLSearchParams(location.search);
let picked = null; try { picked = localStorage.getItem(LOCALE_KEY); } catch {}
const switching = !pageParams.has('lang') && ['nl', 'fr', 'en'].includes(picked) && picked !== LANG;
if (switching) { pageParams.set('lang', picked); location.replace('?' + pageParams.toString()); }
for (const a of document.querySelectorAll('[data-lang]')) a.addEventListener('click', () => { try { localStorage.setItem(LOCALE_KEY, a.dataset.lang); } catch {} });
// Kept in the address when the page tidies it up.
const keepLang = pageParams.has('lang') ? '?lang=' + encodeURIComponent(pageParams.get('lang')) : '';

async function api(path, body) {
  // The API answers in this page's language.
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin', headers: { 'Accept-Language': LANG } } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Accept-Language': LANG }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'api/login') { show(false); throw new Error(M.notSignedIn); }
  if (res.status === 403 && data.forbidden) { denied(data.error); throw new Error(data.error); }
  if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { data });
  return data;
}

function denied(message) { $('#denied').classList.remove('hidden'); $('[data-denied]').textContent = message; $('#login').classList.add('hidden'); $('#app').classList.add('hidden'); }
function show(loggedIn) { $('#login').classList.toggle('hidden', loggedIn); $('#app').classList.toggle('hidden', !loggedIn); $('#recovery').classList.add('hidden'); if (!loggedIn) loadLoginOptions(); }

// The ways in: the admin's account, and the recovery code.
async function loadLoginOptions() {
  let o = null; try { o = await (await fetch('api/login-options', { credentials: 'same-origin', headers: { 'Accept-Language': LANG } })).json(); } catch { return; }
  $('[data-login-account]').classList.toggle('hidden', !o.account);
  if (o.account) $('[data-login-issuer]').textContent = new URL(o.account.issuer).host;
  $('[data-login-handoff]').classList.toggle('hidden', !o.awaitingHandoff);
  $('form[data-form="login"]').classList.toggle('hidden', !o.recoveryCode);
  $('[data-login-label]').textContent = M.recoveryCode;
  $('[data-login-hint]').textContent = M.recoveryCodeHint;
}

// Why signing in with an account didn't work (oidc.ts sends ?fout=).
const SIGN_IN_ERRORS = {
  'niet-bevestigd': M.signInNotVerified,
  'aanmelden-verlopen': M.signInExpired,
  'aanmelden-geweigerd': M.signInRefused,
  'aanmelden-mislukt': M.signInFailedRetry,
  'provider-onbereikbaar': M.signInProviderDown,
  'geen-account-aanmelding': M.signInNoAccount,
};
function signInError(params) {
  const reason = params.get('fout'); if (!reason) return '';
  return reason === 'geen-beheerder' ? fmt(M.signInNotAdmin, { email: params.get('email') || M.thisAccount }) : (SIGN_IN_ERRORS[reason] || M.signInFailed);
}

function showRecovery(r) {
  $('#login').classList.add('hidden'); $('#app').classList.add('hidden'); $('#recovery').classList.remove('hidden');
  $('[data-recovery-email]').textContent = r.email; $('[data-recovery-code]').textContent = r.recoveryCode;
}
$('[data-recovery-saved]').addEventListener('change', (ev) => { $('[data-recovery-continue]').disabled = !ev.target.checked; });
$('[data-recovery-continue]').addEventListener('click', async () => { $('[data-recovery-code]').textContent = ''; await refresh(); show(true); await loadReleases(); });

// One screen: the detailed cards under "Geavanceerd" (a new title, or their own).
const ADVANCED = { 's-address': M.advancedAddress, 's-login': M.advancedLogin, 's-cloudflare': M.advancedCloudflare, 's-admins': M.advancedAdmins, 's-public': null };
for (const [id, title] of Object.entries(ADVANCED)) { const el = $('#' + id); if (title) $('h2', el).textContent = title; $('[data-advanced]').append(el); }
$('#s-install h2').textContent = M.install;
$('[data-run]').classList.add('big');

function render() {
  const s = status;
  // Which release this installer itself came from (INSTALLER_RELEASE): after
  // an update it shows the new one — the proof it updated itself.
  $('[data-installer-version]').textContent = fmt(M.installerRelease, { release: s.installer && s.installer.release ? s.installer.release : M.noReleaseNumber });
  $('#token-link').href = s.tokenTemplateUrl;
  const set = (id, done, summary) => { const el = $(id); el.classList.toggle('done', !!done); $('[data-summary]', el) && ($('[data-summary]', el).textContent = summary || ''); };
  set('#s-cloudflare', s.cloudflare && s.cloudflare.tokenAvailable, s.cloudflare ? fmt(M.cloudflareSummary, { account: s.cloudflare.accountName, url: s.address ? s.address.publicUrl : '' }) + (s.cloudflare.tokenAvailable ? '' : M.tokenNeeded) : '');
  $('[data-workersdev]').textContent = s.address ? s.address.workersDevUrl : M.stepOneFirst;
  set('#s-address', false, s.address && s.address.customDomain ? fmt(M.addressSummary, { url: s.address.publicUrl }) : '');
  if (s.address && s.address.customDomain) $('#customDomain').value ||= s.address.customDomain;
  $('[data-callback]').textContent = s.address ? s.address.callbackUrl : M.stepOneFirst;
  $('[data-logout]').textContent = s.address ? s.address.logoutUrl : M.stepOneFirst;
  set('#s-login', s.login, s.login ? fmt(M.loginSummary, { issuer: s.login.issuer, client: s.login.clientId }) : '');
  if (s.login) $('[data-login-current]').textContent = new URL(s.login.issuer).host;
  $('[data-quick-url]').textContent = s.address ? s.address.publicUrl : '';
  $('[data-quick-account]').textContent = s.cloudflare ? s.cloudflare.accountName : '';
  $('[data-quick-admins]').textContent = s.admins || '';
  if (s.login) {
    $('#issuer').value ||= s.login.issuer; $('#clientId').value ||= s.login.clientId; $('#clientSecret').placeholder = M.secretKept;
    $('#scopes').value ||= s.login.scopes || ''; $('#authCodeClientId').value ||= s.login.authCodeClientId || '';
    if (s.login.authCodeClientSecretSet) $('#authCodeClientSecret').placeholder = M.secretKept;
  }
  googleHint();
  set('#s-admins', s.admins, s.admins ? s.admins : '');
  if (s.admins) $('#emails').value ||= s.admins;
  const list = $('[data-steps]'); list.innerHTML = '';
  for (const step of s.steps) {
    const li = document.createElement('li'); li.className = step.status; li.dataset.id = step.id;
    li.innerHTML = '<span class="icon"></span><span><span class="title"></span> <span class="detail"></span></span>';
    $('.title', li).textContent = step.title; $('.detail', li).textContent = step.detail ? '— ' + step.detail : '';
    list.append(li);
  }
  // The version is chosen right here, when Installeren is clicked.
  const ready = s.cloudflare && s.login && s.admins;
  $('[data-run]').disabled = !ready || running;
  const chosen = $('#quick-version').value;
  const updating = s.installed && chosen && s.installed.version !== chosen;
  const sameRelease = s.release && chosen === s.release.version;
  $('[data-run]').textContent = updating ? fmt(M.updateTo, { version: chosen }) : sameRelease && s.steps.some(x => x.status === 'done') && !s.installed ? M.continueInstall : M.install;
  const selfStep = s.steps.some(x => x.id === 'installer:self');
  $('[data-self-note]').classList.toggle('hidden', !selfStep);
  set('#s-install', s.installed, '');
  $('#s-done').classList.toggle('hidden', !s.installed);
  if (s.installed) { $('[data-url]').href = s.address.publicUrl; $('[data-url]').textContent = s.address.publicUrl; openLink(); probe(); }
  const viaArcanum = s.access && s.access.via === 'arcanum';
  $('[data-access]').classList.toggle('hidden', !(s.access && s.access.email));
  if (s.access && s.access.email) $('[data-access]').textContent = fmt(viaArcanum ? M.signedInViaArcanum : M.signedInAs, { email: s.access.email });
  $('[data-logout-button]').classList.toggle('hidden', !!viaArcanum);
  $('#s-public').classList.toggle('hidden', !s.installed);
  if (s.installed) loadPublicAccess();
  $('[data-login-installed]').classList.toggle('hidden', !s.installed);
  const changing = !!(s.installed && s.loginChange && (s.loginChange.staged || s.loginChange.applied));
  $('#s-change').classList.toggle('hidden', !changing);
  if (changing) loadChange();
}

// "Aanmelding wijzigen": stage → test sign-in → apply, undo for 7 days (login-change.ts).
const TEST_OUTCOMES = {
  'ok': M.testOk,
  'niet-bevestigd': M.testNotVerified,
  'geen-sessie': M.testNoSession,
  'niets-klaargezet': M.testNothingStaged,
  'provider-onbereikbaar': M.testProviderDown,
  'verlopen': M.testExpired,
  'geweigerd': M.testRefused,
  'mislukt': M.testFailedCallback,
  'geen-email': M.testNoEmail,
  'geen-beheerder': M.testNotAdmin,
};
let testOutcome = '';
const fmtDate = (iso) => new Date(iso).toLocaleString(M.dateLocale, { dateStyle: 'medium', timeStyle: 'short' });
function peopleList(el, title, people) {
  el.innerHTML = '';
  if (!people || !people.length) return;
  const p = document.createElement('p'); p.textContent = fmt(M.people, { title, count: people.length }); el.append(p);
  const ul = document.createElement('ul'); ul.className = 'people';
  for (const x of people) { const li = document.createElement('li'); li.textContent = x.email + ' — ' + x.org + ' (' + x.role + ')'; ul.append(li); }
  el.append(ul);
}
const orgsOf = (people) => people.map((x) => x.org + ' (' + x.role + ')').join(', ');
let changeLoading = false;
async function loadChange() {
  if (changeLoading) return; changeLoading = true;
  const err = $('#s-change > [data-error]');
  try { renderChange(await api('api/login-change')); } catch (e) { err.textContent = e.message; } finally { changeLoading = false; }
}
function renderChange(c) {
  const box = $('#s-change');
  $('[data-change-notice]').textContent = testOutcome;
  $('[data-change-staged]').classList.toggle('hidden', !c.staged);
  $('[data-change-applied]').classList.toggle('hidden', !c.applied);
  if (c.staged) {
    $('[data-change-to]').textContent = c.staged.issuer; $('[data-change-client]').textContent = c.staged.clientId;
    $('[data-change-from]').textContent = c.current ? c.current.issuer : '—'; $('[data-change-browser-client]').textContent = c.staged.browserClientId;
    const ul = $('[data-change-callbacks]'); ul.innerHTML = '';
    for (const u of c.callbackUrls) { const li = document.createElement('li'); const code = document.createElement('code'); code.textContent = u; li.append(code); ul.append(li); }
    const t = c.test;
    $('[data-change-test-result]').textContent = t
      ? fmt(M.tested, { email: t.email, sub: t.sub, verified: t.emailVerified ? M.yes : M.no }) + (t.thisSession ? '' : M.otherSession)
      : M.notTested;
    const viaArcanum = status && status.access && status.access.via === 'arcanum';
    $('[data-change-test]').classList.toggle('hidden', !!viaArcanum);
    $('[data-change-own]').classList.toggle('hidden', !viaArcanum);
    const own = new URL(c.callbackUrls[0]).origin; $('[data-change-own-link]').href = own + '/'; $('[data-change-own-link]').textContent = own;
    const p = c.preview;
    $('[data-change-tester]').textContent = p && p.tester.length ? fmt(M.boundNow, { who: t ? ' (' + t.email + ')' : '', orgs: orgsOf(p.tester) }) : '';
    peopleList($('[data-change-resign]'), M.mustSignInAgain, p ? p.resign : []);
    $('[data-change-problem]').textContent = c.previewError || (p && p.problem) || '';
    $('[data-change-apply]').disabled = !(t && t.emailVerified && t.thisSession && p && !p.problem && p.tester.length);
  }
  if (c.applied) {
    const a = c.applied;
    $('[data-change-applied-summary]').textContent = a.phase === 'done'
      ? fmt(M.changeDone, { at: fmtDate(a.at), from: a.from.issuer, to: a.to.issuer, until: fmtDate(a.undoUntil) })
      : fmt(M.changeHalfway, { to: a.to.issuer });
    $('[data-change-applied-tester]').textContent = fmt(M.boundTo, { email: a.tester.email, sub: a.tester.sub, orgs: orgsOf(a.tester.orgs) });
    peopleList($('[data-change-applied-resign]'), M.mustSignInAgain, a.resign);
    $('[data-change-finish]').classList.toggle('hidden', a.phase === 'done');
  }
  box.classList.toggle('done', !!(c.applied && c.applied.phase === 'done' && !c.staged));
}
async function changeAction(path, question) {
  const err = $('#s-change > [data-error]'); err.textContent = '';
  if (question && !confirm(question)) return;
  for (const b of document.querySelectorAll('#s-change button')) b.disabled = true;
  try { renderChange(await api(path, {})); testOutcome = ''; await refresh(); }
  catch (e) { err.textContent = e.message; if (e.data && e.data.info) renderChange(e.data.info); }
  finally { for (const b of document.querySelectorAll('#s-change button')) b.disabled = false; loadChange(); }
}
$('[data-change-apply]').addEventListener('click', () => changeAction('api/login-change/apply', M.confirmApply));
$('[data-change-finish]').addEventListener('click', () => changeAction('api/login-change/apply'));
$('[data-change-undo]').addEventListener('click', () => changeAction('api/login-change/undo', M.confirmUndo));
$('[data-change-cancel]').addEventListener('click', () => changeAction('api/login-change/cancel'));

// The installer's own address. Linked to Arcanum when the bff is deployed;
// its own address goes off with the first visit through Arcanum — which is
// where "Open je Arcanum" passes by (?naar=console), on its way to the
// console. Geavanceerd can switch it back on, and off again (through Arcanum).
let publicAccess = null;
let publicLoading = false;
const viaArcanum = () => !!(status && status.access && status.access.via === 'arcanum');
// To be closed, and this is the visit that can do it.
const closeNow = (p) => p && p.linked && p.shouldClose && p.directEnabled === true && p.via === 'arcanum';
async function loadPublicAccess() {
  if (publicLoading) return; publicLoading = true;
  const box = $('#s-public'); const err = $('[data-error]', box);
  try {
    let p = await api('api/public-access');
    // Opened through Arcanum: its own address goes off now (nothing to click).
    if (closeNow(p)) { status = await api('api/public-access/close', {}); p = await api('api/public-access'); }
    publicAccess = p;
    $('[data-installer-url]').textContent = p.installerUrl;
    const why = p.loginChange ? M.publicLoginChange : p.keptOpen ? M.publicKeptOpen : M.publicWillClose;
    $('[data-public-state]').textContent = !p.linked ? M.publicNotLinked
      : p.directEnabled === null ? M.publicUnknown
      : p.directEnabled === false ? fmt(M.publicClosed, { url: p.directUrl })
      : fmt(M.publicIsOpen, { url: p.directUrl }) + why + (p.via !== 'arcanum' && !p.loginChange ? fmt(M.publicThroughArcanum, { url: p.installerUrl }) : '');
    $('[data-public-open]').classList.toggle('hidden', !(p.linked && p.directEnabled === false));
    $('[data-public-close]').classList.toggle('hidden', !(p.linked && p.directEnabled === true && p.via === 'arcanum' && !p.loginChange));
    box.classList.toggle('done', p.linked && p.directEnabled === false);
    openLink();
  } catch (e) { err.textContent = e.message; } finally { publicLoading = false; }
}
async function publicAction(path) {
  const err = $('#s-public [data-error]'); err.textContent = '';
  try { status = await api(path, {}); render(); } catch (e) { err.textContent = e.message; }
}
$('[data-public-open]').addEventListener('click', () => publicAction('api/public-access/open'));
$('[data-public-close]').addEventListener('click', () => publicAction('api/public-access/close'));

// "Open je Arcanum": the console — on the installer's own address, while
// that's still to be closed, by way of the installer behind Arcanum (sign
// in, close, on to the console), in this tab: this page stops working here.
function openLink() {
  const a = $('[data-open]'); const url = status && status.address ? status.address.publicUrl : '';
  const p = publicAccess;
  const passBy = !viaArcanum() && p && p.linked && p.shouldClose && p.directEnabled !== false;
  a.href = passBy ? url + '/login?returnTo=' + encodeURIComponent('/installer/?naar=console') : url + '/console';
  if (passBy) a.removeAttribute('target'); else a.target = '_blank';
}

// Arrived from "Open je Arcanum" (through Arcanum): close the own address,
// then on to the console — whatever happens, the console is where this goes.
async function moveAndOpenConsole() {
  $('#moving').classList.remove('hidden');
  try {
    status = await api('api/status');
    const p = await api('api/public-access');
    if (closeNow(p)) await api('api/public-access/close', {});
  } catch {}
  location.replace(new URL('../console', location.href).toString());
}

// Live check from the browser: load one real asset of the installation
// (bff → frontends). The installer itself can't fetch its own account's
// workers.dev addresses (Cloudflare blocks Worker-to-Worker fetches there).
let probing = false;
function probe(attempt = 0) {
  if (probing || !status.probeUrl) return; probing = true;
  const img = new Image();
  img.onload = () => { probing = false; $('[data-live]').textContent = M.liveOk; };
  img.onerror = () => {
    probing = false;
    if (attempt >= 24) { $('[data-live]').textContent = M.liveNotYet; return; }
    $('[data-live]').textContent = M.liveWaiting;
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
    fillVersions($('#quick-version'), await api('api/releases'));
    if (status) render();
  } catch (e) { $('#s-install [data-error]').textContent = e.message; }
}

// The one-screen version choice: the newest release (or the newest above the installed one).
function fillVersions(sel, r) {
  const keep = sel.value; sel.innerHTML = '';
  for (const rel of r.releases) {
    if (r.installed && newerThan(r.installed, rel.version)) continue;
    const o = document.createElement('option'); o.value = rel.version;
    o.textContent = fmt(M.arcanumVersion, { version: rel.version }) + (rel.prerelease ? M.prerelease : '') + (rel.version === r.installed ? M.releaseInstalled : ''); sel.append(o);
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
  // Installed: another provider or client is staged first (Aanmelding wijzigen), never switched directly.
  const staging = form.dataset.form === 'login-provider' && status && status.installed && status.login && (
    data.issuer.trim().replace(/[/]+$/, '') !== status.login.issuer || data.clientId.trim() !== status.login.clientId || (data.authCodeClientId.trim() || null) !== status.login.authCodeClientId);
  try {
    if (staging) {
      const staged = await api('api/login-change/stage', data);
      form.clientSecret.value = ''; form.authCodeClientSecret.value = '';
      showChecks(staged.checks || []); testOutcome = ''; await refresh(); renderChange(staged);
      $('#s-change').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const result = await api('api/' + form.dataset.form, data);
    if (form.dataset.form === 'login') { show(true); await refresh(); await loadReleases(); return; }
    if (result.needsSubdomain) {
      const box = $('[data-subdomain]', form); box.classList.remove('hidden');
      if (!form.subdomain.value) form.subdomain.value = result.suggestion;
      $('[data-subdomain-preview]').textContent = form.subdomain.value;
      form.subdomain.oninput = () => { $('[data-subdomain-preview]').textContent = form.subdomain.value || '…'; };
      err.textContent = M.chooseSubdomain; return;
    }
    if (result.needsAccount) {
      const sel = $('#accountId'); sel.innerHTML = ''; for (const a of result.accounts) { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; sel.append(o); }
      $('[data-accounts]', form).classList.remove('hidden'); err.textContent = M.chooseAccount; return;
    }
    status = result; render();
    if (result.checks) showChecks(result.checks);
    if (form.dataset.form === 'cloudflare') form.token.value = '';
    if (form.dataset.form === 'login-provider') { form.clientSecret.value = ''; form.authCodeClientSecret.value = ''; }
  } catch (e) { err.textContent = e.message; if (e.data && e.data.checks) showChecks(e.data.checks); } finally { button.disabled = false; }
});

// While installing: which step it's on (the steps themselves are folded away).
function progress(text) { const el = $('[data-progress]'); el.textContent = text; el.classList.toggle('hidden', !text); }

let running = false;
async function runAll() {
  running = true; render(); const err = $('#s-install [data-error]'); err.textContent = '';
  try {
    // The version picked right here first (a fresh install, or an update).
    const version = $('#quick-version').value;
    if (!version) throw new Error(M.noVersion);
    if (!status.release || status.release.version !== version) { status = await api('api/release', { version }); render(); }
    const total = status.steps.length;
    for (const [i, step] of status.steps.entries()) {
      if (step.status === 'done') continue;
      const at = fmt(M.progress, { n: i + 1, total, title: step.title });
      progress(at);
      for (let attempt = 0; ; attempt++) {
        const li = $('[data-id="' + CSS.escape(step.id) + '"]'); if (li) li.className = 'running';
        const r = await api('api/step', { id: step.id });
        if (r.status === 'done') break;
        if (r.status === 'retry' && attempt < 20) { progress(at + ' — ' + r.detail + M.retryIn); if (li) { li.className = 'retry'; $('.detail', li).textContent = '— ' + r.detail + M.retryIn; } await new Promise(res => setTimeout(res, 6000)); continue; }
        await refresh(); throw new Error(fmt(M.stepFailed, { title: step.title, detail: r.detail }));
      }
      // The new installer takes over from the next request: give Cloudflare a moment.
      if (step.id === 'installer:self') await new Promise(res => setTimeout(res, 3000));
      await refresh();
    }
  } catch (e) { err.textContent = e.message; if (e.data && e.data.needsToken) $('#token').focus(); }
  finally { running = false; progress(''); await refresh().catch(() => {}); }
}
$('[data-run]').addEventListener('click', runAll);
$('[data-logout-button]').addEventListener('click', async () => { await api('api/logout', {}); show(false); });

(async () => {
  if (switching) return; // reloading in the picked language
  const params = new URLSearchParams(location.search);
  // The bootstrapper's link: hand the code over once, then show the recovery code.
  if (location.pathname.endsWith('/handoff')) {
    const code = params.get('code') || '';
    history.replaceState(null, '', './' + keepLang);
    try { showRecovery(await api('api/handoff', { code })); } catch (e) { show(false); $('[data-login-error]').textContent = e.message; }
    return;
  }
  if (params.get('naar') === 'console') return moveAndOpenConsole();
  const failure = signInError(params);
  const tested = params.get('aanmeldtest');
  if (tested) testOutcome = TEST_OUTCOMES[tested] || M.testFailed;
  if (failure || tested) history.replaceState(null, '', location.pathname + keepLang);
  try { await refresh(); show(true); await loadReleases(); } catch { show(false); $('[data-login-error]').textContent = failure; }
})();
</script>
</body>
</html>`;
