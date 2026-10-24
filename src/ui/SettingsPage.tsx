import { useMemo, useState } from 'preact/hooks';
import type { TagCounts } from '../api/tagCounts';
import { BUILTIN_ALIASES } from '../search/builtinAliases';
import { BUILTIN_CATEGORIES } from '../search/builtinCategories';
import { BUILTIN_MERGES } from '../search/builtinMerges';
import { CATEGORIES, CATEGORY_LABEL, CATEGORY_ORDER, type Category } from '../search/categories';
import { parseMergeText, reorderMergeText } from '../search/merges';
import { toTagTerm } from '../search/tags';
import { getAliasText, setAliasText } from '../store/aliases';
import { getBlacklistText, setBlacklistText } from '../store/blacklist';
import { getCategoryText, setCategoryText } from '../store/categories';
import { getMergeText, setMergeText } from '../store/merges';
import { detectRedgifsX, importRedgifsX, type ImportCounts } from '../store/importRedgifsX';
import { getSettings, subscribeSettings, updateSettings } from '../store/settings';
import { defaultStorage } from '../store/storage';
import { formatCount } from './format';
import { useSubscription } from './hooks';

const COUNT_TIMEOUT_MS = 10_000;

/** Resolves once every key has a looked-up count (a number or null), or after the timeout. */
function waitForCounts(tagCounts: TagCounts, keys: string[], timeoutMs = COUNT_TIMEOUT_MS): Promise<void> {
  const ready = () => keys.every((k) => tagCounts.get(k) !== undefined);
  return new Promise((resolve) => {
    if (ready()) return resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = tagCounts.subscribe(() => {
      if (!ready()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    timer = setTimeout(() => { off(); resolve(); }, timeoutMs);
  });
}

function describeCounts(c: ImportCounts): string {
  const parts = [
    `${c.blacklist} blacklist entries`,
    `${c.paused} paused rules`,
    `${c.saved} saved searches${c.skippedSaved ? ` (${c.skippedSaved} skipped)` : ''}`,
    `${c.seen} seen posts`,
    `${c.tagCounts} tag counts`,
  ];
  return parts.join(', ');
}

export function SettingsPage({ tagCounts }: { tagCounts: TagCounts }) {
  const version = useSubscription(subscribeSettings);
  const settings = useMemo(() => getSettings(), [version]);

  const [text, setText] = useState(() => getBlacklistText());
  const [saved, setSaved] = useState(false);
  const [aliasText, setAliasTextState] = useState(() => getAliasText());
  const [aliasSaved, setAliasSaved] = useState(false);
  const [mergeText, setMergeTextState] = useState(() => getMergeText());
  const [mergeStatus, setMergeStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [categoryText, setCategoryTextState] = useState(() => getCategoryText());
  const [categorySaved, setCategorySaved] = useState(false);
  const builtinByCategory = useMemo(() => {
    const out = new Map<Category, string[]>();
    for (const [tag, category] of Object.entries(BUILTIN_CATEGORIES)) out.set(category, [...(out.get(category) ?? []), tag]);
    return CATEGORY_ORDER.filter((c) => out.has(c)).map((c) => ({ category: c, tags: (out.get(c) as string[]).sort() }));
  }, []);
  const [perPage, setPerPage] = useState<string | null>(null);

  const storage = defaultStorage();
  const [found, setFound] = useState(() => detectRedgifsX(storage));
  const [imported, setImported] = useState<ImportCounts | null>(null);
  const hasData = found.blacklist + found.paused + found.saved + found.skippedSaved + found.seen + found.tagCounts > 0;

  const saveMerges = async () => {
    setMergeStatus('saving');
    const keys = [...new Set(parseMergeText(mergeText).flat())];
    tagCounts.request(keys);
    await waitForCounts(tagCounts, keys);
    const ordered = reorderMergeText(mergeText, (key) => tagCounts.get(key));
    setMergeText(ordered);
    setMergeTextState(ordered);
    setMergeStatus('saved');
  };

  return (
    <div class="rgb-settings">
      <h1>Settings</h1>

      <section class="panel">
        <h2>Blacklist</h2>
        <p class="muted">
          Tags to hide everywhere, separated by commas or new lines. <code>*part</code> hides any tag containing "part".
          Underscores and spaces are the same.
        </p>
        <textarea
          rows={8}
          value={text}
          spellcheck={false}
          onInput={(event) => { setText((event.currentTarget as HTMLTextAreaElement).value); setSaved(false); }}
        />
        <p>
          <button type="button" onClick={() => { setBlacklistText(text); setSaved(true); }}>Save blacklist</button>
          {saved && <span class="muted"> Saved.</span>}
        </p>
      </section>

      <section class="panel">
        <h2>Tag aliases</h2>
        <p class="muted">
          Rewrite a typed tag that RedGifs doesn't have into the one you mean. One per line, like <code>blond -&gt; blonde</code>.
          Your entries override the built-in aliases; <code>tag -&gt; tag</code> disables a built-in alias.
        </p>
        <textarea
          rows={6}
          value={aliasText}
          spellcheck={false}
          onInput={(event) => { setAliasTextState((event.currentTarget as HTMLTextAreaElement).value); setAliasSaved(false); }}
        />
        <p>
          <button type="button" onClick={() => { setAliasText(aliasText); setAliasSaved(true); }}>Save aliases</button>
          {aliasSaved && <span class="muted"> Saved.</span>}
        </p>
        <details class="rgb-builtin-aliases">
          <summary>Built-in aliases ({BUILTIN_ALIASES.length})</summary>
          <ul class="rgb-list">
            {BUILTIN_ALIASES.map(([from, to]) => (
              <li key={from}>{toTagTerm(from)} → {toTagTerm(to)}</li>
            ))}
          </ul>
        </details>
      </section>

      <section class="panel">
        <h2>Tag merges</h2>
        <p class="muted">
          Join real RedGifs tags that mean the same thing, so a search covers all of them. One group per line, separated by
          commas, like <code>big_tits, big_boobs</code>. Saving puts the most popular tag first; that one is shown for the group.
          Your groups override the built-in ones; a line with a single tag removes it from its built-in group.
        </p>
        <textarea
          rows={6}
          value={mergeText}
          spellcheck={false}
          onInput={(event) => { setMergeTextState((event.currentTarget as HTMLTextAreaElement).value); setMergeStatus('idle'); }}
        />
        <p>
          <button type="button" disabled={mergeStatus === 'saving'} onClick={() => { void saveMerges(); }}>Save merges</button>
          {mergeStatus === 'saving' && <span class="muted"> Looking up tag counts…</span>}
          {mergeStatus === 'saved' && <span class="muted"> Saved.</span>}
        </p>
        <details class="rgb-builtin-merges">
          <summary>Built-in merges ({BUILTIN_MERGES.length})</summary>
          <ul class="rgb-list">
            {BUILTIN_MERGES.map((group) => (
              <li key={group[0]}>
                {group.map((key, i) => {
                  const count = tagCounts.get(key);
                  return (
                    <span key={key}>
                      {i > 0 && ', '}
                      {toTagTerm(key)}
                      {typeof count === 'number' && <span class="muted"> ({formatCount(count)})</span>}
                    </span>
                  );
                })}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section class="panel">
        <h2>Tag categories</h2>
        <p class="muted">
          Which group a tag is listed under on the post page. One per line, like <code>big_tits: body</code>.
          Valid categories: {CATEGORIES.filter((c) => c !== 'creator').join(', ')}. Your lines override the built-in ones;
          lines starting with # are comments.
        </p>
        <textarea
          rows={6}
          value={categoryText}
          spellcheck={false}
          onInput={(event) => { setCategoryTextState((event.currentTarget as HTMLTextAreaElement).value); setCategorySaved(false); }}
        />
        <p>
          <button type="button" onClick={() => { setCategoryText(categoryText); setCategorySaved(true); }}>Save categories</button>
          {categorySaved && <span class="muted"> Saved.</span>}
        </p>
        <details class="rgb-builtin-aliases">
          <summary>Built-in categories ({Object.keys(BUILTIN_CATEGORIES).length})</summary>
          {builtinByCategory.map(({ category, tags }) => (
            <div key={category}>
              <h3>{CATEGORY_LABEL[category]} ({tags.length})</h3>
              <p class="muted rgb-cat-tags">{tags.map(toTagTerm).join(', ')}</p>
            </div>
          ))}
        </details>
      </section>

      <section class="panel">
        <h2>Display</h2>
        <p>
          <label>
            Posts per page{' '}
            <input
              type="number"
              min={1}
              max={500}
              value={perPage ?? settings.postsPerPage}
              onInput={(event) => {
                const raw = (event.currentTarget as HTMLInputElement).value;
                setPerPage(raw);
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 1 && n <= 500) updateSettings({ postsPerPage: Math.round(n) });
              }}
              onBlur={() => setPerPage(null)}
            />
          </label>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={settings.showRelatedBelow}
              onChange={(event) => updateSettings({ showRelatedBelow: (event.currentTarget as HTMLInputElement).checked })}
            />{' '}
            Always show related posts
          </label>
          <br />
          <span class="muted">On a post page, limits the media height so the related rows are visible under it without scrolling.</span>
        </p>
      </section>

      <section class="panel">
        <h2>Import from RedGIFS-X</h2>
        <p class="muted">
          Copies the RedGIFS-X blacklist, paused rules, saved searches, seen history and tag counts into this script.
          RedGIFS-X's own data is left untouched.
        </p>
        {hasData
          ? <p>Found: {describeCounts(found)}.</p>
          : <p class="muted">No RedGIFS-X data found in this browser.</p>}
        <p>
          <button
            type="button"
            disabled={!hasData}
            onClick={() => {
              const result = importRedgifsX(storage, tagCounts);
              setImported(result);
              setText(getBlacklistText());
              setFound(detectRedgifsX(storage));
            }}
          >
            Import
          </button>
        </p>
        {imported && <p class="rgb-notice">Imported: {describeCounts(imported)}.</p>}
      </section>

      <section class="panel">
        <h2>Interface</h2>
        <p><a href="/">Use RedGifs' interface</a></p>
        <p class="muted">RedGifs' own pages are untouched outside /booru.</p>
      </section>
    </div>
  );
}
