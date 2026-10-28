// Stops RedGifs' own app from booting and replaces the page with an empty
// document that RedGIFsbooru owns. Runs at document-start.
//
// Why this works (Firefox + Tampermonkey):
// 1. RedGifs' app is a `<script type="module">`, which is deferred: it only
//    runs after the HTML parser finishes. `window.stop()` aborts the parser
//    and cancels pending loads, and Firefox drops the deferred scripts of an
//    aborted parser, so the app never runs.
// 2. In case the parser was not stopped (e.g. the script was injected late),
//    the whole `<html>` element is swapped for a new one. The parser keeps
//    inserting into the old, detached tree, and a script that is not connected
//    to the document is never executed. RedGifs' `#root` goes with it, so even
//    a late app would fail to mount.
// 3. Tampermonkey sometimes injects only after the parser has finished
//    (readyState "interactive"). Then the module graph is already loading and
//    `window.stop()` cannot drop it: Firefox re-requests the cancelled chunks
//    and runs them. A CSP <meta> added first makes those requests fail, so
//    the graph never evaluates, and blocks any fetch/beacon from page code
//    that still runs. Userscript code and GM_xmlhttpRequest are exempt.
// 4. `beforescriptexecute` (Firefox, classic scripts only) and a
//    MutationObserver block any foreign element that reaches the document.

export const OWNED_ATTR = 'data-rgb';

/**
 * Applied to the page's own code only; the booru's images come from <img>.
 * connect-src allows only RedGifs' login host (auth2.redgifs.com): the booru's own
 * page-world token refresh (src/api/pageRunner.ts) needs it; RedGifs' app stays blocked.
 * Inline/eval scripts stay allowed so other extensions and dev tools that
 * inject code still work; RedGifs' app is all external chunks, which are
 * blocked, and its inline scripts are left in the detached old document.
 */
export const PAGE_CSP =
  "script-src 'unsafe-inline' 'unsafe-eval' moz-extension:; connect-src https://auth2.redgifs.com; frame-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'";

function cspMeta(): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = PAGE_CSP;
  meta.setAttribute(OWNED_ATTR, '');
  return meta;
}

export interface TakeoverReport {
  /** document.readyState when the userscript started. */
  readyState: DocumentReadyState;
  /** Whether RedGifs' #root already had content (its app had rendered). */
  appHadRendered: boolean;
  /** Whether RedGifs' module script was already in the document. */
  appScriptSeen: boolean;
  /** Foreign scripts blocked after the takeover. */
  blocked: string[];
  /** Loads the CSP refused, as "directive url". */
  cspBlocked: string[];
  /** Milliseconds since navigation start when the takeover ran. */
  at: number;
}

const isOwned = (node: Node): boolean =>
  node instanceof Element && node.hasAttribute(OWNED_ATTR);

function describe(el: Element): string {
  const src = el.getAttribute('src') || el.getAttribute('href');
  return `${el.tagName.toLowerCase()}${src ? ` ${src}` : ''}`;
}

export function takeOver(css: string, title: string): { mount: HTMLElement; report: TakeoverReport } {
  const old = document.documentElement;
  const report: TakeoverReport = {
    readyState: document.readyState,
    appHadRendered: Boolean(old?.querySelector('#root')?.childElementCount),
    appScriptSeen: Boolean(old?.querySelector('script[type="module"][src*="/static/"]')),
    blocked: [],
    cspBlocked: [],
    at: Math.round(performance.now()),
  };

  document.addEventListener('securitypolicyviolation', (event) => {
    report.cspBlocked.push(`${event.effectiveDirective} ${event.blockedURI}`);
    if (document.documentElement) document.documentElement.dataset.rgbTakeover = JSON.stringify(report);
  }, true);

  // A meta CSP only takes effect inside <head>, so it goes into RedGifs' head
  // now (before stopping, so re-requests are already blocked) and into ours.
  document.head?.append(cspMeta());
  window.stop();

  const block = (el: Element) => {
    if (el instanceof HTMLScriptElement) el.type = 'javascript/blocked';
    el.remove();
    report.blocked.push(describe(el));
  };

  document.addEventListener('beforescriptexecute', (event) => {
    const target = event.target as Element;
    if (isOwned(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    block(target);
  }, true);

  const html = document.createElement('html');
  html.setAttribute(OWNED_ATTR, '');
  html.lang = 'en';
  const head = document.createElement('head');
  head.setAttribute(OWNED_ATTR, '');
  const body = document.createElement('body');
  body.setAttribute(OWNED_ATTR, '');
  html.append(head, body);

  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1';
  const titleEl = document.createElement('title');
  titleEl.textContent = title;
  const style = document.createElement('style');
  style.textContent = css;
  for (const el of [meta, titleEl, style]) el.setAttribute(OWNED_ATTR, '');
  head.append(cspMeta(), meta, titleEl, style);

  const mount = document.createElement('div');
  mount.id = 'rgb-app';
  mount.setAttribute(OWNED_ATTR, '');
  body.append(mount);

  if (old) document.replaceChild(html, old);
  else document.appendChild(html);

  // Only the document, <html>, <head> and <body> are watched (not the app's
  // own subtree), so this stays cheap while the app renders.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || isOwned(node)) continue;
        if (record.target === document && node !== html) {
          // Something replaced or added a root element: put ours back.
          node.remove();
          report.blocked.push(describe(node));
          if (!html.isConnected) document.appendChild(html);
        } else if (node.matches('script, link, iframe, style, meta, object, embed') || record.target === body) {
          block(node);
        }
      }
    }
    html.dataset.rgbTakeover = JSON.stringify(report);
  });
  observer.observe(document, { childList: true });
  observer.observe(html, { childList: true });
  observer.observe(head, { childList: true });
  observer.observe(body, { childList: true });

  html.dataset.rgbTakeover = JSON.stringify(report);
  return { mount, report };
}
