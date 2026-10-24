import { useEffect, useState } from 'preact/hooks';
import { RATE_LIMIT_KEY, readStoredNumber } from '../api/budget';
import type { ApiStatus, RedgifsApi } from '../api/client';

/** The pause another tab (or an earlier page load) stored after a 429; 0 when none. */
function storedUntil(): number {
  try {
    return readStoredNumber(localStorage, RATE_LIMIT_KEY);
  } catch {
    return 0;
  }
}

export function RateLimitBanner({ api }: { api: RedgifsApi }) {
  const [status, setStatus] = useState<ApiStatus>(api.status);
  const [stored, setStored] = useState(storedUntil);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setStatus(api.status);
    return api.onStatus(setStatus);
  }, [api]);

  // Another tab's 429 arrives as a 'storage' event; this tab's own writes do not fire it.
  useEffect(() => {
    const onStorage = () => { setStored(storedUntil()); setNow(Date.now()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const until = Math.max(status.rateLimitedUntil, stored);
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const id = setInterval(() => { setNow(Date.now()); setStored(storedUntil()); }, 1000);
    return () => clearInterval(id);
  }, [until]);

  if (until <= now) return null;
  // Own state says gave up; a pause seen only in storage is shown as a countdown.
  if (status.gaveUp && status.rateLimitedUntil >= stored) {
    return (
      <div class="rgb-banner" role="alert">
        RedGifs is rate-limiting. <a href="https://www.redgifs.com/" target="_blank" rel="noopener">Open RedGifs</a> to continue, then reload this page.
      </div>
    );
  }
  const seconds = Math.max(1, Math.ceil((until - now) / 1000));
  const wait = seconds >= 120 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`;
  return (
    <div class="rgb-banner" role="status">
      RedGifs is rate-limiting requests — retrying in {wait}…
    </div>
  );
}
