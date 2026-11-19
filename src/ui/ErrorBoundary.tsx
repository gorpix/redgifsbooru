import { Component, type ComponentChildren } from 'preact';
import { SETTINGS_KEY } from '../store/settings';

/** A readable one-line message for anything that can be thrown. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string' && error) return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Removes only the settings (lists like the blacklist live under other keys), then reloads. */
export function resetSettings(storage: Pick<Storage, 'removeItem'> = localStorage, reload: () => void = () => location.reload()): void {
  try {
    storage.removeItem(SETTINGS_KEY);
  } catch {
    // storage unavailable: reloading is all we can do
  }
  reload();
}

export const RESET_NOTE = 'Reset settings clears your display settings only. Lists such as the blacklist, aliases and merges are kept.';

/** Minimal DOM version of the panel, for errors thrown before (or outside) rendering. */
export function showFatalError(mount: HTMLElement, error: unknown): void {
  mount.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'rgb-error panel';
  const h = document.createElement('h2');
  h.textContent = `RedGIFsbooru hit an error: ${errorMessage(error)}`;
  const note = document.createElement('p');
  note.textContent = RESET_NOTE;
  const reload = document.createElement('button');
  reload.textContent = 'Reload';
  reload.onclick = () => location.reload();
  const reset = document.createElement('button');
  reset.textContent = 'Reset settings';
  reset.onclick = () => resetSettings();
  const link = document.createElement('a');
  link.href = '/';
  link.textContent = "Use RedGifs' interface";
  panel.append(h, note, reload, reset, link);
  mount.append(panel);
}

export function ErrorPanel({ error }: { error: unknown }) {
  return (
    <div class="rgb-error panel">
      <h2>RedGIFsbooru hit an error: {errorMessage(error)}</h2>
      <p>{RESET_NOTE}</p>
      <button type="button" onClick={() => location.reload()}>Reload</button>
      <button type="button" onClick={() => resetSettings()}>Reset settings</button>
      <a href="/">Use RedGifs' interface</a>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children?: ComponentChildren }, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[RedGIFsbooru] render error', error);
  }

  render() {
    return this.state.failed ? <ErrorPanel error={this.state.error} /> : this.props.children;
  }
}
