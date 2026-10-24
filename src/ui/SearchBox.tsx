import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RedgifsApi, TagSuggestion } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Router } from '../router';
import { buildAliasMap } from '../search/aliases';
import { BUILTIN_ALIASES } from '../search/builtinAliases';
import { BUILTIN_MERGES } from '../search/builtinMerges';
import { buildMergeIndex, parseMergeText } from '../search/merges';
import { getAliasText, parseAliasText, subscribeAliases } from '../store/aliases';
import { getMergeText, subscribeMerges } from '../store/merges';
import { applySuggestion, autocompleteContext, buildSuggestionRows, canReuseSuggestions, filterSuggestions, type AutocompleteContext, type SuggestionRow } from './autocomplete';
import { formatCount } from './format';
import { useSubscription } from './hooks';

const DEBOUNCE_MS = 300;
const EMPTY = { fragment: '', list: [] as TagSuggestion[] };

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  /** Text to start with (the current search). */
  initial: string;
  /** Where submitting goes; default: the posts index with the text as its search. */
  submitHref?: (text: string) => string;
  placeholder?: string;
}

export function SearchBox({ api, router, tagCounts, initial, submitHref, placeholder = 'Tags' }: Props) {
  const [text, setText] = useState(initial);
  const [apiState, setApiState] = useState<{ fragment: string; list: TagSuggestion[] }>(EMPTY);
  const aliasVersion = useSubscription(subscribeAliases);
  const aliasMap = useMemo(() => buildAliasMap(BUILTIN_ALIASES, parseAliasText(getAliasText())), [aliasVersion]);
  const mergeVersion = useSubscription(subscribeMerges);
  const mergeIndex = useMemo(() => buildMergeIndex(BUILTIN_MERGES, parseMergeText(getMergeText())), [mergeVersion]);
  const countsVersion = useSubscription(tagCounts.subscribe.bind(tagCounts));
  const items: SuggestionRow[] = useMemo(
    () =>
      apiState.fragment
        ? buildSuggestionRows({ fragment: apiState.fragment, apiSuggestions: apiState.list, aliasMap, mergeIndex, countOf: (key) => tagCounts.get(key) })
        : [],
    [apiState, aliasMap, mergeIndex, tagCounts, countsVersion],
  );
  // Alias/redirect rows can point at tags missing from the API list; fetch their counts.
  useEffect(() => {
    const names = items.flatMap((row) => (row.count === undefined ? mergeIndex.members(row.insert) : []));
    if (names.length) tagCounts.request(names);
  }, [items, mergeIndex, tagCounts]);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const ctx = useRef<AutocompleteContext | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticket = useRef(0);
  /** The last fragment sent to the API and how many suggestions it returned (before filtering). */
  const lastLookup = useRef<{ fragment: string; length: number } | null>(null);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); ticket.current++; }, []);

  useEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    input.current.focus();
    input.current.setSelectionRange(caret, caret);
  });

  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    ticket.current++;
    ctx.current = null;
    lastLookup.current = null;
    setApiState(EMPTY);
    setActive(-1);
  };

  const schedule = (value: string, caret: number) => {
    const next = autocompleteContext(value, caret);
    const prev = lastLookup.current;
    if (next && prev && prev.fragment === next.fragment) {
      ctx.current = next; // same fragment: its lookup is shown, pending or in flight; leave it alone
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    ctx.current = next;
    const mine = ++ticket.current;
    if (!next) {
      lastLookup.current = null;
      setApiState(EMPTY);
      setActive(-1);
      return;
    }
    if (prev && canReuseSuggestions(prev.fragment, prev.length, next.fragment)) {
      // The earlier answer was complete, so a longer fragment is a local filter of it.
      lastLookup.current = { fragment: next.fragment, length: prev.length };
      setApiState((state) => ({ fragment: next.fragment, list: filterSuggestions(state.list, next.fragment) }));
      setActive(-1);
      return;
    }
    lastLookup.current = { fragment: next.fragment, length: -1 };
    timer.current = setTimeout(() => {
      api.suggestTags(next.fragment).then(
        (list) => {
          if (mine !== ticket.current) return;
          lastLookup.current = { fragment: next.fragment, length: list.length };
          setApiState({ fragment: next.fragment, list: filterSuggestions(list, next.fragment) });
          setActive(-1);
        },
        () => {
          if (mine !== ticket.current) return;
          lastLookup.current = null;
          setApiState(EMPTY);
        },
      );
    }, DEBOUNCE_MS);
  };

  const accept = (suggestion: string) => {
    const c = ctx.current;
    if (!c) return;
    const result = applySuggestion(text, c, suggestion);
    pendingCaret.current = result.caret;
    close();
    setText(result.text);
  };

  const onSubmit = (event: Event) => {
    event.preventDefault();
    close();
    router.navigate(submitHref ? submitHref(text.trim()) : hrefFor({ name: 'posts', tags: text.trim(), page: 1 }));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const open = items.length > 0;
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); close(); }
    } else if (open && event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((active + 1) % items.length);
    } else if (open && event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((active - 1 + items.length) % items.length);
    } else if (open && active >= 0 && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      accept(items[active].insert);
    }
  };

  return (
    <form class="rgb-search" onSubmit={onSubmit}>
      <div class="rgb-ac">
        <input
          ref={input}
          type="text"
          name="tags"
          value={text}
          placeholder={placeholder}
          autocomplete="off"
          spellcheck={false}
          onInput={(event) => {
            const el = event.currentTarget as HTMLInputElement;
            setText(el.value);
            schedule(el.value, el.selectionStart ?? el.value.length);
          }}
          onKeyDown={onKeyDown}
          onBlur={close}
        />
        {items.length > 0 && (
          <ul class="rgb-ac-list" role="listbox">
            {items.map((item, i) => (
              <li
                key={item.label}
                role="option"
                aria-selected={i === active}
                class={i === active ? 'active' : ''}
                onMouseDown={(event) => { event.preventDefault(); accept(item.insert); }}
                onMouseEnter={() => setActive(i)}
              >
                <span class="term">
                  {item.label.replace(/_/g, " ")}
                  {item.target !== undefined && (
                    <>
                      <span class="redirect-arrow"> → </span>
                      <span class="redirect-target">{item.target.replace(/_/g, " ")}</span>
                    </>
                  )}
                </span>
                {item.count !== undefined && <span class="count">{formatCount(item.count)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="submit">Search</button>
    </form>
  );
}
