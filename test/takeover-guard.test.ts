import { describe, expect, it } from 'vitest';
import { buildPageScript } from '../src/api/pageRunner';
import { AUTH_MARKER, authGuardScript, isChromium } from '../src/takeover';

describe('isChromium', () => {
  it('detects Chrome and Edge but not Firefox', () => {
    expect(isChromium('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe(true);
    expect(isChromium('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0')).toBe(true);
    expect(isChromium('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0')).toBe(false);
  });
});

describe('auth2 guard', () => {
  it("lets the booru's own refresh through: the page runner sends the guard's marker", () => {
    expect(buildPageScript('evt', 'body')).toContain(`'Kinde-SDK':'${AUTH_MARKER}'`);
  });

  it('rejects other auth2 fetches and XHRs, passes everything else', async () => {
    const calls: string[] = [];
    const fakeWindow: { fetch: (url: string, init?: unknown) => Promise<unknown> } = {
      fetch: (url) => { calls.push(url); return Promise.resolve('ok'); },
    };
    class FakeXhr { open(_m: string, u: string) { calls.push(`xhr ${u}`); } }
    // Run the guard against fakes instead of the real page.
    new Function('window', 'XMLHttpRequest', authGuardScript())(fakeWindow, FakeXhr);

    await expect(fakeWindow.fetch('https://auth2.redgifs.com/oauth2/token', { headers: { 'Kinde-SDK': 'JavaScript/2.0.0' } })).rejects.toThrow('Blocked');
    await expect(fakeWindow.fetch('https://auth2.redgifs.com/oauth2/token')).rejects.toThrow('Blocked');
    await expect(fakeWindow.fetch('https://auth2.redgifs.com/oauth2/token', { headers: { 'Kinde-SDK': AUTH_MARKER } })).resolves.toBe('ok');
    await expect(fakeWindow.fetch('https://media.redgifs.com/x.jpg')).resolves.toBe('ok');
    expect(() => new FakeXhr().open('POST', 'https://auth2.redgifs.com/oauth2/token')).toThrow('Blocked');
    new FakeXhr().open('GET', 'https://www.redgifs.com/x');
    expect(calls).toEqual(['https://auth2.redgifs.com/oauth2/token', 'https://media.redgifs.com/x.jpg', 'xhr https://www.redgifs.com/x']);
  });
});
