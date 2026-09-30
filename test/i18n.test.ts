// The installer in French and English: the page served in the browser's
// language (or ?lang=), and the API's errors, step titles and step details
// in the language the page asks for (Accept-Language). Machine fields stay.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakes, TOKEN, type Fakes } from './fakes';

const PASSWORD = 'test-installer-password';
let fakes: Fakes;
let cookie = '';

beforeEach(async () => {
  for (const key of (await env.INSTALLER_STATE.list()).keys) await env.INSTALLER_STATE.delete(key.name);
  fakes = await installFakes();
  cookie = '';
});

afterEach(() => vi.restoreAllMocks());

async function call(lang: string | null, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`https://installer.test${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(lang ? { 'Accept-Language': lang } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function configure() {
  expect((await call(null, 'POST', '/api/login', { password: PASSWORD })).status).toBe(200);
  expect((await call(null, 'POST', '/api/cloudflare', { token: TOKEN })).status).toBe(200);
  expect((await call(null, 'POST', '/api/login-provider', { issuer: 'https://login.test/', clientId: 'arcanum-client', clientSecret: 'idp-client-secret-value-xyz' })).status).toBe(200);
  expect((await call(null, 'POST', '/api/admins', { emails: 'bert@scouts.test' })).status).toBe(200);
  expect((await call(null, 'POST', '/api/release', { version: '0.1.1' })).status).toBe(200);
}

async function page(url: string, acceptLanguage?: string) {
  const res = await SELF.fetch(url, acceptLanguage ? { headers: { 'Accept-Language': acceptLanguage } } : {});
  return { html: await res.text(), language: res.headers.get('Content-Language') };
}

describe('the setup page', () => {
  it("is served in the browser's language, Dutch by default", async () => {
    const nl = await page('https://installer.test/');
    expect(nl.language).toBe('nl');
    expect(nl.html).toContain('<html lang="nl">');
    expect(nl.html).toContain('Bewaar je herstelcode');
    expect(nl.html).toContain('"notSignedIn":"Niet aangemeld"');

    const fr = await page('https://installer.test/', 'fr-BE,fr;q=0.9,nl;q=0.8');
    expect(fr.language).toBe('fr');
    expect(fr.html).toContain('<html lang="fr">');
    expect(fr.html).toContain('<title>arcanum · installation</title>');
    expect(fr.html).toContain('Conservez votre code de récupération');
    expect(fr.html).toContain('content: "Terminé"');
    // Only this language's texts are in the page.
    expect(fr.html).not.toContain('Bewaar je herstelcode');
    expect(fr.html).not.toContain('Keep your recovery code');
    expect(fr.html).toContain('"notSignedIn":"Non connecté"');
    expect(fr.html).toContain('"dateLocale":"fr-BE"');

    const en = await page('https://installer.test/handoff?code=x', 'en-GB');
    expect(en.html).toContain('<html lang="en">');
    expect(en.html).toContain('Keep your recovery code');
    expect(en.html).toContain('"notSignedIn":"Not signed in"');
  });

  it('follows ?lang= (the picker) over the browser, and marks the current language', async () => {
    const en = await page('https://installer.test/?lang=en', 'fr-BE');
    expect(en.language).toBe('en');
    expect(en.html).toContain('<html lang="en">');
    expect(en.html).toContain('data-lang="en" title="English" aria-current="true">EN</a>');
    expect(en.html).toContain('data-lang="fr" title="Français">FR</a>');
    // The picker's links stay relative (the page is also at /installer/ behind Arcanum).
    expect(en.html).toContain('href="?lang=fr"');
    expect(en.html).toContain("const LOCALE_KEY = 'arcanum-installer-locale';");
  });
});

describe('the API', () => {
  it('words its errors in the language asked for', async () => {
    expect((await call(null, 'POST', '/api/login', { password: 'fout' })).body.error).toBe('Onjuist wachtwoord');
    expect((await call('fr-BE', 'POST', '/api/login', { password: 'fout' })).body.error).toBe('Mot de passe incorrect');
    expect((await call('en-GB', 'POST', '/api/login', { password: 'fout' })).body.error).toBe('Wrong password');
    expect((await call('fr', 'GET', '/api/status')).body.error).toBe('Non connecté');

    await call(null, 'POST', '/api/login', { password: PASSWORD });
    expect((await call('fr', 'POST', '/api/admins', { emails: '' })).body.error).toBe('Indiquez au moins une adresse e-mail (ou *@votredomaine.be)');
    expect((await call('en', 'POST', '/api/admins', { emails: 'geen-adres' })).body.error).toBe('Not a valid address: geen-adres');
    // A login provider's refusal: the provider's own words, inside a translated sentence.
    await call(null, 'POST', '/api/cloudflare', { token: TOKEN });
    const refused = await call('en', 'POST', '/api/login-provider', { issuer: 'https://login.test', clientId: 'bestaat-niet', clientSecret: 'x' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/^The login provider refuses this client for the till \(invalid_client/);
    expect(refused.body.checks[0]).toMatchObject({ name: 'kassa-client', ok: false, blocking: true });
    const noDevice = await call('fr', 'POST', '/api/login-provider', { issuer: 'https://nodevice.test', clientId: 'x', clientSecret: 'y' });
    expect(noDevice.body.error).toMatch(/ne prend pas en charge la connexion par appareil/);
  });

  it('gives step titles and details in the language asked for, ids and statuses unchanged', async () => {
    await configure();
    const nl = (await call(null, 'GET', '/api/status')).body.steps;
    const fr = (await call('fr-BE', 'GET', '/api/status')).body.steps;
    const en = (await call('en-GB', 'GET', '/api/status')).body.steps;
    expect(fr.map((s: any) => [s.id, s.status])).toEqual(nl.map((s: any) => [s.id, s.status]));
    expect(en.map((s: any) => s.id)).toEqual(nl.map((s: any) => s.id));
    const title = (steps: any[], id: string) => steps.find((s) => s.id === id).title;
    expect(title(nl, 'secrets')).toBe('Geheime sleutels aanmaken');
    expect(title(fr, 'secrets')).toBe('Créer les clés secrètes');
    expect(title(en, 'secrets')).toBe('Create secret keys');
    expect(title(fr, 'd1:arcanum-backend')).toBe('Créer la base de données arcanum-backend');
    expect(title(en, 'worker:arcanum-bff')).toBe('Install arcanum-bff');
    expect(title(en, 'verify')).toBe('Check that everything works');

    const step = await call('en', 'POST', '/api/step', { id: 'secrets' });
    expect(step.body).toMatchObject({ id: 'secrets', status: 'done' });
    expect(step.body.detail).toMatch(/^\d+ new, \d+ in total$/);
    const d1 = await call('fr', 'POST', '/api/step', { id: 'd1:arcanum-backend' });
    expect(d1.body).toMatchObject({ status: 'done', detail: 'création effectuée' });
    expect((await call('fr', 'POST', '/api/step', { id: 'nope' })).body.error).toBe('Étape inconnue nope');
  });

  it('translates errors raised deep in the install (a release file) as well', async () => {
    await configure();
    fakes.releases.tampered.add('arcanum-backend.json');
    const fr = await call('fr', 'POST', '/api/step', { id: 'secrets' });
    expect(fr.body).toMatchObject({ status: 'failed', detail: 'arcanum-backend.json ne correspond pas à la somme de contrôle du manifeste — téléchargement interrompu' });
    const en = await call('en', 'POST', '/api/step', { id: 'secrets' });
    expect(en.body.detail).toBe('arcanum-backend.json does not match the checksum in the manifest — download aborted');
    // Dutch stays exactly as it was.
    expect((await call(null, 'POST', '/api/step', { id: 'secrets' })).body.detail).toBe('arcanum-backend.json komt niet overeen met de controlesom in het manifest — download afgebroken');
  });

  it("answers Arcanum's forwarded requests in the browser's language too", async () => {
    // Behind Arcanum the bff passes the page's Accept-Language on as is; a wrong key is refused in it.
    const res = await SELF.fetch('https://installer.test/api/status', { headers: { 'X-Installer-Key': 'wrong', 'Accept-Language': 'en' } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('Invalid key from Arcanum');
  });
});
