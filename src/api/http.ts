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
