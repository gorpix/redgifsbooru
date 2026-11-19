// Downloads through GM_download (set once by main.tsx), falling back to opening the file in a new tab.
type GmDownload = (details: { url: string; name: string; saveAs?: boolean; onerror?: () => void }) => unknown;

let gmDownload: GmDownload | null = null;

/** Called once by main.tsx with GM_download, when the userscript manager provides it. */
export function setGmDownload(fn: GmDownload | null | undefined): void {
  gmDownload = typeof fn === 'function' ? fn : null;
}

/** GM_download, else GM.download, else null (the caller then opens a tab). */
export function pickGmDownload(candidates: { gmDownload?: unknown; gmDotDownload?: unknown }): GmDownload | null {
  if (typeof candidates.gmDownload === 'function') return candidates.gmDownload as GmDownload;
  if (typeof candidates.gmDotDownload === 'function') {
    const fn = candidates.gmDotDownload as GmDownload;
    return (details) => {
      const result = fn(details);
      if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => details.onerror?.());
      return result;
    };
  }
  return null;
}

function openInTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}

export function downloadFile(url: string, name: string): void {
  if (gmDownload) {
    try {
      gmDownload({ url, name, saveAs: false, onerror: () => openInTab(url) });
      return;
    } catch {
      // fall through to the tab
    }
  }
  openInTab(url);
}
