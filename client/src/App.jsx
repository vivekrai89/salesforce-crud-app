import { useCallback, useEffect, useRef, useState } from 'react';

const OBJECTS = ['Account', 'Opportunity', 'Lead', 'Contact', 'Case'];

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) throw new Error('SESSION');
  const data = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new Error(data?.error || 'Request failed');
  return data;
}

function RecordModal({ obj, fields, mode, record, onClose, onSaved, onEdit }) {
  const editable = fields.filter((f) => !f.ro);
  const [form, setForm] = useState(() => Object.fromEntries(editable.map((f) => [f.n, record?.[f.n] ?? ''])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const viewing = mode === 'view';

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (mode === 'create') await api(`/api/${obj}`, { method: 'POST', body: JSON.stringify(form) });
      else await api(`/api/${obj}/${record.Id}`, { method: 'PATCH', body: JSON.stringify(form) });
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const title = { view: `${obj} details`, edit: `Edit ${obj}`, create: `New ${obj}` }[mode];

  return (
    <div className="modal" onClick={onClose}>
      <form className="dlg" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{title}</h2>
        {error && <p className="err">{error}</p>}
        {fields.map((f) => {
          if (f.ro) return mode === 'create' ? null : (
            <label key={f.n}>{f.l}<input value={record?.[f.n] ?? ''} disabled /></label>
          );
          const common = {
            value: form[f.n], disabled: viewing, required: !!f.r,
            onChange: (e) => setForm({ ...form, [f.n]: e.target.value }),
          };
          return (
            <label key={f.n}>{f.l}{f.r ? ' *' : ''}
              {f.o ? (
                <select {...common}>
                  <option value="">Select…</option>
                  {f.o.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : f.n === 'Description' ? <textarea rows={3} {...common} />
                : <input type={f.t || 'text'} step="any" {...common} />}
            </label>
          );
        })}
        <div className="row">
          <button type="button" onClick={onClose}>{viewing ? 'Close' : 'Cancel'}</button>
          {viewing && <button type="button" className="primary" onClick={onEdit}>Edit</button>}
          {!viewing && <button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [obj, setObj] = useState('Account');
  const [fields, setFields] = useState([]);
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const offset = useRef(0);
  const gen = useRef(0);
  const scroller = useRef(null);
  const sentinel = useRef(null);

  const fail = (e) => (e.message === 'SESSION' ? setAuthed(false) : setError(e.message));

  useEffect(() => {
    fetch('/api/me').then((r) => r.json()).then((d) => setAuthed(d.loggedIn)).catch(() => setAuthed(false));
  }, []);

  const loadPage = useCallback(async (reset) => {
    const id = reset ? ++gen.current : gen.current;
    if (reset) { offset.current = 0; setRows([]); setHasMore(false); }
    setLoading(true);
    setError('');
    try {
      const d = await api(`/api/${obj}?offset=${offset.current}`);
      if (id !== gen.current) return;
      offset.current += d.records.length;
      setRows((prev) => (reset ? d.records : [...prev, ...d.records]));
      setHasMore(d.hasMore);
    } catch (e) {
      if (id === gen.current) fail(e);
    } finally {
      if (id === gen.current) setLoading(false);
    }
  }, [obj]);

  useEffect(() => {
    if (!authed) return;
    setFields([]);
    api(`/api/${obj}/meta`).then((d) => setFields(d.fields)).catch(fail);
    loadPage(true);
  }, [authed, obj, loadPage]);

  // Infinite scroll: load the next 20 when the bottom sentinel becomes visible
  useEffect(() => {
    if (!sentinel.current || !hasMore || loading) return undefined;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && loadPage(false), { root: scroller.current });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [rows.length, hasMore, loading, loadPage]);

  const open = async (mode, rec) => {
    if (mode === 'create') return setModal({ mode, record: null });
    try {
      setModal({ mode, record: await api(`/api/${obj}/${rec.Id}`) });
    } catch (e) { fail(e); }
  };

  const remove = async (rec) => {
    if (!window.confirm(`Delete this ${obj}? This cannot be undone.`)) return;
    try {
      await api(`/api/${obj}/${rec.Id}`, { method: 'DELETE' });
      setRows((prev) => prev.filter((r) => r.Id !== rec.Id));
    } catch (e) { fail(e); }
  };

  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST' });
    setAuthed(false);
  };

  if (authed === null) return <p className="note">Loading…</p>;

  if (!authed) {
    return (
      <div className="center">
        <h1>Salesforce Records</h1>
        <p>Log in to view and manage Accounts, Opportunities, Leads, Contacts and Cases.</p>
        <a href="/auth/login"><button className="primary">Log in with Salesforce</button></a>
      </div>
    );
  }

  return (
    <>
      <div className="bar">
        <h1>Salesforce Records</h1>
        <button onClick={logout}>Log out</button>
      </div>
      <div className="wrap">
        <div className="tools">
          <select value={obj} onChange={(e) => setObj(e.target.value)} aria-label="Salesforce object">
            {OBJECTS.map((o) => <option key={o}>{o}</option>)}
          </select>
          <button className="primary" onClick={() => open('create')} disabled={!fields.length}>New {obj}</button>
        </div>
        {error && <p className="err">{error}</p>}
        <div className="scroll" ref={scroller}>
          <table>
            <thead>
              <tr>{fields.map((f) => <th key={f.n}>{f.l}</th>)}<th>Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.Id}>
                  {fields.map((f) => <td key={f.n}>{r[f.n] ?? ''}</td>)}
                  <td className="act">
                    <button onClick={() => open('view', r)}>View</button>
                    <button onClick={() => open('edit', r)}>Edit</button>
                    <button className="danger" onClick={() => remove(r)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <p className="note">Loading…</p>}
          {!loading && !rows.length && !error && <p className="note">No {obj} records yet. Use “New {obj}” to add one.</p>}
          {!loading && rows.length > 0 && !hasMore && <p className="note">All records loaded.</p>}
          <div ref={sentinel} style={{ height: 1 }} />
        </div>
      </div>
      {modal && (
        <RecordModal
          key={modal.mode + (modal.record?.Id || '')}
          obj={obj} fields={fields} mode={modal.mode} record={modal.record}
          onClose={() => setModal(null)}
          onEdit={() => setModal({ ...modal, mode: 'edit' })}
          onSaved={() => { setModal(null); loadPage(true); }}
        />
      )}
    </>
  );
}
