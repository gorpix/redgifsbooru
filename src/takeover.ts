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

/** The Kinde-SDK header value the booru's own refresh sends (src/api/pageRunner.ts). */
export const AUTH_MARKER = 'JavaScript/redgifsbooru';

/** Chromium (Chrome, Edge, Brave, Opera…), detected from the user agent. */
export function isChromium(ua: string = navigator.userAgent): boolean {
  return /\bChrom(e|ium)\//.test(ua) && !/\bFirefox\//.test(ua);
}

/** Page-world code that refuses auth2.redgifs.com requests lacking the booru's marker. */
export function authGuardScript(marker: string = AUTH_MARKER): string {
  return `(function(){
var M=${JSON.stringify(marker)},A=/^https?:\\/\\/auth2\\.redgifs\\.com/i,of=window.fetch;
function hv(h){try{if(!h)return null;if(typeof h.get==='function')return h.get('Kinde-SDK');for(var k in h)if(k.toLowerCase()==='kinde-sdk')return h[k];}catch(e){}return null;}
window.fetch=function(i,o){try{var u=typeof i==='string'?i:(i&&i.url)||String(i);if(A.test(u)&&hv(o&&o.headers)!==M&&hv(i&&i.headers)!==M)return Promise.reject(new TypeError('Blocked by RedGIFsbooru'));}catch(e){}return of.apply(this,arguments);};
var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(A.test(String(u)))throw new TypeError('Blocked by RedGIFsbooru');return oo.apply(this,arguments);};
})();`;
}

function installAuthGuard(parent: Node): void {
  try {
    const script = document.createElement('script');
    script.setAttribute(OWNED_ATTR, '');
    script.textContent = authGuardScript();
    parent.appendChild(script);
    script.remove();
  } catch {
    // Without the guard the CSP still blocks everything except auth2.
  }
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

  // First, before RedGifs' modules can evaluate: a page-world guard so only the booru's
  // own login refresh may reach auth2.redgifs.com (RedGifs' Kinde refresh racing ours
  // could rotate the refresh token and log the user out).
  installAuthGuard(document.head ?? document.documentElement);

  // A meta CSP only takes effect inside <head>, so it goes into RedGifs' head
  // now (before stopping, so re-requests are already blocked) and into ours.
  document.head?.append(cspMeta());

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

  // Chromium blocks rendering until every render-blocking stylesheet of the load has
  // finished, and one cancelled by window.stop() or removed while loading never counts as
  // finished: the page then never paints (gray). So in Chromium we do NOT stop, and move
  // RedGifs' stylesheet <link>s into our head with media="not all" so they finish loading
  // without ever applying. Its scripts may then run; the auth2 guard and CSP make that
  // harmless (no render without #root, no network except our own auth2 refresh).
  const stopLoad = !isChromium();
  if (!stopLoad && old) {
    for (const link of [...old.querySelectorAll('link[rel="stylesheet"]')]) {
      link.setAttribute('media', 'not all');
      link.setAttribute(OWNED_ATTR, '');
      head.append(link);
    }
  }
  if (old) document.replaceChild(html, old);
  else document.appendChild(html);
  // Stop only AFTER RedGifs' <html> (and its render-blocking stylesheet <link>s) is out of
  // the document. Chrome never stops waiting for a render-blocking stylesheet that
  // window.stop() cancels while it is still in the document, and then never paints the
  // page (seen 2026-11-06: gray page, no animation frames). Nothing runs in between,
  // so RedGifs' parser cannot advance and the protection is unchanged.
  if (stopLoad) window.stop();

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
