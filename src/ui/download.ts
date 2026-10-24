// Downloads through GM_download (set once by main.tsx), falling back to opening the file in a new tab.
type GmDownload = (details: { url: string; name: string; saveAs?: boolean; onerror?: () => void }) => unknown;

let gmDownload: GmDownload | null = null;

/** Called once by main.tsx with GM_download, when the userscript manager provides it. */
export function setGmDownload(fn: GmDownload | null | undefined): void {
  gmDownload = typeof fn === 'function' ? fn : null;
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
