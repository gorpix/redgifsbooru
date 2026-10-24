// The transport is the one piece that touches the network. The userscript
// passes a GM_xmlhttpRequest-based one; tests pass a fake.

export interface HttpRequest {
  url: string;
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
  method: 'GET';
  url: string;
  headers: Record<string, string>;
  timeout: number;
  onload: (response: { status: number; responseText: string }) => void;
  onerror: () => void;
  ontimeout: () => void;
}) => unknown;

/** Transport over Tampermonkey's GM_xmlhttpRequest (no CORS limits). */
export function gmTransport(gmRequest: GmRequest): Transport {
  return ({ url, headers, timeoutMs }) =>
    new Promise((resolve, reject) => {
      gmRequest({
        method: 'GET',
        url,
        headers,
        timeout: timeoutMs,
        onload: (response) => resolve({ status: response.status, text: response.responseText }),
        onerror: () => reject(new Error(`Network error requesting ${url}`)),
        ontimeout: () => reject(new Error(`Timed out requesting ${url}`)),
      });
    });
}

/** Transport over fetch, for environments without GM_xmlhttpRequest. */
export function fetchTransport(fetchFn: typeof fetch = fetch): Transport {
  return async ({ url, headers, timeoutMs }) => {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, text: await response.text() };
  };
}
