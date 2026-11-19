// The transport is the one piece that touches the network. The userscript
// passes a GM_xmlhttpRequest-based one; tests pass a fake.

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  /** Default 'GET'. */
  method?: HttpMethod;
  url: string;
  /** Sent as JSON (with Content-Type application/json) when defined. */
  body?: unknown;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** RedGifs answered 429 and kept doing so after backing off. */
export class RateLimitedError extends Error {
  constructor(readonly url: string, readonly retryAt: number) {
    super('RedGifs is rate-limiting requests');
    this.name = 'RateLimitedError';
  }
}

/** A request to an endpoint the booru must never call (beacons, ads). */
export class ForbiddenEndpointError extends Error {
  constructor(readonly url: string) {
    super(`Refusing to call ${url}`);
    this.name = 'ForbiddenEndpointError';
  }
}

export type GmRequest = (details: {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  data?: string;
  timeout: number;
  onload: (response: { status: number; responseText: string }) => void;
  onerror: () => void;
  ontimeout: () => void;
}) => unknown;

function withJsonHeader(headers: Record<string, string>, body: unknown): Record<string, string> {
  return body === undefined ? headers : { 'Content-Type': 'application/json', ...headers };
}

/** Transport over Tampermonkey's GM_xmlhttpRequest (no CORS limits). */
export function gmTransport(gmRequest: GmRequest): Transport {
  return ({ method = 'GET', url, headers, body, timeoutMs }) =>
    new Promise((resolve, reject) => {
      gmRequest({
        method,
        url,
        headers: withJsonHeader(headers, body),
        ...(body === undefined ? {} : { data: JSON.stringify(body) }),
        timeout: timeoutMs,
        onload: (response) => resolve({ status: response.status, text: response.responseText }),
        onerror: () => reject(new Error(`Network error requesting ${url}`)),
        ontimeout: () => reject(new Error(`Timed out requesting ${url}`)),
      });
    });
}

export const NO_GM_REQUEST_MESSAGE =
  "This userscript manager doesn't provide GM_xmlhttpRequest or GM.xmlHttpRequest; RedGIFsbooru needs one of them (Tampermonkey or Violentmonkey work).";

/**
 * The first usable request function: GM_xmlhttpRequest, else Greasemonkey-4 style
 * GM.xmlHttpRequest (called with the same callback details; its returned promise is ignored).
 * Never falls back to page fetch: the page CSP blocks it and RedGifs' own scripts must not
 * get to reach api.redgifs.com.
 */
export function pickGmRequest(candidates: { gmXhr?: unknown; gmDotXhr?: unknown }): GmRequest | null {
  const wrap = (fn: GmRequest): GmRequest => (details) => {
    const result = fn(details);
    if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => {});
    return result;
  };
  if (typeof candidates.gmXhr === 'function') return candidates.gmXhr as GmRequest;
  if (typeof candidates.gmDotXhr === 'function') return wrap(candidates.gmDotXhr as GmRequest);
  return null;
}

/** Transport over whichever GM request function exists; throws NO_GM_REQUEST_MESSAGE when a request is made without one. */
export function createTransport(candidates: { gmXhr?: unknown; gmDotXhr?: unknown }): Transport {
  const picked = pickGmRequest(candidates);
  if (!picked) return () => Promise.reject(new Error(NO_GM_REQUEST_MESSAGE));
  return gmTransport(picked);
}

/** Transport over fetch, for environments without GM_xmlhttpRequest. */
export function fetchTransport(fetchFn: typeof fetch = fetch): Transport {
  return async ({ method = 'GET', url, headers, body, timeoutMs }) => {
    const response = await fetchFn(url, {
      method,
      headers: withJsonHeader(headers, body),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  };
}
