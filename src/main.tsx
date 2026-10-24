import { GM_download, GM_xmlhttpRequest } from '$';
import { render } from 'preact';
import { RequestBudget } from './api/budget';
import { createCache } from './api/cache';
import { RedgifsApi, type ApiOptions, type RequestEvent } from './api/client';
import { gmTransport, type GmRequest } from './api/http';
import { RequestQueue } from './api/queue';
import { TagCounts } from './api/tagCounts';
import { TokenManager } from './api/token';
import { Router, isBooruPath } from './router';
import { takeOver } from './takeover';
import css from './theme.css?inline';
import browseCss from './theme-browse.css?inline';
import { App } from './ui/App';
import { setGmDownload } from './ui/download';

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

  if (location.pathname === '/booru' || location.pathname === '/booru/') {
    history.replaceState(null, '', `/booru/posts${location.search}`);
  }

  setGmDownload(typeof GM_download === 'function' ? (GM_download as never) : null);
  const transport = gmTransport(GM_xmlhttpRequest as unknown as GmRequest);
  const cache = await createCache();
  // One request budget and rate-limit pause shared by every booru tab, through localStorage.
  const queue = new RequestQueue({ budget: new RequestBudget(localStorage), storage: localStorage });
  const apiOptions: ApiOptions = { transport, cache, tokens: new TokenManager(transport, localStorage), queue, storage: localStorage };
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
  const router = new Router();
  router.interceptLinks();
  const tagCounts = new TagCounts(api, localStorage);
  render(<App api={api} router={router} tagCounts={tagCounts} />, mount);
}

void main();
