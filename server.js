require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const {
  SF_CLIENT_ID, SF_CLIENT_SECRET, SF_CALLBACK_URL, SESSION_SECRET,
  SF_LOGIN_URL = 'https://login.salesforce.com', PORT = 3000, NODE_ENV,
} = process.env;
const API_VERSION = 'v61.0';
const PAGE_SIZE = 20;
const MAX_OFFSET = 2000; // SOQL OFFSET limit

const STAGES = ['Prospecting', 'Qualification', 'Needs Analysis', 'Value Proposition', 'Id. Decision Makers',
  'Perception Analysis', 'Proposal/Price Quote', 'Negotiation/Review', 'Closed Won', 'Closed Lost'];

// n = API name, l = label, t = input type, r = required, ro = read-only, o = picklist options
const OBJECTS = {
  Account: [
    { n: 'Name', l: 'Account Name', r: 1 }, { n: 'Phone', l: 'Phone' }, { n: 'Website', l: 'Website' },
    { n: 'BillingCity', l: 'Billing City' }, { n: 'BillingCountry', l: 'Billing Country' },
    { n: 'AnnualRevenue', l: 'Annual Revenue', t: 'number' }, { n: 'NumberOfEmployees', l: 'Employees', t: 'number' },
  ],
  Opportunity: [
    { n: 'Name', l: 'Opportunity Name', r: 1 }, { n: 'StageName', l: 'Stage', r: 1, o: STAGES },
    { n: 'CloseDate', l: 'Close Date', t: 'date', r: 1 }, { n: 'Amount', l: 'Amount', t: 'number' },
    { n: 'NextStep', l: 'Next Step' }, { n: 'Description', l: 'Description' },
  ],
  Lead: [
    { n: 'FirstName', l: 'First Name' }, { n: 'LastName', l: 'Last Name', r: 1 }, { n: 'Company', l: 'Company', r: 1 },
    { n: 'Email', l: 'Email', t: 'email' }, { n: 'Phone', l: 'Phone' },
    { n: 'Status', l: 'Status', o: ['Open - Not Contacted', 'Working - Contacted', 'Closed - Converted', 'Closed - Not Converted'] },
  ],
  Contact: [
    { n: 'FirstName', l: 'First Name' }, { n: 'LastName', l: 'Last Name', r: 1 }, { n: 'Email', l: 'Email', t: 'email' },
    { n: 'Phone', l: 'Phone' }, { n: 'Title', l: 'Title' }, { n: 'Department', l: 'Department' },
  ],
  Case: [
    { n: 'CaseNumber', l: 'Case Number', ro: 1 }, { n: 'Subject', l: 'Subject' },
    { n: 'Status', l: 'Status', o: ['New', 'Working', 'Escalated', 'Closed'] },
    { n: 'Priority', l: 'Priority', o: ['High', 'Medium', 'Low'] },
    { n: 'Origin', l: 'Origin', o: ['Phone', 'Email', 'Web'] }, { n: 'Description', l: 'Description' },
  ],
};

const b64url = (buf) => buf.toString('base64url');

async function tokenRequest(params) {
  const r = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: SF_CLIENT_ID, client_secret: SF_CLIENT_SECRET, ...params }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || 'Token request failed');
  return data;
}

async function refreshAccess(s) {
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh });
    s.access = t.access_token;
    s.instance = t.instance_url || s.instance;
    if (t.refresh_token) s.refresh = t.refresh_token; // Refresh Token Rotation issues a new one
  } catch {
    delete s.access;
    delete s.refresh;
  }
}

