// /booru/sets: my RedGifs collections as an e621-style table, with create / rename / edit /
// toggle public / delete. All writes go through api.account.
import { useEffect, useState } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Route, type Router } from '../router';
import { useAuthState } from './account';
import { gateNotice, setMembership, setNameProblem, visibilityLabel } from './accountHelpers';
import { Columns } from './Columns';
import { formatCount } from './format';
import { errorMessage } from './postsHelpers';
import { loadAllSets } from './setsData';
import { useLoad } from './useLoad';

const SITE = 'RedGIFsbooru';

export interface SetFields {
  name: string;
  description: string;
  published: boolean;
}

/** Name, description and public checkbox; used to create a set and to edit one. */
export function SetForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: SetFields;
  submitLabel: string;
  onSubmit: (fields: SetFields) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [published, setPublished] = useState(initial.published);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    const bad = setNameProblem(name);
    if (bad) { setProblem(bad); return; }
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit({ name: name.trim(), description: description.trim(), published });
      if (!onCancel) { setName(''); setDescription(''); setPublished(false); }
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="rgb-setform" onSubmit={(e) => { void submit(e); }}>
      <label>
        Name
        <input type="text" value={name} maxLength={100} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        Description
        <textarea rows={2} value={description} onInput={(e) => setDescription(e.currentTarget.value)} />
      </label>
      <label class="rgb-check">
        <input type="checkbox" checked={published} onChange={(e) => setPublished(e.currentTarget.checked)} />
        {' '}Public (anyone can see this set on RedGifs)
      </label>
      <p>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        {onCancel && <>{' '}<button type="button" disabled={busy} onClick={onCancel}>Cancel</button></>}
        {problem && <span class="error"> {problem}</span>}
      </p>
    </form>
  );
}

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'sets' }>;
}

function SetsTable({ api }: { api: RedgifsApi }) {
  const [rev, setRev] = useState(0);
  const sets = useLoad(`sets|${rev}`, (signal) => loadAllSets(api, signal));
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Runs one write, then reloads the table. */
  const run = async (id: string, job: () => Promise<void>) => {
    setBusyId(id);
    setNote(null);
    try {
      await job();
      setRev((n) => n + 1);
    } catch (error) {
      setNote(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const create = async (fields: SetFields) => {
    await api.account.createCollection({ folderName: fields.name, description: fields.description || null, published: fields.published });
    setRev((n) => n + 1);
  };

  return (
    <>
      {sets.status === 'loading' && <p class="rgb-progress">Loading your sets…</p>}
      {sets.status === 'error' && (
        <div class="rgb-notice error">
          <p>{errorMessage(sets.error)}</p>
          <button type="button" onClick={sets.retry}>Retry</button>
        </div>
      )}
      {note && <p class="error">{note}</p>}
      {sets.status === 'ok' && (
        sets.value.length === 0
          ? <p class="muted">You have no sets yet. Create one below, or use "Add to set…" on a post.</p>
          : (
            <table class="rgb-pools rgb-sets">
              <thead>
                <tr><th>Name</th><th class="num">Posts</th><th>Visibility</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {sets.value.map((set) => (
                  <tr key={set.id}>
                    {editing === set.id ? (
                      <td colSpan={4}>
                        <SetForm
                          initial={{ name: set.name, description: set.description ?? '', published: set.published }}
                          submitLabel="Save"
                          onCancel={() => setEditing(null)}
                          onSubmit={async (fields) => {
                            await api.account.updateCollection(set.id, { folderName: fields.name, description: fields.description || null, published: fields.published });
                            setEditing(null);
                            setRev((n) => n + 1);
                          }}
                        />
                      </td>
                    ) : (
                      <>
                        <td>
                          <a href={hrefFor({ name: 'set', id: set.id, tags: '', page: 1 })}>{set.name}</a>
                          {set.description && <div class="muted rgb-set-desc">{set.description}</div>}
                        </td>
                        <td class="num">{set.count === null ? '–' : formatCount(set.count)}</td>
                        <td>{visibilityLabel(set.published)}</td>
                        <td class="rgb-set-actions">
                          <button type="button" class="link-btn" disabled={busyId === set.id} onClick={() => setEditing(set.id)}>Edit</button>
                          {' | '}
                          <button
                            type="button"
                            class="link-btn"
                            disabled={busyId === set.id}
                            title={set.published ? 'Make this set private' : 'Make this set public'}
                            onClick={() => { void run(set.id, () => api.account.updateCollection(set.id, { published: !set.published })); }}
                          >
                            {set.published ? 'Make private' : 'Make public'}
                          </button>
                          {' | '}
                          <button
                            type="button"
                            class="link-btn"
                            disabled={busyId === set.id}
                            onClick={() => {
                              if (!confirm(`Delete the set "${set.name}"? The posts in it are not deleted.`)) return;
                              void run(set.id, async () => {
                                await api.account.deleteCollection(set.id);
                                setMembership.forgetSet(set.id);
                              });
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}
      <h2 class="rgb-section">New set</h2>
      <SetForm initial={{ name: '', description: '', published: false }} submitLabel="Create set" onSubmit={create} />
    </>
  );
}

export function SetsPage({ api, router, tagCounts, route }: Props) {
  const { gate } = useAuthState();
  const notice = gateNotice(gate, 'sets');
  useEffect(() => { document.title = `Sets | ${SITE}`; }, []);
  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route}>
      <h1 class="rgb-title">Sets</h1>
      {notice ? <div class="rgb-notice"><p>{notice}</p></div> : <SetsTable api={api} />}
    </Columns>
  );
}
