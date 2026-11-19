import { GM, GM_download, GM_xmlhttpRequest } from '$';
import { render } from 'preact';
import { RequestBudget } from './api/budget';
import { createCache } from './api/cache';
import { AuthManager, type AuthDebugEvent } from './api/auth';
import { pageRunner } from './api/pageRunner';
import { RedgifsApi, type ApiOptions, type RequestEvent } from './api/client';
import { createTransport } from './api/http';
import { RequestQueue } from './api/queue';
import { TagCounts } from './api/tagCounts';
import { TokenManager } from './api/token';
import { Router, isBooruPath } from './router';
import { createFollowsStore, createLikesStore } from './store/account';
import { getSettings, subscribeSettings } from './store/settings';
import { takeOver } from './takeover';
import css from './theme.css?inline';
import browseCss from './theme-browse.css?inline';
import { App } from './ui/App';
import { pickGmDownload, setGmDownload } from './ui/download';
import { ErrorBoundary, showFatalError } from './ui/ErrorBoundary';

const REQUEST_LOG_MAX = 200;

async function main(): Promise<void> {
  if (!isBooruPath(location.pathname)) return;

  // Must run first and synchronously, while the document is still loading.
  const { mount, report } = takeOver(css + '\n' + browseCss, 'RedGIFsbooru');
  console.info('[RedGIFsbooru] takeover', report);
  // `?rgbdebug` puts the takeover report in the tab title, where tools that
  // cannot run code in the page can still read it.
  const debug = new URLSearchParams(location.search).has('rgbdebug');
  if (debug) {
    setTimeout(() => {
      const staticJs = performance.getEntriesByType('resource')
        .filter((entry) => /\/static\/.*\.js/.test(entry.name) && entry.startTime >= report.at).length;
      document.title = `RGBDEBUG ${JSON.stringify({ ...report, staticJsAfter: staticJs })}`;
    }, 4000);
  }

  try {
    await start(mount, debug);
  } catch (error) {
    console.error('[RedGIFsbooru] startup failed', error);
    showFatalError(mount, error);
  }
}

async function start(mount: HTMLElement, debug: boolean): Promise<void> {
  if (location.pathname === '/booru' || location.pathname === '/booru/') {
    history.replaceState(null, '', `/booru/posts${location.search}`);
  }

  // Some managers (Firefox for Android) provide only the GM.* style, or nothing that was not declared.
  const gmObject = typeof GM === 'undefined' ? undefined : (GM as unknown as Record<string, unknown> | undefined);
  setGmDownload(pickGmDownload({
    gmDownload: typeof GM_download === 'function' ? GM_download : undefined,
    gmDotDownload: gmObject?.download,
  }));
  const transport = createTransport({
    gmXhr: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : undefined,
    gmDotXhr: gmObject?.xmlHttpRequest,
  });
  const cache = await createCache();
  // One request budget and rate-limit pause shared by every booru tab, through localStorage.
  const queue = new RequestQueue({ budget: new RequestBudget(localStorage), storage: localStorage });
  // The login: the page-world runner asks RedGifs for an id_token with the user's own session.
  const authEvents: AuthDebugEvent[] = [];
  const auth = new AuthManager({
    runner: pageRunner(),
    storage: localStorage,
    keepLoggedIn: getSettings().keepLoggedIn,
    // Debug events carry lengths and flags only, never a token.
    onDebug: debug ? (event) => {
      authEvents.push(event);
      if (authEvents.length > REQUEST_LOG_MAX) authEvents.shift();
      document.documentElement.dataset.rgbAuth = JSON.stringify(authEvents);
    } : undefined,
  });
  subscribeSettings(() => auth.setKeepLoggedIn(getSettings().keepLoggedIn));
  const apiOptions: ApiOptions = { transport, cache, tokens: new TokenManager(transport, localStorage), auth, queue, storage: localStorage };
  if (debug) {
    // Keep the last REQUEST_LOG_MAX request events on the page for tools to read.
    const requestLog: RequestEvent[] = [];
    apiOptions.onRequest = (event) => {
      requestLog.push(event);
      if (requestLog.length > REQUEST_LOG_MAX) requestLog.shift();
      document.documentElement.dataset.rgbRequests = JSON.stringify(requestLog);
      console.info('[RedGIFsbooru] request', event);
    };
  }
  const api = new RedgifsApi(apiOptions);
  // Pick up a login made in another tab when this one comes back into view.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void auth.checkNow(); });
  window.addEventListener('focus', () => { void auth.checkNow(); });
  void auth.start();
  const likes = createLikesStore(api.account, auth);
  const follows = createFollowsStore(api.account, auth);
  const router = new Router();
  router.interceptLinks();
  const tagCounts = new TagCounts(api, localStorage);
  render(<ErrorBoundary><App api={api} router={router} tagCounts={tagCounts} auth={auth} likes={likes} follows={follows} /></ErrorBoundary>, mount);
}

void main();
