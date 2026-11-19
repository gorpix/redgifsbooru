import { describe, expect, it, vi } from 'vitest';
import { NO_GM_REQUEST_MESSAGE, createTransport, pickGmRequest } from '../src/api/http';
import { pickGmDownload } from '../src/ui/download';
import { errorMessage, resetSettings } from '../src/ui/ErrorBoundary';
import { SETTINGS_KEY } from '../src/store/settings';

const respond = (fn: ReturnType<typeof vi.fn>) =>
  fn.mockImplementation((d: { onload: (r: { status: number; responseText: string }) => void }) => { d.onload({ status: 200, responseText: 'ok' }); });

describe('transport selection', () => {
  it('prefers GM_xmlhttpRequest', async () => {
    const a = vi.fn(); const b = vi.fn(); respond(a);
    const t = createTransport({ gmXhr: a, gmDotXhr: b });
    await expect(t({ url: 'https://api.redgifs.com/x', headers: {}, timeoutMs: 1000 })).resolves.toEqual({ status: 200, text: 'ok' });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('falls back to GM.xmlHttpRequest and swallows its rejected promise', async () => {
    const b = vi.fn().mockImplementation((d: { onload: (r: { status: number; responseText: string }) => void }) => {
      d.onload({ status: 200, responseText: 'dot' });
      return Promise.reject(new Error('ignored'));
    });
    const t = createTransport({ gmDotXhr: b });
    await expect(t({ url: 'u', headers: {}, timeoutMs: 1 })).resolves.toEqual({ status: 200, text: 'dot' });
    await new Promise((r) => setTimeout(r, 0));
  });

  it('throws the clear error at request time, not at creation', async () => {
    const t = createTransport({});
    await expect(t({ url: 'u', headers: {}, timeoutMs: 1 })).rejects.toThrow(NO_GM_REQUEST_MESSAGE);
    expect(NO_GM_REQUEST_MESSAGE).toContain('GM_xmlhttpRequest or GM.xmlHttpRequest');
    expect(pickGmRequest({ gmXhr: 'nope' })).toBeNull();
  });
});

describe('download selection', () => {
  it('prefers GM_download, then GM.download, else null', () => {
    const a = vi.fn(); const b = vi.fn();
    expect(pickGmDownload({ gmDownload: a, gmDotDownload: b })).toBe(a);
    pickGmDownload({ gmDotDownload: b })?.({ url: 'u', name: 'n' });
    expect(b).toHaveBeenCalledOnce();
    expect(pickGmDownload({})).toBeNull();
  });
});

describe('error panel helpers', () => {
  it('formats messages', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('text')).toBe('text');
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
  });

  it('reset removes only the settings key, then reloads', () => {
    const removeItem = vi.fn(); const reload = vi.fn();
    resetSettings({ removeItem }, reload);
    expect(removeItem).toHaveBeenCalledWith(SETTINGS_KEY);
    expect(removeItem).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});
