// The real page-world runner for the login refresh. The refresh request has to run in the
// page itself (www.redgifs.com), because the httpOnly refresh cookie and the right Origin only
// exist there. The userscript runs in its own sandbox, so it injects an inline <script>.
//
// The script removes itself and hands the answer back through a CustomEvent on `document`
// with a random per-call name; the token travels only in that event's detail string. Nothing
// is left on `window` or in the DOM, and nothing here logs the answer.
import { OWNED_ATTR } from '../takeover';
import type { PageRunner } from './auth';

export const KINDE_ENDPOINT = 'https://auth2.redgifs.com/oauth2/token';
const TIMEOUT_MS = 20_000;

function randomName(): string {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return 'rgb-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'rgb-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

/** The code that runs in the page. Exported for tests (it holds no secrets). */
export function buildPageScript(eventName: string, body: string): string {
  return `(function(){
var s=document.currentScript;
fetch(${JSON.stringify(KINDE_ENDPOINT)},{method:'POST',credentials:'include',headers:{'Content-type':'application/x-www-form-urlencoded; charset=UTF-8','Kinde-SDK':'JavaScript/redgifsbooru'},body:${JSON.stringify(body)}})
.then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t)}catch(e){}return{status:r.status,json:j}})})
.catch(function(){return{status:0,json:null}})
.then(function(res){document.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)},{detail:JSON.stringify(res)}))});
if(s)s.remove();
})();`;
}

export function pageRunner(): PageRunner {
  return (body) =>
    new Promise((resolve) => {
      const name = randomName();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: { status: number; json: unknown }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        document.removeEventListener(name, onEvent);
        resolve(result);
      };
      const onEvent = (event: Event) => {
        try {
          const detail = (event as CustomEvent).detail;
          const parsed = JSON.parse(typeof detail === 'string' ? detail : '{}') as { status?: unknown; json?: unknown };
          finish({ status: typeof parsed.status === 'number' ? parsed.status : 0, json: parsed.json ?? null });
        } catch {
          finish({ status: 0, json: null });
        }
      };
      document.addEventListener(name, onEvent);
      timer = setTimeout(() => finish({ status: 0, json: null }), TIMEOUT_MS);
      try {
        const script = document.createElement('script');
        // Owned, so the takeover's script blocker lets it run.
        script.setAttribute(OWNED_ATTR, '');
        script.textContent = buildPageScript(name, body);
        (document.head ?? document.documentElement).append(script);
        script.remove();
      } catch {
        finish({ status: 0, json: null });
      }
    });
}