async function sf(req, method, url, body) {
  const s = req.session;
  const call = () => fetch(`${s.instance}/services/data/${API_VERSION}${url}`, {
    method,
    headers: { Authorization: `Bearer ${s.access}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await call();
  if (r.status === 401 && s.refresh) {
    await refreshAccess(s);
    if (s.access) r = await call();
  }
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

const errorText = (data) => (Array.isArray(data) && data[0]?.message) || 'Salesforce request failed';

function cleanBody(obj, input, isCreate) {
  const out = {};
  for (const f of OBJECTS[obj]) {
    if (f.ro || !(f.n in input)) continue;
    let v = input[f.n];
    if (v === '' || v === undefined) { if (!isCreate) out[f.n] = null; continue; }
    if (f.t === 'number') v = Number(v);
    out[f.n] = v;
  }
  return out;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 },
}));

// ---------- OAuth 2.0 (Authorization Code + PKCE) ----------
app.get('/auth/login', (req, res) => {
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  req.session.pkce = { verifier, state };
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: SF_CLIENT_ID,
    redirect_uri: SF_CALLBACK_URL,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
  });
  req.session.save(() => res.redirect(`${SF_LOGIN_URL}/services/oauth2/authorize?${q}`));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error_description } = req.query;
  const p = req.session.pkce;
  if (error_description) return res.status(400).send(`Login failed: ${error_description}`);
  if (!p || p.state !== state) return res.status(400).send('Invalid login state. Please try again.');
  try {
    const t = await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: SF_CALLBACK_URL, code_verifier: p.verifier,
    });
    req.session.access = t.access_token;
    req.session.refresh = t.refresh_token;
    req.session.instance = t.instance_url;
    delete req.session.pkce;
    req.session.save(() => res.redirect('/'));
  } catch (e) {
    res.status(400).send(`Login failed: ${e.message}`);
  }
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---------- API ----------
app.get('/api/me', (req, res) => res.json({ loggedIn: !!req.session.access }));

app.use('/api', (req, res, next) => (req.session.access ? next() : res.status(401).json({ error: 'Not logged in' })));

app.param('obj', (req, res, next, obj) => (OBJECTS[obj] ? next() : res.status(400).json({ error: 'Unsupported object' })));

app.get('/api/:obj/meta', (req, res) => res.json({ fields: OBJECTS[req.params.obj] }));

app.get('/api/:obj', async (req, res) => {
  const { obj } = req.params;
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const cols = ['Id', ...OBJECTS[obj].map((f) => f.n)].join(',');
  const soql = `SELECT ${cols} FROM ${obj} ORDER BY CreatedDate DESC, Id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
  const { status, data } = await sf(req, 'GET', `/query?q=${encodeURIComponent(soql)}`);
  if (status !== 200) return res.status(status).json({ error: errorText(data) });
  const records = data.records.map(({ attributes, ...r }) => r);
  res.json({ records, hasMore: records.length === PAGE_SIZE && offset + PAGE_SIZE < MAX_OFFSET });
});

app.get('/api/:obj/:id', async (req, res) => {
  const { obj, id } = req.params;
  const cols = ['Id', ...OBJECTS[obj].map((f) => f.n)].join(',');
  const { status, data } = await sf(req, 'GET', `/sobjects/${obj}/${encodeURIComponent(id)}?fields=${cols}`);
  if (status !== 200) return res.status(status).json({ error: errorText(data) });
  const { attributes, ...rec } = data;
  res.json(rec);
});

app.post('/api/:obj', async (req, res) => {
  const { status, data } = await sf(req, 'POST', `/sobjects/${req.params.obj}`, cleanBody(req.params.obj, req.body, true));
  if (status !== 201) return res.status(status).json({ error: errorText(data) });
  res.status(201).json({ id: data.id });
});

app.patch('/api/:obj/:id', async (req, res) => {
  const { obj, id } = req.params;
  const { status, data } = await sf(req, 'PATCH', `/sobjects/${obj}/${encodeURIComponent(id)}`, cleanBody(obj, req.body, false));
  if (status !== 204) return res.status(status).json({ error: errorText(data) });
  res.status(204).end();
});

app.delete('/api/:obj/:id', async (req, res) => {
  const { obj, id } = req.params;
  const { status, data } = await sf(req, 'DELETE', `/sobjects/${obj}/${encodeURIComponent(id)}`);
  if (status !== 204) return res.status(status).json({ error: errorText(data) });
  res.status(204).end();
});

// ---------- React build ----------
const dist = path.join(__dirname, 'client', 'dist');
app.use(express.static(dist));
app.use((req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
