/* =========================================================================
   PS Process Explorer  ·  front-end application logic
   Consumes data.json (served) or window.__PSPE_DATA__ (data.js file:// fallback)
   ========================================================================= */
'use strict';

const State = {
  data: null,
  objects: [],
  processAreas: [],
  edges: [],
  procFilter: 'all',
  charts: {},
  depCy: null,
  drawerCy: null,
  custFilters: {},   // column -> wildcard text
  custSearch: '',
  custLocalOnly: false, // Custom Objects: show only local-file objects (hide live SAP)
  isAdmin: false,    // admin key verified -> unlock Edit actions
  l1Filter: null,    // selected Level-1 process area (drill-down)
  sapConnected: false, // green header dot when a live SAP link exists
  teachings: [],     // user corrections that train the assistant
  feedback: [],      // 👎/✕ feedback: demote or hide results for similar questions
  l1Override: {},    // sub-process (L2) -> Process Area (L1) for manually-added objects
};

/* single source of truth for the header connection dot */
function setConnDot() {
  const dot = document.getElementById('connDot');
  if (!dot) return;
  const live = (State.data && State.data.source === 'live') || State.sapConnected;
  dot.classList.toggle('offline', !live);
}

/* ---------- category → colour / group helpers ---------- */
const ABAP_CATS = ['Function Module', 'Class', 'Interface', 'Table Maintenance'];
const BW_CATS = ['BEx Query', 'Planning Sequence', 'Planning Function',
                 'InfoProvider', 'Aggregation Level', 'Filter', 'InfoObject'];
const CAT_COLOR = {
  'Function Module': '#a78bfa', 'Class': '#f472b6', 'Interface': '#c084fc',
  'Table Maintenance': '#818cf8', 'BEx Query': '#22d3ee',
  'Planning Sequence': '#4f8cff', 'Planning Function': '#f5b942',
  'InfoProvider': '#2dd4a7', 'Aggregation Level': '#34d399',
  'Filter': '#a78bfa', 'InfoObject': '#60a5fa',
};

/* ---------- wildcard matcher (supports * and plain substring) ---------- */
function wildcard(pattern, value) {
  value = (value ?? '').toString().toLowerCase();
  pattern = (pattern ?? '').toString().trim().toLowerCase();
  if (!pattern) return true;
  if (pattern.includes('*')) {
    const rx = new RegExp('^' + pattern.split('*')
      .map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return rx.test(value);
  }
  return value.includes(pattern);
}

/* ---------- boot ---------- */
async function boot() {
  let data = null;
  // prefer the server endpoint: it overlays manual additions + admin edits
  try {
    const r = await fetch('/api/data', { cache: 'no-store' });
    if (r.ok) data = await r.json();
  } catch (e) { /* not served — fall through */ }
  if (!data) {
    try {
      const r = await fetch('data.json', { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch (e) { /* file:// — fall through */ }
  }
  if (!data && window.__PSPE_DATA__) data = window.__PSPE_DATA__;
  if (!data) { document.body.innerHTML = '<div class="empty">Could not load data.json. Run <b>build_data.py</b> first or start the server (<b>python app.py</b>).</div>'; return; }
  applyData(data);
  initTabs();
  initProcess();
  initTech();
  initCustom();
  initDrawer();
  initSapModal();
  initAssistant();
  initAdmin();
  initFootfall();
  initAddForm();
}

/* ===================== ADD OBJECT FORM ===================== */
const ABAP_ADD_CATS = ['Function Module', 'Class', 'Interface', 'Program', 'Table Maintenance', 'Method', 'Structure', 'Enhancement'];
const BW_ADD_CATS = ['BEx Query', 'Planning Sequence', 'Planning Function', 'Filter', 'InfoProvider', 'Aggregation Level', 'InfoObject', 'Transformation'];

function setAddStatus(msg, kind) {
  const el = document.getElementById('addStatus'); if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.textContent = msg;
  el.style.color = kind === 'err' ? '#ffb3bd' : (kind === 'ok' ? '#8fe3a8' : 'var(--muted)');
}

function initAddForm() {
  const modal = document.getElementById('addModal'); if (!modal) return;
  const domain = document.getElementById('addDomain');
  const cat = document.getElementById('addCategory');
  const l1 = document.getElementById('addL1');
  const subList = document.getElementById('addSubList');
  const fillCats = () => {
    const arr = domain.value === 'BW' ? BW_ADD_CATS : ABAP_ADD_CATS;
    cat.innerHTML = arr.map(c => `<option>${esc(c)}</option>`).join('');
  };
  const fillSubs = () => {
    const subs = [...new Set((State.processAreas || []).filter(p => getL1(p.name) === l1.value).map(p => p.name))].sort();
    subList.innerHTML = subs.map(s => `<option value="${esc(s)}">`).join('');
  };
  domain.addEventListener('change', fillCats);
  l1.addEventListener('change', fillSubs);
  document.getElementById('addClose').addEventListener('click', () => modal.classList.remove('open'));
  document.getElementById('addCancel').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  document.getElementById('addSave').addEventListener('click', saveAddForm);
}

function openAddForm() {
  const modal = document.getElementById('addModal'); if (!modal) return;
  const domain = document.getElementById('addDomain');
  const cat = document.getElementById('addCategory');
  const l1 = document.getElementById('addL1');
  const subList = document.getElementById('addSubList');
  // L1 dropdown (exclude the catch-all "Other")
  l1.innerHTML = Object.keys(L1_META).filter(n => n !== 'Other').map(n => `<option>${esc(n)}</option>`).join('');
  domain.value = 'ABAP';
  cat.innerHTML = ABAP_ADD_CATS.map(c => `<option>${esc(c)}</option>`).join('');
  const subs = [...new Set((State.processAreas || []).filter(p => getL1(p.name) === l1.value).map(p => p.name))].sort();
  subList.innerHTML = subs.map(s => `<option value="${esc(s)}">`).join('');
  ['addName', 'addProcess', 'addDesc', 'addAuthor', 'addPackage'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('addAuthor').value = (State.assistant && State.assistant.user) || '';
  setAddStatus('', '');
  modal.classList.add('open');
  setTimeout(() => document.getElementById('addName').focus(), 60);
}

async function saveAddForm() {
  const v = id => document.getElementById(id).value.trim();
  const name = v('addName').toUpperCase();
  const process = v('addProcess');
  if (!/^[ZY]/.test(name)) { setAddStatus('Object name must start with Z or Y.', 'err'); return; }
  if (!process) { setAddStatus('Please choose or type a Sub-Process area.', 'err'); return; }
  const btn = document.getElementById('addSave');
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Saving…';
  try {
    const body = {
      name,
      domain: v('addDomain'),
      category: v('addCategory'),
      l1: v('addL1'),
      process,
      description: v('addDesc'),
      author: v('addAuthor'),
      package: v('addPackage')
    };
    const r = await fetch('/api/objects/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const res = await r.json().catch(() => ({}));
    if (r.ok && res.ok) {
      try {
        const dr = await fetch('/api/data', { cache: 'no-store' });
        if (dr.ok) { applyData(await dr.json()); initProcess(); renderCustTable(); }
      } catch (e) { }
      document.getElementById('addModal').classList.remove('open');
      toast(`It's updated to the Local files · ${name} → ${body.l1} › ${process}`);
    } else {
      setAddStatus(res.error || 'Could not add the object.', 'err');
    }
  } catch (e) {
    setAddStatus('Could not reach the backend.', 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

/* ===================== ADMIN EDIT (Category / Process / Primary) ===================== */
function initEditForm() {
  const modal = document.getElementById('editModal');
  if (!modal) return;
  const close = () => modal.classList.remove('open');
  document.getElementById('editClose').addEventListener('click', close);
  document.getElementById('editCancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.getElementById('editSave').addEventListener('click', saveEditForm);
}

function openEditForm(name) {
  if (!State.isAdmin) return;
  const modal = document.getElementById('editModal');
  if (!modal) return;
  const o = State.objects.find(x => x.name === name) ||
            State.objects.find(x => (x.name || '').toUpperCase() === (name || '').toUpperCase());
  if (!o) { toast('Object not found: ' + name, true); return; }

  const l1Now = o.primaryProcess || getL1(o.process);
  State.editing = {
    name: o.name,
    before: { category: o.category || '', process: o.process || '', l1: l1Now },
  };

  // category options for the object's domain (keep the current value even if custom)
  const cats = (o.domain === 'BW' ? BW_ADD_CATS : ABAP_ADD_CATS).slice();
  if (o.category && !cats.includes(o.category)) cats.unshift(o.category);
  const catSel = document.getElementById('editCategory');
  catSel.innerHTML = cats.map(c => `<option ${c === o.category ? 'selected' : ''}>${esc(c)}</option>`).join('');

  // L1 (Primary Process) options
  const l1Sel = document.getElementById('editL1');
  l1Sel.innerHTML = Object.keys(L1_META).map(n => `<option ${n === l1Now ? 'selected' : ''}>${esc(n)}</option>`).join('');

  // sub-process suggestions (all existing) + current value
  const subs = [...new Set(State.objects.map(x => x.process).filter(Boolean))].sort();
  document.getElementById('editSubList').innerHTML = subs.map(s => `<option value="${esc(s)}">`).join('');
  document.getElementById('editProcess').value = o.process || '';

  document.getElementById('editName').textContent = o.name;
  setEditStatus('', '');
  modal.classList.add('open');
  setTimeout(() => catSel.focus(), 60);
}

function setEditStatus(msg, kind) {
  const el = document.getElementById('editStatus'); if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.textContent = msg;
  el.style.color = kind === 'err' ? '#ffb3bd' : (kind === 'ok' ? '#8fe3a8' : 'var(--muted)');
}

async function saveEditForm() {
  if (!State.editing) return;
  const v = id => document.getElementById(id).value.trim();
  const process = v('editProcess');
  if (!process) { setEditStatus('Process Area is required.', 'err'); return; }
  const after = { category: v('editCategory'), process, l1: v('editL1') };
  const btn = document.getElementById('editSave');
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Saving…';
  try {
    const r = await fetch('/api/objects/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': State.adminKey || '' },
      body: JSON.stringify({
        name: State.editing.name,
        category: after.category, process: after.process, l1: after.l1,
        before: State.editing.before,
        by: State.adminUser || 'admin',
      }),
    });
    if (r.status === 403) { setEditStatus('Admin key required or invalid.', 'err'); return; }
    const res = await r.json().catch(() => ({}));
    if (r.ok && res.ok && res.data) {
      applyData(res.data);
      initProcess(); renderCustTable(); renderCustPackages();
      document.getElementById('editModal').classList.remove('open');
      const nch = Object.keys(res.changes || {}).length;
      toast(`Updated & logged · ${State.editing.name}${nch ? ` (${nch} field${nch > 1 ? 's' : ''})` : ''}`);
    } else {
      setEditStatus(res.error || 'Could not save the change.', 'err');
    }
  } catch (e) {
    setEditStatus('Could not reach the backend.', 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

/* ===================== REBUILD (admin: upload source workbooks) ===================== */
async function initRebuild() {
  const wrap = document.getElementById('rbSlots');
  if (!wrap) return;
  let status = null;
  try {
    const r = await fetch('/api/rebuild/status?key=' + encodeURIComponent(State.adminKey || ''));
    if (r.ok) status = await r.json();
  } catch (e) { /* ignore */ }
  const files = (status && status.files) || {};
  const order = ['abap', 'bw', 'bpml'];
  const icons = { abap: '🧱', bw: '📊', bpml: '🗂️' };
  wrap.innerHTML = order.map(slot => {
    const f = files[slot] || {};
    const cur = f.exists
      ? `<div class="rb-cur ok">current: ${esc(f.name)} · ${esc(f.modified || '')} · ${fmtBytes(f.bytes)}</div>`
      : `<div class="rb-cur miss">not present yet</div>`;
    return `<div class="rb-slot" data-slot="${slot}">
      <span class="rb-i">${icons[slot] || '📄'}</span>
      <div class="rb-meta">
        <div class="rb-label">${esc(f.label || slot)}</div>
        <div class="rb-file">→ ${esc(f.name || '')}</div>
        ${cur}
      </div>
      <span class="rb-chosen" data-chosen></span>
      <label class="rb-pick">Choose file<input type="file" accept=".xlsx,.xls"/></label>
    </div>`;
  }).join('');
  if (status && status.packages) document.getElementById('rbPackages').placeholder = status.packages.join(', ');
  State.rebuildFiles = {};
  wrap.querySelectorAll('.rb-slot').forEach(row => {
    const slot = row.dataset.slot;
    const inp = row.querySelector('input[type=file]');
    inp.addEventListener('change', () => {
      const f = inp.files[0];
      State.rebuildFiles[slot] = f || null;
      row.querySelector('[data-chosen]').textContent = f ? '✓ ' + f.name : '';
    });
  });
  document.getElementById('rbReset').onclick = () => { setRbStatus('', ''); initRebuild(); };
  document.getElementById('rbRun').onclick = runRebuild;
  const gen = document.getElementById('rbGen');
  if (gen && State.data) gen.textContent = 'current data generated: ' + (State.data.generated || '—');
}

async function runRebuild() {
  const files = State.rebuildFiles || {};
  const pk = document.getElementById('rbPackages').value.trim();
  const chosen = Object.keys(files).filter(k => files[k]);
  if (!chosen.length && !pk) { setRbStatus('Choose at least one Excel file (or set packages).', 'err'); return; }
  const fd = new FormData();
  chosen.forEach(k => fd.append(k, files[k]));
  if (pk) fd.append('packages', pk);
  fd.append('by', State.adminUser || 'admin');
  const btn = document.getElementById('rbRun');
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Rebuilding…';
  setRbStatus('Uploading workbook(s) and rebuilding…', '');
  try {
    const r = await fetch('/api/rebuild?key=' + encodeURIComponent(State.adminKey || ''), {
      method: 'POST', headers: { 'X-Admin-Key': State.adminKey || '' }, body: fd,
    });
    if (r.status === 403) { setRbStatus('Admin key required or invalid.', 'err'); return; }
    const res = await r.json().catch(() => ({}));
    if (r.ok && res.ok && res.data) {
      applyData(res.data);
      initProcess(); initTech(); buildCustHeader(); renderCustTable(); renderCustPackages();
      setRbStatus('✅ Rebuild complete — the platform data has been overwritten.', 'ok');
      renderRbResult(res);
      toast(`Platform rebuilt · ${res.summary.objects} objects`);
      initRebuild();
    } else {
      setRbStatus(res.error || 'Rebuild failed.', 'err');
    }
  } catch (e) {
    setRbStatus('Could not reach the backend.', 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

function renderRbResult(res) {
  const el = document.getElementById('rbResult'); if (!el) return;
  const s = res.summary || {};
  const saved = res.saved || {};
  const rows = [
    `<div class="li"><span class="lk">Generated</span><b>${esc(s.generated || '—')}</b></div>`,
    `<div class="li"><span class="lk">Objects</span><b>${s.objects || 0}</b></div>`,
    `<div class="li"><span class="lk">Process areas</span><b>${s.processAreas || 0}</b></div>`,
    `<div class="li"><span class="lk">Packages</span><b>${esc((s.packages || []).join(', '))}</b></div>`,
  ];
  Object.entries(saved).forEach(([k, v]) =>
    rows.push(`<div class="li"><span class="lk">Uploaded · ${esc(k)}</span><b>${esc(v.uploaded)}</b></div>`));
  el.innerHTML = rows.join('');
}

function setRbStatus(msg, kind) {
  const el = document.getElementById('rbStatus'); if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block'; el.textContent = msg;
  el.style.color = kind === 'err' ? '#ffb3bd' : (kind === 'ok' ? '#8fe3a8' : 'var(--muted)');
}

function fmtBytes(n) {
  n = n || 0;
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
}

/* footfall: count clicks and flush periodically + on page hide */
function initFootfall() {
  let clicks = 0;
  document.addEventListener('click', () => { clicks++; }, true);
  const flush = () => {
    if (clicks <= 0) return;
    const n = clicks; clicks = 0;
    const body = JSON.stringify({ type: 'click', n, user: (State.assistant && State.assistant.user) || '' });
    try {
      if (navigator.sendBeacon)
        navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      else
        fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
    } catch (e) {}
  };
  setInterval(flush, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  track('visit');
}

/* fire-and-forget usage event */
function track(type, fields) {
  try {
    fetch('/api/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify(Object.assign({ type, user: (State.assistant && State.assistant.user) || '' }, fields || {})),
    }).catch(() => {});
  } catch (e) {}
}

function applyData(data) {
  State.data = data;
  State.objects = data.objects || [];
  State.processAreas = data.processAreas || [];
  State.edges = data.edges || [];
  // rename the catch-all "Unassigned" process area to "BW Objects" everywhere
  const RENAME = { 'Unassigned': 'BW Objects' };
  State.processAreas.forEach(p => { if (RENAME[p.name]) p.name = RENAME[p.name]; });
  State.objects.forEach(o => { if (RENAME[o.process]) o.process = RENAME[o.process]; });
  // manual objects can carry an L1 so their new sub-process shows under it
  State.l1Override = {};
  State.objects.forEach(o => { if (o.l1 && o.process) State.l1Override[o.process] = o.l1; });
  // stamp each object's Primary Process (Level-1 tile) for the Custom table
  State.objects.forEach(o => { o.primaryProcess = getL1(o.process); });
  State.edges.forEach(e => {
    if (RENAME[e.source]) e.source = RENAME[e.source];
    if (RENAME[e.target]) e.target = RENAME[e.target];
  });
  // env / connection state
  document.getElementById('envText').textContent = data.environment || 'SAP MS1';
  setConnDot();
  if ((!data.bpml || !data.bpml.length)) {
    const n = document.getElementById('bpmlNote'); if (n) n.style.display = 'flex';
  }
}

/* ===================== TABS ===================== */
function initTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const v = t.dataset.view;
      document.getElementById('view-' + v).classList.add('active');
      track('tab', { view: v });
      if (v === 'depmap') renderDepGraph();
      if (v === 'admin') renderAdminCharts();
    });
  });
}

/* ===================== PS PROCESS ===================== */
function initProcess() {
  const custom = State.objects.filter(o => o.custom);
  const abap = custom.filter(o => o.domain === 'ABAP').length;
  const bw = custom.filter(o => o.domain === 'BW').length;
  const flagged = State.objects.filter(o => /delete|review/i.test(o.validity || '')).length;

  setText('kProc', State.processAreas.length);
  setText('kCustom', custom.length);
  setText('kAbap', abap);
  setText('kBw', bw);
  setText('kFlag', flagged);
  setText('bProc', State.processAreas.length);
  setText('bCustom', custom.length);

  buildTiles();

  document.getElementById('procSearch').addEventListener('input', buildTiles);
  document.getElementById('procSort').addEventListener('change', buildTiles);
  document.querySelectorAll('[data-pf]').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('[data-pf]').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); State.procFilter = c.dataset.pf; buildTiles();
  }));
}

function buildCharts() {
  /* Home-page charts (Objects by Category / ABAP vs BW / Validity) removed by request. */
}

/* ---------- Home-page tiles hidden by request ---------- */
const HIDDEN_TILE_NAMES = new Set(['OBSELETE', 'OBSOLETE', 'NWS', 'DV', 'UPDATE DOMAIN', 'AO', 'IRQ']);
function isHiddenTile(name) {
  const n = (name || '').trim().toUpperCase();
  return n.includes('LUMIRA') || HIDDEN_TILE_NAMES.has(n);
}

/* ---------- Level-1 process areas (from mapping file, column D order) ---------- */
const L1_META = {
  'Project Set up':    { seq: 1, icon: '🚀' },
  'Project Planning':  { seq: 2, icon: '🗂️' },
  'Project Forecast':  { seq: 3, icon: '📈' },
  'Project Execution': { seq: 4, icon: '⚙️' },
  'Project Closure':   { seq: 5, icon: '🏁' },
  'Reporting':         { seq: 6, icon: '📊' },
  'Livesite':          { seq: 7, icon: '🛠️' },
  'Other':             { seq: 99, icon: '📁' },
};
// Sub Process Area (L2)  ->  Process Area (L1)
const L2_TO_L1 = {
  'Unassigned': 'Livesite', 'BW Objects': 'Livesite', 'API': 'Livesite',
  'Unmapped (SAP MS1)': 'Other',
  'Engineering': 'Livesite', 'Table maintenace': 'Livesite', 'AIF': 'Livesite',
  'Load CPM master Data': 'Livesite', 'Update Delivery Location': 'Livesite',
  'Utility to Delete Cube DSO and PSA': 'Livesite',
  'Utility to Delete cube data for BP Merge': 'Livesite',
  'Variant create Utility': 'Livesite', 'Cutover': 'Livesite', 'Old query': 'Livesite',
  'Job': 'Livesite', 'BADI': 'Livesite',
  'Copy FF Revenue from CFP to CB/DB (Only for Bug Fixes)': 'Livesite',
  'Customer Details': 'Livesite', 'Review': 'Livesite', 'Utility': 'Livesite',
  'Plan 2.0': 'Project Planning', 'Threshold': 'Project Planning',
  'FCR': 'Project Planning', 'Cost rate': 'Project Planning', 'GRM': 'Project Planning',
  'Subson FF Program': 'Project Planning', 'CR Details': 'Project Planning',
  'Valuation': 'Project Planning', 'Business': 'Project Planning',
  'Planning': 'Project Planning', 'CPM Update RR': 'Project Planning',
  'Common PS': 'Project Planning', 'Deal create/Amend': 'Project Planning',
  'GRM SAP Interface': 'Project Planning', 'P2.0': 'Project Planning',
  'Planning Seq to copy Misaligned CR data to DB': 'Project Planning',
  'RR valuation': 'Project Planning',
  'Repost Units Forecast on BP 00000000': 'Project Planning',
  'STAFFING': 'Project Planning', 'SUBCON': 'Project Planning',
  'F2.0': 'Project Forecast', 'Forecast 2.0': 'Project Forecast',
  'Forecast': 'Project Forecast',
  'Release&Activate': 'Project Set up', 'Deal create': 'Project Set up',
  'Deal create/Amend/PJMXP UI': 'Project Set up',
  'Amendments': 'Project Execution', 'PICM': 'Project Execution',
  'Amendment': 'Project Execution', 'Date Changes': 'Project Execution',
  'DECO': 'Project Closure', 'Sync EAC to Plan : DECO': 'Project Closure',
  'Monitoring': 'Reporting', 'CPM': 'Reporting', 'Financials': 'Reporting',
  'Read Actual': 'Reporting',
};
function getL1(l2name) {
  return (State.l1Override && State.l1Override[l2name]) || L2_TO_L1[l2name] || 'Other';
}

/* aggregate visible L2 areas into their L1 groups */
function l1Groups() {
  const groups = {};
  State.processAreas.forEach(p => {
    if (isHiddenTile(p.name)) return;
    const l1 = getL1(p.name);
    if (!groups[l1]) groups[l1] = {
      name: l1, seq: (L1_META[l1] || {}).seq || 99,
      icon: (L1_META[l1] || {}).icon || '📁',
      total: 0, abap: 0, bw: 0, subs: [],
    };
    const g = groups[l1];
    g.total += p.total || 0; g.abap += p.abap || 0; g.bw += p.bw || 0;
    g.subs.push(p);
  });
  return Object.values(groups).sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
}

function buildTiles() {
  const el = document.getElementById('tiles');
  const crumb = document.getElementById('procCrumb');
  const q = document.getElementById('procSearch').value;
  const sort = document.getElementById('procSort').value;

  // ---------- Level 1 view (no drill selected) ---------- //
  if (!State.l1Filter) {
    if (crumb) crumb.style.display = 'none';
    let groups = l1Groups();
    if (q.trim()) groups = groups.filter(g => wildcard(q, g.name));
    if (!groups.length) { el.innerHTML = '<div class="empty">No process areas match your filter.</div>'; return; }
    el.innerHTML = groups.map(g => {
      const aw = g.total ? Math.round(g.abap / g.total * 100) : 0;
      const bw = g.total ? 100 - aw : 0;
      return `<div class="tile l1" data-l1="${esc(g.name)}">
        <div class="t-top">
          <div style="display:flex;gap:11px;align-items:center">
            <div class="t-seq">${g.seq}</div>
            <div><div class="t-name"><span class="t-icon">${g.icon}</span> ${esc(g.name)}</div>
              <div class="t-sub">${g.subs.length} sub-process${g.subs.length !== 1 ? 'es' : ''}</div></div>
          </div>
          <div class="t-total">${g.total}</div>
        </div>
        <div class="t-bar"><i class="a" style="width:${aw}%"></i><i class="b" style="width:${bw}%"></i></div>
        <div class="t-legend"><span>◼ ABAP <b>${g.abap}</b></span><span style="color:var(--bw)">◼ BW <b>${g.bw}</b></span></div>
        <div class="t-open">Open ›</div>
      </div>`;
    }).join('');
    el.querySelectorAll('.tile').forEach(t =>
      t.addEventListener('click', () => { State.l1Filter = t.dataset.l1; buildTiles(); }));
    return;
  }

  // ---------- Level 2 view (drilled into an L1) ---------- //
  if (crumb) {
    crumb.style.display = 'flex';
    crumb.innerHTML =
      `<div class="back" id="crumbBack">‹ All Processes</div>` +
      `<div class="path">${(L1_META[State.l1Filter] || {}).icon || ''} <b>${esc(State.l1Filter)}</b> · sub-process areas</div>`;
    crumb.querySelector('#crumbBack').addEventListener('click',
      () => { State.l1Filter = null; buildTiles(); });
  }

  let list = State.processAreas.filter(p => !isHiddenTile(p.name) && getL1(p.name) === State.l1Filter);
  if (State.procFilter === 'abap') list = list.filter(p => p.abap > 0);
  if (State.procFilter === 'bw') list = list.filter(p => p.bw > 0);
  if (q.trim()) list = list.filter(p => wildcard(q, p.name));
  list.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (b[sort] || 0) - (a[sort] || 0));

  if (!list.length) { el.innerHTML = '<div class="empty">No sub-process areas match your filter.</div>'; return; }
  el.innerHTML = list.map(p => {
    const total = p.total || 0;
    const aw = total ? Math.round(p.abap / total * 100) : 0;
    const bw = total ? 100 - aw : 0;
    const cats = Object.entries(p.counts || {}).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<span class="mini">${k}: <b>${v}</b></span>`).join('');
    return `<div class="tile" data-proc="${esc(p.name)}">
      <div class="t-top"><div class="t-name">${esc(p.name)}</div><div class="t-total">${total}</div></div>
      <div class="t-bar"><i class="a" style="width:${aw}%"></i><i class="b" style="width:${bw}%"></i></div>
      <div class="t-legend"><span>◼ ABAP <b>${p.abap}</b></span><span style="color:var(--bw)">◼ BW <b>${p.bw}</b></span></div>
      <div class="t-cats">${cats}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.tile').forEach(t =>
    t.addEventListener('click', () => openDrawer(t.dataset.proc)));
}

/* ===================== TREE BUILDING ===================== */
function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function valBadge(v) {
  if (!v) return '';
  const t = v.toLowerCase();
  const cls = t.includes('valid') ? 'v-valid' : t.includes('delete') ? 'v-delete' :
              t.includes('review') ? 'v-review' : '';
  return cls ? `<span class="badge-val ${cls}">${esc(v)}</span>` : '';
}

function node(label, children, opts = {}) {
  const hasKids = children && children.length;
  const collapsed = opts.collapsed ? ' collapsed' : '';
  return `<div class="tnode${collapsed}">
    <div class="row ${hasKids ? 'click' : ''}">
      ${hasKids ? '<span class="caret">▾</span>' : '<span class="caret" style="opacity:.15">•</span>'}
      ${label}
    </div>
    ${hasKids ? `<div class="children">${children.join('')}</div>` : ''}
  </div>`;
}

function objLabel(o, pillCls, pillTxt) {
  const desc = o.description ? `<span class="tn-desc">${esc(o.description)}</span>` : '';
  return `<span class="pill ${pillCls}">${pillTxt}</span>
    <span class="tn-name mono">${esc(o.name)}</span>${desc}${valBadge(o.validity)}`;
}

/* Build ABAP tree for a set of objects: category → object → (method/tech leaf) */
function buildAbapTree(objs) {
  const abap = objs.filter(o => o.domain === 'ABAP');
  if (!abap.length) return '<div class="empty">No custom ABAP objects for this scope.</div>';
  const byCat = groupBy(abap, o => o.category);
  const order = ['Function Module', 'Class', 'Interface', 'Table Maintenance'];
  const cats = Object.keys(byCat).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return cats.map(cat => {
    const items = byCat[cat].sort((a, b) => a.name.localeCompare(b.name)).map(o => {
      const pill = cat === 'Class' ? 'cl' : cat === 'Function Module' ? 'fm' : 'abap';
      // leaf: package / author / technical
      const leaves = [];
      if (o.package) leaves.push(node(`<span class="muted">📦 package</span> <span class="mono">${esc(o.package)}</span>`));
      if (o.author) leaves.push(node(`<span class="muted">👤 author</span> ${esc(o.author)}`));
      if (o.technical) leaves.push(node(`<span class="muted">⚙ calls</span> <span class="mono">${esc(o.technical)}</span>`));
      return node(objLabel(o, pill, cat === 'Class' ? 'CL' : cat === 'Function Module' ? 'FM' : 'ABAP'), leaves, { collapsed: true });
    });
    return node(`<b>${esc(cat)}</b> <span class="muted">(${byCat[cat].length})</span>`, items);
  }).join('');
}

/* Build BW tree: Planning Sequence → Planning Function → Filter/Formula ; plus standalone queries */
function buildBwTree(objs, scopeNames) {
  const bw = objs.filter(o => o.domain === 'BW');
  if (!bw.length) return '<div class="empty">No custom BW objects for this scope.</div>';
  const names = new Set(bw.map(o => o.name));
  const seqs = bw.filter(o => o.category === 'Planning Sequence');
  const funcs = bw.filter(o => o.category === 'Planning Function');
  const edges = State.edges;
  const out = [];

  // Planning sequence branches
  seqs.sort((a, b) => a.name.localeCompare(b.name)).forEach(seq => {
    // functions linked to this seq
    const linkedFuncNames = edges.filter(e => e.kind === 'planseq-planfunc' && e.source === seq.name).map(e => e.target);
    const funcNodes = [];
    const seen = new Set();
    linkedFuncNames.forEach(fn => {
      const f = funcs.find(x => x.name === fn) || State.objects.find(x => x.name === fn && x.category === 'Planning Function');
      if (!f || seen.has(fn)) return; seen.add(fn);
      const filters = edges.filter(e => e.kind === 'planfunc-filter' && e.source === fn).map(e => e.target);
      const kids = filters.map(fl => node(`<span class="pill bw">FLT</span> <span class="mono">${esc(fl)}</span>`));
      if (f.technical) kids.push(node(`<span class="muted">⚙ ABAP/Fox</span> <span class="mono">${esc(f.technical)}</span>`));
      funcNodes.push(node(objLabel(f, 'pf', 'PF'), kids, { collapsed: true }));
    });
    // filters directly on seq
    const seqFilters = edges.filter(e => e.kind === 'planseq-filter' && e.source === seq.name).map(e => e.target);
    seqFilters.forEach(fl => funcNodes.push(node(`<span class="pill bw">FLT</span> <span class="mono">${esc(fl)}</span>`)));
    out.push(node(objLabel(seq, 'ps', 'PS'), funcNodes, { collapsed: true }));
  });

  // Standalone planning functions (not under any listed seq)
  const usedFuncs = new Set(edges.filter(e => e.kind === 'planseq-planfunc').map(e => e.target));
  const orphanF = funcs.filter(f => !usedFuncs.has(f.name));
  if (orphanF.length) {
    out.push(node(`<b>Planning Functions</b> <span class="muted">(standalone ${orphanF.length})</span>`,
      orphanF.sort((a, b) => a.name.localeCompare(b.name)).map(f => {
        const kids = f.technical ? [node(`<span class="muted">⚙ ABAP/Fox</span> <span class="mono">${esc(f.technical)}</span>`)] : [];
        return node(objLabel(f, 'pf', 'PF'), kids, { collapsed: true });
      })));
  }

  // Queries & other BW categories
  ['BEx Query', 'InfoProvider', 'Aggregation Level', 'InfoObject', 'Filter'].forEach(cat => {
    const items = bw.filter(o => o.category === cat);
    if (!items.length) return;
    out.push(node(`<b>${esc(cat)}</b> <span class="muted">(${items.length})</span>`,
      items.sort((a, b) => a.name.localeCompare(b.name)).map(o => {
        const kids = [];
        if (o.technical) kids.push(node(`<span class="muted">⚙ tech</span> <span class="mono">${esc(o.technical)}</span>`));
        if (o.author) kids.push(node(`<span class="muted">👤</span> ${esc(o.author)}`));
        return node(objLabel(o, 'bw', 'BW'), kids, { collapsed: true });
      }), { collapsed: cat !== 'BEx Query' }));
  });

  return out.join('');
}

function groupBy(arr, fn) {
  return arr.reduce((m, x) => { const k = fn(x); (m[k] = m[k] || []).push(x); return m; }, {});
}

/* delegate caret toggling for all trees */
document.addEventListener('click', e => {
  const row = e.target.closest('.tnode > .row.click');
  if (!row) return;
  row.parentElement.classList.toggle('collapsed');
});

/* ===================== TECHNICAL OBJECTS TAB ===================== */
function initTech() {
  const sel = document.getElementById('techProc');
  State.processAreas.forEach(p => sel.add(new Option(`${p.name} (${p.total})`, p.name)));
  const render = () => {
    const proc = sel.value;
    let objs = State.objects.filter(o => o.custom);
    if (proc) objs = objs.filter(o => o.process === proc);
    document.getElementById('abapTree').innerHTML = buildAbapTree(objs);
    document.getElementById('bwTree').innerHTML = buildBwTree(objs);
    applyTechSearch();
  };
  sel.addEventListener('change', render);
  document.getElementById('techSearch').addEventListener('input', applyTechSearch);
  document.getElementById('techExpand').addEventListener('click', () =>
    document.querySelectorAll('#techGrid .tnode').forEach(n => n.classList.remove('collapsed')));
  document.getElementById('techCollapse').addEventListener('click', () =>
    document.querySelectorAll('#techGrid .tnode').forEach(n => { if (n.querySelector('.children')) n.classList.add('collapsed'); }));
  render();
}

function applyTechSearch() {
  const q = document.getElementById('techSearch').value.trim();
  document.querySelectorAll('#techGrid .tnode').forEach(n => {
    const nameEl = n.querySelector(':scope > .row .tn-name');
    n.style.display = '';
  });
  if (!q) return;
  document.querySelectorAll('#techGrid .tree > .tnode').forEach(root => filterTree(root, q));
}
function filterTree(nodeEl, q) {
  const name = nodeEl.querySelector(':scope > .row')?.textContent || '';
  const kids = [...nodeEl.querySelectorAll(':scope > .children > .tnode')];
  let anyKid = false;
  kids.forEach(k => { if (filterTree(k, q)) anyKid = true; });
  const self = wildcard(q, name);
  const show = self || anyKid;
  nodeEl.style.display = show ? '' : 'none';
  if (anyKid) nodeEl.classList.remove('collapsed');
  return show;
}

/* ===================== DRAWER (process detail) ===================== */
function initDrawer() {
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  document.getElementById('overlay').addEventListener('click', e => {
    if (e.target.id === 'overlay') closeDrawer();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
}
function openDrawer(procName) {
  const p = State.processAreas.find(x => x.name === procName) || { name: procName, counts: {} };
  const objs = State.objects.filter(o => o.process === procName && o.custom);
  track('drawer', { proc: procName });
  document.getElementById('dTitle').textContent = procName;
  document.getElementById('dSub').textContent =
    `${objs.length} custom objects · ${p.abap || 0} ABAP · ${p.bw || 0} BW · package scope ZPS_PROJ_EXEC / Z_PROF_SERVICES / ZCPM`;
  const flagged = objs.filter(o => /delete|review/i.test(o.validity || '')).length;
  document.getElementById('dKpis').innerHTML = [
    ['Total', objs.length, ''], ['ABAP', p.abap || 0, 'color:var(--abap)'],
    ['BW-IP', p.bw || 0, 'color:var(--bw)'], ['Flagged', flagged, 'color:var(--warn)']
  ].map(([l, v, s]) => `<div class="d-kpi"><div class="v" style="${s}">${v}</div><div class="l">${l}</div></div>`).join('');
  document.getElementById('dAbap').innerHTML = buildAbapTree(objs);
  document.getElementById('dBw').innerHTML = buildBwTree(objs);
  document.getElementById('overlay').classList.add('open');
  setTimeout(() => renderDrawerGraph(procName, objs), 60);
}
function closeDrawer() {
  document.getElementById('overlay').classList.remove('open');
  if (State.drawerCy) { State.drawerCy.destroy(); State.drawerCy = null; }
}

/* ===================== CYTOSCAPE GRAPHS ===================== */
if (window.cytoscape && window.cytoscapeDagre) {
  try { cytoscape.use(window.cytoscapeDagre); } catch (e) { /* already registered */ }
}
function hasDagre() { return !!(window.cytoscapeDagre); }

function nodeColor(cat) {
  if (cat === 'Planning Sequence') return '#4f8cff';
  if (cat === 'Planning Function') return '#f5b942';
  if (cat === 'Filter') return '#a78bfa';
  if (cat === 'BEx Query') return '#22d3ee';
  if (cat === 'Aggregation Level' || cat === 'InfoProvider') return '#2dd4a7';
  if (['Function Module', 'Class', 'Interface', 'Table Maintenance', 'Method', 'Function Group'].includes(cat)) return '#f472b6';
  return '#94a3b8';
}
const cyStyle = [
  { selector: 'node', style: {
      'background-color': 'data(color)', 'label': 'data(label)', 'color': '#dfe7ff',
      'font-size': 10, 'text-valign': 'bottom', 'text-margin-y': 5,
      'width': 'data(size)', 'height': 'data(size)',
      'text-max-width': 120, 'text-wrap': 'ellipsis', 'border-width': 2, 'border-color': '#0b1020',
      'text-background-color': '#0b1020', 'text-background-opacity': 0.55,
      'text-background-padding': 2, 'text-background-shape': 'roundrectangle' } },
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#fff' } },
  { selector: 'node.faded', style: { 'opacity': 0.08, 'text-opacity': 0 } },
  { selector: 'node.focus', style: { 'border-color': '#fff', 'border-width': 3 } },
  { selector: 'edge', style: {
      'width': 1.4, 'line-color': '#3a5488', 'target-arrow-color': '#3a5488',
      'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'curve-style': 'bezier', 'opacity': 0.8 } },
  { selector: 'edge.faded', style: { 'opacity': 0.04 } },
  { selector: '.hi', style: { 'line-color': '#4f8cff', 'target-arrow-color': '#4f8cff', 'width': 2.6, 'opacity': 1 } },
];

function buildElements(objs, opts = {}) {
  const nameSet = new Set(objs.map(o => o.name));
  const deg = {};
  const bump = n => { deg[n] = (deg[n] || 0) + 1; };
  const extEdges = [];
  State.edges.forEach(e => {
    if (nameSet.has(e.source) && nameSet.has(e.target)) { bump(e.source); bump(e.target); extEdges.push(e); }
    else if (nameSet.has(e.source) && e.target && /^[ZY]/i.test(e.target)) { bump(e.source); bump(e.target); extEdges.push(e); }
  });
  const sizeFor = n => Math.max(16, Math.min(40, 16 + (deg[n] || 0) * 4));
  const keep = o => !opts.onlyConnected || (deg[o.name] || 0) > 0;
  const nodes = objs.filter(keep).map(o => ({ data: {
    id: o.name, label: o.name, color: nodeColor(o.category), cat: o.category,
    proc: o.process, size: sizeFor(o.name) } }));
  const seen = new Set(nodes.map(n => n.data.id));
  const edges = [];
  extEdges.forEach(e => {
    if (!seen.has(e.target)) {
      seen.add(e.target);
      nodes.push({ data: { id: e.target, label: e.target, color: '#f472b6', cat: 'ABAP', proc: '', size: sizeFor(e.target) } });
    }
    edges.push({ data: { id: e.source + '::' + e.target + '::' + (e.kind || ''), source: e.source, target: e.target } });
  });
  return [...nodes, ...edges];
}

/* clean, non-overlapping layout: dagre (hierarchical) when available, else cose */
function graphLayout(nodeCount) {
  if (hasDagre()) {
    return { name: 'dagre', rankDir: 'LR', nodeSep: 28, rankSep: 90, edgeSep: 12,
             animate: false, padding: 30, fit: true };
  }
  return { name: 'cose', animate: false, padding: 30,
           nodeRepulsion: 9000, idealEdgeLength: 90, componentSpacing: 140,
           nodeOverlap: 20, gravity: 0.25 };
}

/* wire ＋ / － / fit / reset + hover-to-isolate for any cy instance */
function attachGraphControls(cy, ids, infoEl) {
  const zoomBy = f => {
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const set = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  set(ids.zin, () => zoomBy(1.3));
  set(ids.zout, () => zoomBy(1 / 1.3));
  set(ids.fit, () => cy && cy.fit(null, 30));
  set(ids.reset, () => { if (!cy) return; cy.elements().removeClass('faded hi focus');
    cy.layout(graphLayout(cy.nodes().length)).run(); cy.fit(null, 30); });

  // hover-to-isolate declutters dense graphs
  cy.on('mouseover', 'node', evt => {
    const n = evt.target; const nb = n.closedNeighborhood();
    cy.elements().addClass('faded'); nb.removeClass('faded'); nb.edges().addClass('hi'); n.addClass('focus');
  });
  cy.on('mouseout', 'node', () => cy.elements().removeClass('faded hi focus'));
  if (infoEl) infoEl.textContent = `${cy.nodes().length} nodes · ${cy.edges().length} edges`;
}

function renderDrawerGraph(procName, objs) {
  const container = document.getElementById('drawerGraph');
  if (State.drawerCy) { State.drawerCy.destroy(); State.drawerCy = null; }
  const info = document.getElementById('dgInfo');
  const connected = State.sapConnected || (State.assistant && State.assistant.searchMs1);
  let els = buildElements(objs, { onlyConnected: true });
  let nodesOnly = false;
  if (!els.length) {
    // no local edges — if connected, show the objects as standalone nodes so
    // the user can pull real SAP where-used links; else show the hint.
    if (connected && objs.length) { els = buildElements(objs, { onlyConnected: false }); nodesOnly = true; }
    if (!els.length) {
      container.innerHTML = '<div class="empty">No linked dependencies for this process — see the object hierarchy above.</div>';
      if (info) info.textContent = '';
      const b0 = document.getElementById('dgWhereUsed'); if (b0) b0.style.display = 'none';
      return;
    }
  }
  container.innerHTML = '';
  State.drawerCy = cytoscape({
    container, elements: els, style: cyStyle,
    layout: graphLayout(els.length),
    wheelSensitivity: 0.3, minZoom: 0.15, maxZoom: 3,
  });
  State.drawerCy.ready(() => State.drawerCy.fit(null, 30));
  attachGraphControls(State.drawerCy,
    { zin: 'dgZoomIn', zout: 'dgZoomOut', fit: 'dgFit', reset: 'dgReset' }, info);
  if (info && nodesOnly) info.textContent = `${State.drawerCy.nodes().length} objects · click 🔗 where-used for SAP links`;
  // on-demand: load real SAP where-used dependencies when connected
  const wuBtn = document.getElementById('dgWhereUsed');
  if (wuBtn) {
    wuBtn.style.display = connected ? '' : 'none';
    wuBtn.disabled = false; wuBtn.innerHTML = '🔗 where-used';
    wuBtn.onclick = () => enrichWhereUsed(objs);
  }
}

/* pull live where-used edges from SAP and merge them into the flow map */
async function enrichWhereUsed(objs) {
  const cy = State.drawerCy;
  if (!cy) return;
  const names = objs.filter(o => o.custom).map(o => o.name);
  if (!names.length) return;
  const btn = document.getElementById('dgWhereUsed');
  const info = document.getElementById('dgInfo');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> where-used…'; }
  try {
    const r = await fetch('/api/sap/whereused', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    if (!r.ok) throw new Error('http');
    const res = await r.json();
    const edges = res.edges || [];
    if (cy !== State.drawerCy) return;
    let added = 0;
    edges.forEach(e => {
      if (!cy.getElementById(e.target).length) {
        cy.add({ group: 'nodes', data: { id: e.target, label: e.target, color: '#f59e0b', cat: e.type || 'ABAP', proc: '', size: 18 } });
      }
      const id = e.source + '::' + e.target + '::wu';
      if (cy.getElementById(e.source).length && !cy.getElementById(id).length) {
        cy.add({ group: 'edges', data: { id, source: e.source, target: e.target } });
        added++;
      }
    });
    if (added) {
      cy.layout(graphLayout(cy.nodes().length)).run();
      cy.fit(null, 30);
      if (info) info.textContent = `${cy.nodes().length} nodes · ${cy.edges().length} edges · +${added} SAP where-used`;
    } else if (info) {
      info.textContent = `${cy.nodes().length} nodes · no additional SAP where-used links`;
    }
  } catch (e) {
    if (info) info.textContent = 'SAP where-used unavailable (check ⚙ connection)';
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '🔗 where-used'; }
  }
}

function renderDepGraph() {
  const container = document.getElementById('depGraph');
  const procSel = document.getElementById('graphProc');
  if (!procSel.options.length) {
    procSel.innerHTML = '<option value="">All process areas</option>';
    State.processAreas.forEach(p => procSel.add(new Option(`${p.name} (${p.total})`, p.name)));
  }
  const draw = () => {
    const proc = procSel.value;
    let objs = State.objects.filter(o => o.custom);
    if (proc) objs = objs.filter(o => o.process === proc);
    // hide isolated nodes so the map shows real dependencies only
    const els = buildElements(objs, { onlyConnected: true });
    if (State.depCy) { State.depCy.destroy(); State.depCy = null; }
    if (!els.length) {
      container.style.width = ''; container.style.height = '';
      container.innerHTML = '<div class="empty">No linked dependencies to display for this selection.</div>';
      return;
    }
    container.innerHTML = '';
    // size the canvas larger than the viewport so the scrollable wrapper shows
    // a side scrollbar for big graphs (nodes = elements that carry no source)
    const nodeCount = els.filter(e => e.data && e.data.source === undefined).length;
    const scroll = document.getElementById('depScroll');
    const vw = (scroll ? scroll.clientWidth : 1000) - 4;
    const vh = (scroll ? scroll.clientHeight : 640) - 4;
    container.style.width = Math.max(vw, Math.min(5200, nodeCount * 22)) + 'px';
    container.style.height = Math.max(vh, Math.min(3200, nodeCount * 11)) + 'px';
    State.depCy = cytoscape({
      container, elements: els, style: cyStyle,
      layout: graphLayout(els.length),
      wheelSensitivity: 0.3, minZoom: 0.1, maxZoom: 3,
    });
    State.depCy.ready(() => State.depCy.fit(null, 30));
    document.getElementById('graphInfo').textContent =
      `${State.depCy.nodes().length} nodes · ${State.depCy.edges().length} edges`;
    State.depCy.on('tap', 'node', evt => {
      const n = evt.target;
      State.depCy.elements().addClass('faded');
      const nb = n.closedNeighborhood();
      nb.removeClass('faded'); nb.edges().addClass('hi');
    });
    State.depCy.on('tap', evt => { if (evt.target === State.depCy) State.depCy.elements().removeClass('faded hi'); });
  };
  procSel.onchange = draw;
  const zoomBy = f => State.depCy &&
    State.depCy.zoom({ level: State.depCy.zoom() * f,
      renderedPosition: { x: State.depCy.width() / 2, y: State.depCy.height() / 2 } });
  document.getElementById('graphZoomIn').onclick = () => zoomBy(1.3);
  document.getElementById('graphZoomOut').onclick = () => zoomBy(1 / 1.3);
  document.getElementById('graphFit').onclick = () => State.depCy && State.depCy.fit(null, 30);
  document.getElementById('graphReset').onclick = () => { State.depCy && State.depCy.elements().removeClass('faded hi'); draw(); };
  document.getElementById('graphSearch').oninput = e => {
    if (!State.depCy) return; const q = e.target.value.trim();
    State.depCy.elements().removeClass('faded hi');
    if (!q) return;
    const match = State.depCy.nodes().filter(n => wildcard(q, n.data('label')));
    if (match.length) { State.depCy.elements().addClass('faded'); match.removeClass('faded'); match.neighborhood().removeClass('faded'); match.connectedEdges().addClass('hi'); }
  };
  draw();
}

/* ===================== CUSTOM OBJECTS TAB ===================== */
const CUST_COLS = [
  { key: 'name', label: 'Object Name' },
  { key: 'description', label: 'Description' },
  { key: 'category', label: 'Category' },
  { key: 'domain', label: 'Domain' },
  { key: 'primaryProcess', label: 'Primary Process' },
  { key: 'process', label: 'Process Area' },
  { key: 'package', label: 'Package' },
  { key: 'validity', label: 'Validity' },
];

function initCustom() {
  buildCustHeader();
  document.getElementById('custSearch').addEventListener('input', e => { State.custSearch = e.target.value; renderCustTable(); });
  document.getElementById('btnExport').addEventListener('click', exportExcel);
  document.getElementById('btnRefresh').addEventListener('click', refreshFromSap);
  document.getElementById('custBody').addEventListener('click', e => {
    const b = e.target.closest('.btn-edit');
    if (b) openEditForm(b.dataset.name);
  });

  const localTgl = document.getElementById('localOnlyToggle');
  if (localTgl) {
    localTgl.checked = !!State.custLocalOnly;
    localTgl.addEventListener('change', e => {
      State.custLocalOnly = e.target.checked;
      const st = document.getElementById('localOnlyState');
      if (st) { st.textContent = e.target.checked ? 'on' : 'off'; st.classList.toggle('on', e.target.checked); }
      renderCustTable();
    });
  }

  State.custSort = { key: 'name', dir: 1 };
  initEditForm();
  renderCustPackages();
  renderCustTable();
  loadRefreshStatus();
}

/* (re)build the Custom Objects header + per-column filters; adds an admin-only
   Actions column when the admin key is verified */
function buildCustHeader() {
  const labels = document.getElementById('custHeadLabels');
  const filters = document.getElementById('custHeadFilters');
  let L = CUST_COLS.map(c => `<th><div class="th-l" data-sort="${c.key}">${c.label} <span class="muted">⇅</span></div></th>`).join('');
  let F = CUST_COLS.map(c => MULTI_COLS.has(c.key)
    ? `<th><div class="msel" data-col="${c.key}"><button type="button" class="msel-btn"><span class="msel-lbl">All</span><span>▾</span></button></div></th>`
    : `<th><input data-col="${c.key}" placeholder="filter *"/></th>`).join('');
  if (State.isAdmin) { L += `<th><div class="th-l">Actions</div></th>`; F += `<th></th>`; }
  labels.innerHTML = L;
  filters.innerHTML = F;

  filters.querySelectorAll('input[data-col]').forEach(inp =>
    inp.addEventListener('input', () => { State.custFilters[inp.dataset.col] = inp.value; renderCustTable(); }));
  filters.querySelectorAll('.msel .msel-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openMsel(btn.closest('.msel').dataset.col, btn);
    }));
  labels.querySelectorAll('[data-sort]').forEach(th =>
    th.addEventListener('click', () => { sortCust(th.dataset.sort); }));
  CUST_COLS.forEach(c => { if (Array.isArray(State.custFilters[c.key]) && State.custFilters[c.key].length) updateMselLabel(c.key); });
}

/* columns filtered by a multi-select of their unique values */
const MULTI_COLS = new Set(['category', 'domain', 'process', 'primaryProcess', 'package', 'validity']);

/* unique values (with counts) for a column, across the custom objects */
function custUnique(col) {
  const map = new Map();
  State.objects.filter(o => o.custom).forEach(o => {
    const v = (o[col] ?? '').toString();
    map.set(v, (map.get(v) || 0) + 1);
  });
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

/* the shared, body-level popup so it escapes the table's overflow clipping */
function _mselPop() {
  let pop = document.getElementById('mselPop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'mselPop';
    pop.className = 'msel-pop';
    pop.addEventListener('click', e => e.stopPropagation());
    document.body.appendChild(pop);
    document.addEventListener('click', closeMsel);
    window.addEventListener('resize', closeMsel);
    document.querySelector('.tablewrap')?.addEventListener('scroll', closeMsel);
  }
  return pop;
}

function closeMsel() {
  const pop = document.getElementById('mselPop');
  if (pop) { pop.classList.remove('open'); pop._col = null; }
}

function openMsel(col, btn) {
  const pop = _mselPop();
  if (pop.classList.contains('open') && pop._col === col) { closeMsel(); return; }
  pop._col = col;
  const cur = Array.isArray(State.custFilters[col]) ? State.custFilters[col] : [];
  const sel = new Set(cur);
  const vals = custUnique(col);
  pop.innerHTML =
    `<input class="msel-search" placeholder="Search values…"/>
     <div class="msel-actions"><button data-a="all">Select all</button><button data-a="clear">Clear</button></div>
     <div class="msel-list">${vals.map(v => mselOpt(v, sel)).join('') || '<div class="msel-empty">No values</div>'}</div>`;

  const apply = () => {
    const chosen = [...pop.querySelectorAll('.msel-opt input:checked')].map(i => i.value);
    State.custFilters[col] = chosen;
    updateMselLabel(col);
    renderCustTable();
  };
  pop.querySelectorAll('.msel-opt input').forEach(i => i.addEventListener('change', apply));
  pop.querySelector('[data-a="all"]').addEventListener('click', () => {
    pop.querySelectorAll('.msel-list .msel-opt').forEach(o => {
      if (o.style.display !== 'none') o.querySelector('input').checked = true;
    });
    apply();
  });
  pop.querySelector('[data-a="clear"]').addEventListener('click', () => {
    pop.querySelectorAll('.msel-opt input').forEach(i => { i.checked = false; });
    apply();
  });
  const search = pop.querySelector('.msel-search');
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    pop.querySelectorAll('.msel-opt').forEach(o => {
      o.style.display = o.dataset.v.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  search.addEventListener('click', e => e.stopPropagation());

  // position under the button (fixed), then keep on screen
  const r = btn.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.classList.add('open');
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 8);
  let top = r.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
  pop.style.visibility = '';
  setTimeout(() => search.focus(), 0);
}

function mselOpt(v, sel) {
  const label = v.value === '' ? '—' : v.value;
  return `<label class="msel-opt" data-v="${esc(label)}">
    <input type="checkbox" value="${esc(v.value)}" ${sel.has(v.value) ? 'checked' : ''}/>
    <span class="mv">${esc(label)}</span><span class="msel-cnt">${v.count}</span></label>`;
}

function updateMselLabel(col) {
  const m = document.querySelector(`.msel[data-col="${col}"]`);
  if (!m) return;
  const arr = State.custFilters[col];
  const n = Array.isArray(arr) ? arr.length : 0;
  const btn = m.querySelector('.msel-btn');
  m.querySelector('.msel-lbl').textContent = n ? `${n} selected` : 'All';
  btn.classList.toggle('active', n > 0);
}

function renderCustPackages() {
  const el = document.getElementById('custPackages');
  if (!el) return;
  const pkgs = (State.data && State.data.packages) || [];
  el.innerHTML = pkgs.length
    ? pkgs.map(p => `<span class="pkgchip">${esc(p)}</span>`).join('')
    : '<span class="muted">not configured</span>';
}

function getCustRows() {
  let rows = State.objects.filter(o => o.custom);
  // show only objects that live in the local files (hide live SAP-fetched)
  if (State.custLocalOnly) {
    rows = rows.filter(o => o.source !== 'SAP ADT (live)');
  }
  // global search
  if (State.custSearch.trim()) {
    const q = State.custSearch;
    rows = rows.filter(o => CUST_COLS.some(c => wildcard(q, o[c.key])) || wildcard(q, o.name));
  }
  // per-column: multi-select (array of exact values) or free-text wildcard
  Object.entries(State.custFilters).forEach(([col, val]) => {
    if (Array.isArray(val)) {
      if (val.length) { const set = new Set(val); rows = rows.filter(o => set.has((o[col] ?? '').toString())); }
    } else if (val && val.trim()) {
      rows = rows.filter(o => wildcard(val, o[col]));
    }
  });
  const s = State.custSort;
  rows.sort((a, b) => ((a[s.key] || '').toString().localeCompare((b[s.key] || '').toString())) * s.dir);
  return rows;
}

function sortCust(key) {
  const s = State.custSort;
  s.dir = (s.key === key) ? -s.dir : 1; s.key = key;
  renderCustTable();
}

function renderCustTable() {
  const rows = getCustRows();
  const body = document.getElementById('custBody');
  body.innerHTML = rows.slice(0, 2000).map(o => `<tr>
    <td class="mono"><b>${esc(o.name)}</b></td>
    <td class="muted" title="${esc(o.description)}">${esc(o.description)}</td>
    <td><span class="mini">${esc(o.category)}</span></td>
    <td><span class="tag ${o.domain}">${o.domain}</span></td>
    <td>${esc(o.primaryProcess || getL1(o.process))}</td>
    <td>${esc(o.process)}</td>
    <td class="mono muted">${esc(o.package)}</td>
    <td>${valBadge(o.validity) || '<span class="muted">—</span>'}</td>
    ${State.isAdmin ? `<td><button class="btn-edit" data-name="${esc(o.name)}">✏️ Edit</button></td>` : ''}
  </tr>`).join('');
  document.getElementById('custCount').textContent =
    `${rows.length} object${rows.length !== 1 ? 's' : ''}${rows.length > 2000 ? ' (showing first 2000)' : ''}`;
}

/* ---------- Excel export ---------- */
function exportExcel() {
  const rows = getCustRows();
  const aoa = [CUST_COLS.map(c => c.label)];
  rows.forEach(o => aoa.push(CUST_COLS.map(c => o[c.key] ?? '')));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = CUST_COLS.map((c, i) => ({ wch: [34, 44, 18, 8, 20, 18, 18, 10][i] || 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Custom Objects');
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `PS_Custom_Objects_MS1_${stamp}.xlsx`);
  toast(`Exported ${rows.length} objects to Excel`);
  track('export', { n: rows.length });
}

/* ---------- Refresh from SAP MS1 ---------- */
async function refreshFromSap() {
  const btn = document.getElementById('btnRefresh');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Fetching all objects from MS1…';
  try {
    const r = await fetch('/api/refresh', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = await r.json();
    if (res.status === 'ok' && res.data) {
      applyData(res.data);
      initProcess(); initTech(); renderCustTable();
      renderCustPackages();
      const live = (res.data.source === 'live');
      toast(`${live ? 'Live refresh from ' : 'Rebuilt from '}${res.source || 'SAP MS1'} · ` +
            `${res.data.objects.length} objects`, !live);
      if (res.message) setTimeout(() => toast(res.message, !live), 3200);
      loadRefreshStatus();
    } else {
      toast('Refresh returned: ' + (res.message || 'no data'), true);
    }
  } catch (e) {
    toast('SAP refresh needs the backend (python app.py) reachable. ' +
          'Open ⚙ SAP Connection to configure MS1.', true);
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

/* ---------- Last live snapshot indicator (Excel + timestamp) ---------- */
async function loadRefreshStatus() {
  const el = document.getElementById('custSync');
  if (!el) return;
  try {
    const r = await fetch('/api/refresh/status', { cache: 'no-store' });
    if (!r.ok) return;
    const info = await r.json();
    const lr = info.liveRefresh;
    if (lr && lr.at) {
      el.innerHTML = `⟳ Live SAP snapshot: <b>${esc(lr.at)}</b> · ` +
        `${lr.abap_live || 0} ABAP live` +
        (info.excel ? ` · <a href="/api/refresh/export" title="Download ${esc(info.excel.name)}">⬇ ${esc(info.excel.name)}</a>` : '');
    } else if (info.generated) {
      el.textContent = `Data generated: ${info.generated}`;
    }
  } catch (e) { /* ignore */ }
}

/* ---------- SAP MS1 connection modal ---------- */
function initSapModal() {
  const modal = document.getElementById('sapModal');
  if (!modal) return;
  const open = () => { loadSapStatus(); modal.classList.add('open'); };
  const close = () => modal.classList.remove('open');

  document.getElementById('envPill').addEventListener('click', open);
  document.getElementById('sapClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  document.getElementById('sapTest').addEventListener('click', () => sapTest());
  document.getElementById('sapSave').addEventListener('click', () => sapSave(false));
  document.getElementById('sapSaveRefresh').addEventListener('click', () => sapSave(true));

  // reflect current backend status on the header dot at startup
  loadSapStatus(true);
}

function sapForm() {
  const v = id => (document.getElementById(id).value || '').trim();
  const pkgs = v('sapPackages').split(',').map(s => s.trim()).filter(Boolean);
  const cfg = {
    ashost: v('sapAshost'), sysnr: v('sapSysnr'), client: v('sapClient'),
    lang: v('sapLang'), user: v('sapUser'), passwd: v('sapPasswd'),
    httpbase: v('sapHttpBase'),
  };
  if (pkgs.length) cfg.packages = pkgs;
  return cfg;
}

function setSapStatus(msg, kind) {
  const el = document.getElementById('sapStatus');
  if (!el) return;
  el.className = 'conn-status show ' + (kind || 'info');
  el.innerHTML = msg;   // internal, controlled strings (dynamic values esc()'d inline)
}

async function loadSapStatus(silent) {
  try {
    const r = await fetch('/api/sap/status');
    if (!r.ok) throw new Error();
    const s = await r.json();
    // prefill (never returns the password)
    const set = (id, val) => { const e = document.getElementById(id); if (e && !e.value) e.value = val || ''; };
    set('sapAshost', s.ashost); set('sapSysnr', s.sysnr); set('sapClient', s.client || '122');
    set('sapLang', s.lang || 'EN'); set('sapUser', s.user);
    set('sapPackages', (s.packages || []).join(', '));
    set('sapHttpBase', s.httpbase);

    updateConnDot(s);
    if (!silent) {
      if (s.http_configured)
        setSapStatus(`Ready over HTTPS/OData for <b>${esc(s.user || '')}@${esc(s.httpbase || '')}</b>. ` +
                     'Test or Save &amp; Refresh.', 'ok');
      else if (!s.pyrfc)
        setSapStatus('The <b>RFC SDK (pyrfc) isn\'t available on this Python</b> — no problem. ' +
                     'Connect without any SDK: fill the <b>MS1 Web base URL (OData)</b> field below ' +
                     '(e.g. https://host:44300) plus user &amp; password, then <b>Test connection</b>.', 'info');
      else if (!s.configured)
        setSapStatus('Enter your SAP MS1 details below, then <b>Test connection</b>.', 'info');
      else
        setSapStatus(`Configured for <b>${esc(s.user)}@${esc(s.ashost)}</b> · client ${esc(s.client)}. ` +
                     'Test or Save &amp; Refresh to pull live objects.', 'ok');
    }
  } catch (e) {
    updateConnDot(null);
    if (!silent)
      setSapStatus('Backend not reachable. Start it with <b>python app.py</b> to use the live SAP connection.', 'err');
  }
}

function updateConnDot(s) {
  // "configured" only means credentials are saved — verify it's actually live
  if (!s || !(s.configured || s.http_configured)) {
    State.sapConnected = false; setConnDot(); return;
  }
  verifyConnection();
}

/* actively test the saved connection; green only if SAP really responds */
let _verifyBusy = false;
async function verifyConnection() {
  if (_verifyBusy) return;
  _verifyBusy = true;
  try {
    const r = await fetch('/api/sap/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const res = await r.json();
    State.sapConnected = !!(res && res.ok);
  } catch (e) {
    State.sapConnected = false;
  } finally {
    _verifyBusy = false;
    setConnDot();
  }
}

async function sapTest() {
  const btn = document.getElementById('sapTest');
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Testing…';
  const form = sapForm();
  if (!form.httpbase && !form.ashost) {
    setSapStatus('Enter either an <b>Application server host</b> (needs RFC SDK) or, without any SDK, ' +
                 'the <b>MS1 Web base URL (OData)</b> (e.g. https://host:44300).', 'info');
    btn.disabled = false; btn.innerHTML = orig; return;
  }
  setSapStatus(form.httpbase ? 'Opening an HTTPS/OData session to SAP MS1…' : 'Opening an RFC session to SAP MS1…', 'info');
  try {
    const r = await fetch('/api/sap/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const res = await r.json();
    if (res.ok) {
      State.sapConnected = true; setConnDot();
      setSapStatus(`✅ Connected to <b>${esc(res.system || res.endpoint || 'MS1')}</b>` +
                   (res.release ? ` (release ${esc(res.release)}, host ${esc(res.host || '?')})` : '') +
                   ` as ${esc(res.user)} · client ${esc(res.client)}.`, 'ok');
    } else {
      let msg = res.error || 'Connection failed';
      if (/pyrfc/i.test(msg) && !form.httpbase)
        msg += ' — the RFC SDK isn\'t available here. Use the MS1 Web base URL (OData) field instead (no SDK needed).';
      setSapStatus('❌ ' + esc(msg), 'err');
    }
  } catch (e) {
    setSapStatus('❌ Backend not reachable. Start it with python app.py.', 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

async function sapSave(thenRefresh) {
  const btn = document.getElementById(thenRefresh ? 'sapSaveRefresh' : 'sapSave');
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Saving…';
  try {
    const r = await fetch('/api/sap/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sapForm()),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = await r.json();
    updateConnDot(res.sap);
    setSapStatus('Settings saved to sap_config.json.', 'ok');
    toast('SAP MS1 connection saved');
    if (thenRefresh) {
      document.getElementById('sapModal').classList.remove('open');
      await refreshFromSap();
    }
  } catch (e) {
    setSapStatus('❌ Could not save. Is the backend running (python app.py)?', 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

/* ===================== small utils ===================== */
function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function makeChart(id, cfg) { if (State.charts[id]) State.charts[id].destroy();
  State.charts[id] = new Chart(document.getElementById(id), cfg); }
function doughnutOpts(pos) { return {
  responsive: true, maintainAspectRatio: false, cutout: '58%',
  plugins: { legend: { position: pos, labels: { color: '#8ea0c9', boxWidth: 12, font: { size: 11 } } } } }; }
function barOpts() { return {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: { x: { ticks: { color: '#8ea0c9' }, grid: { display: false } },
            y: { ticks: { color: '#8ea0c9' }, grid: { color: '#1e2a4d' }, beginAtZero: true } } }; }
function toast(msg, warn) {
  const t = document.getElementById('toast');
  t.innerHTML = (warn ? '⚠️ ' : '✅ ') + esc(msg);
  t.classList.add('show'); clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ===================== OBJECT FINDER ASSISTANT ===================== */
const STOPWORDS = new Set(('a an the is are was were be been being to of for and or in on at by with '
  + 'which what where who how do does did can could should would will i me my we our you your it its '
  + 'that this these those from as into about show tell find give share list get need want please '
  + 'related specific ask question exact most accurate object objects sap use used using has have').split(/\s+/));

// intent words -> categories they favour
const INTENT = [
  { cats: ['Function Module'], words: ['fm', 'function', 'module', 'routine', 'abap', 'program', 'report program', 'badi', 'enhancement', 'class', 'method', 'interface'] },
  { cats: ['BEx Query'], words: ['query', 'bex', 'report', 'output', 'analytics', 'dashboard', 'display', 'list', 'workbook'] },
  { cats: ['Planning Sequence'], words: ['planning sequence', 'planseq', 'sequence', 'planning run', 'run planning', 'plan sequence'] },
  { cats: ['Planning Function'], words: ['planning function', 'fox', 'formula', 'copy', 'distribute', 'revalue', 'delete', 'repost', 'derive', 'valuation'] },
  { cats: ['Filter'], words: ['filter', 'restriction', 'selection'] },
];

function tokenize(str) {
  return (str || '').toLowerCase().split(/[^a-z0-9/_]+/)
    .filter(t => t && t.length >= 2 && !STOPWORDS.has(t));
}

// light stemmer so "deletes/deleting/deleted" all match "delete"
function stem(w) {
  w = (w || '').toLowerCase();
  if (w.length > 4) {
    if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.endsWith('ing')) return w.slice(0, -3);
    if (w.endsWith('ed')) return w.slice(0, -2);
    if (w.endsWith('es')) return w.slice(0, -2);
    if (w.endsWith('s')) return w.slice(0, -1);
  }
  return w;
}

// words that only signal the object *type* (excluded from content coverage)
const HINT_WORDS = new Set();
INTENT.forEach(g => g.words.forEach(w => { if (!w.includes(' ')) HINT_WORDS.add(w); }));
['plan', 'planning', 'object', 'code', 'comment', 'formula', 'fox'].forEach(w => HINT_WORDS.add(w));

function detectIntentCats(qLower, tokens) {
  const cats = new Set();
  INTENT.forEach(g => {
    if (g.words.some(w => w.includes(' ') ? qLower.includes(w) : tokens.includes(w))) g.cats.forEach(c => cats.add(c));
  });
  return cats;
}

/* rank custom objects against a natural-language question */
function rankObjects(question, limit = 6) {
  const qLower = question.toLowerCase();
  const tokens = [...new Set(tokenize(question))];
  if (!tokens.length) return [];
  const intentCats = detectIntentCats(qLower, tokens);
  // content tokens = subject words (type-hint words removed), used for accuracy
  const contentTokens = [...new Set(tokens.filter(t => !HINT_WORDS.has(t)).map(stem))];

  const FIELDS = [
    { key: 'description', w: 3.2 },
    { key: 'name', w: 3.0 },
    { key: 'technical', w: 1.8 },
    { key: 'process', w: 1.6 },
    { key: 'category', w: 1.0 },
    { key: 'source', w: 0.4 },
    { key: 'author', w: 0.4 },
  ];

  const scored = State.objects.filter(o => o.custom).map(o => {
    let score = 0; const hits = new Set();
    const objStems = new Set();
    const objText = FIELDS.map(f => (o[f.key] || '')).join(' ').toLowerCase();
    objText.split(/[^a-z0-9/_]+/).filter(Boolean).forEach(w => objStems.add(stem(w)));

    FIELDS.forEach(f => {
      const val = (o[f.key] || '').toString().toLowerCase();
      if (!val) return;
      const words = new Set(val.split(/[^a-z0-9/_]+/).filter(Boolean));
      tokens.forEach(t => {
        if (words.has(t)) { score += f.w * 2; hits.add(t); }
        else if (val.includes(t)) { score += f.w; hits.add(t); }
      });
    });
    const dn = ((o.description || '') + ' ' + o.name).toLowerCase();
    let phrase = false;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (dn.includes(tokens[i] + ' ' + tokens[i + 1])) { score += 3; phrase = true; }
    }
    const intentMatch = intentCats.size && intentCats.has(o.category);
    if (intentMatch) score += 4;
    if (o.description) score += 0.3;

    // --- absolute accuracy (0-100), subject-focused ---
    let covered = 0;
    contentTokens.forEach(t => {
      if (objStems.has(t)) { covered++; return; }
      if (objText.includes(t)) { covered++; return; }
      // typeHint content? credit if the object's category matches the hint intent
    });
    const coverage = contentTokens.length ? covered / contentTokens.length : (intentMatch ? 0.6 : 0);
    let acc = coverage * 90 + (intentMatch ? 5 : 0) + (phrase ? 5 : 0);
    acc = Math.max(0, Math.min(99, Math.round(acc)));

    return { o, score, hits: [...hits], acc, codeConfirmed: false, snippet: '' };
  }).filter(r => r.score > 0 && r.hits.length);

  // apply 👎/✕ feedback for similar questions: hide -> drop, down -> demote
  const fb = feedbackMatch(question);
  let arr = scored.filter(r => !fb.hide.has(r.o.name.toUpperCase()));
  arr.forEach(r => { r.demoted = fb.down.has(r.o.name.toUpperCase()); });
  arr.sort((a, b) => (a.demoted ? 1 : 0) - (b.demoted ? 1 : 0)
    || b.acc - a.acc || b.score - a.score
    || (b.o.description || '').length - (a.o.description || '').length);
  return arr.slice(0, limit);
}

/* match 👎/✕ feedback to a question (by keyword overlap, stemmed) */
function feedbackMatch(query) {
  const hide = new Set(), down = new Set();
  const qs = new Set([...new Set(tokenize(query))].map(stem));
  if (!qs.size) return { hide, down };
  (State.feedback || []).forEach(f => {
    const kw = (f.keywords || []).map(stem);
    if (!kw.length) return;
    const matched = kw.filter(k => qs.has(k)).length;
    if (matched >= 1 && (matched / kw.length >= 0.5 || matched >= 2)) {
      const nm = (f.object || '').toUpperCase();
      if (f.action === 'hide') hide.add(nm);
      else if (f.action === 'down') down.add(nm);
    }
  });
  return { hide, down };
}

function initAssistant() {
  const fab = document.getElementById('aFab');
  const panel = document.getElementById('aPanel');
  const body = document.getElementById('aBody');
  const input = document.getElementById('aInput');
  const send = document.getElementById('aSend');
  if (!fab) return;

  const open = () => {
    panel.classList.add('open'); fab.style.display = 'none';
    if (!body.dataset.greeted) { greet(); body.dataset.greeted = '1'; }
    setTimeout(() => input.focus(), 50);
  };
  const close = () => { panel.classList.remove('open'); fab.style.display = 'grid'; };
  fab.addEventListener('click', open);
  document.getElementById('aClose').addEventListener('click', close);
  send.addEventListener('click', ask);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });

  // detect whether an LLM is wired for generic-question understanding
  State.assistant = { llm: false, sap: false, searchMs1: false };
  // MS1-live search toggle (off by default = local only), remembered per browser
  try { State.assistant.searchMs1 = localStorage.getItem('pspe.searchMs1') === '1'; } catch (e) {}
  const liveToggle = document.getElementById('aLiveToggle');
  const liveState = document.getElementById('aLiveState');
  function reflectToggle() {
    if (liveToggle) liveToggle.checked = State.assistant.searchMs1;
    if (liveState) {
      liveState.textContent = State.assistant.searchMs1 ? 'on · local + SAP MS1' : 'off · local only';
      liveState.classList.toggle('on', State.assistant.searchMs1);
    }
  }
  reflectToggle();
  if (liveToggle) liveToggle.addEventListener('change', () => {
    State.assistant.searchMs1 = liveToggle.checked;
    try { localStorage.setItem('pspe.searchMs1', liveToggle.checked ? '1' : '0'); } catch (e) {}
    reflectToggle();
    if (liveToggle.checked) verifyConnection();   // refresh the connection dot
  });
  fetch('/api/assistant/llm').then(r => r.ok ? r.json() : null)
    .then(s => { if (s) State.assistant.llm = !!s.available; }).catch(() => {});
  fetch('/api/sap/status').then(r => r.ok ? r.json() : null)
    .then(s => { if (s) { State.assistant.sap = !!(s.http_configured || (s.configured && s.pyrfc)); State.assistant.user = s.user || ''; } }).catch(() => {});
  fetch('/api/assistant/teachings').then(r => r.ok ? r.json() : null)
    .then(s => { if (s && s.teachings) { State.teachings = s.teachings; State.assistant.shared = !!s.shared; } }).catch(() => {});
  fetch('/api/assistant/feedback').then(r => r.ok ? r.json() : null)
    .then(s => { if (s && s.feedback) State.feedback = s.feedback; }).catch(() => {});

  function greet() {
    addBot(`Hi! Ask me in plain English and I'll match your words against the <b>descriptions</b>, `
      + `names and technical details of every custom ABAP & BW object — and, when SAP MS1 is connected, `
      + `the <b>comments inside the ABAP / FOX code</b> too.<br>`
      + `<span style="font-size:11px;color:var(--muted)">You can also say things like <i>“clear chat”</i>, <i>“reset”</i> or <i>“help”</i>.</span>`
      + `<div class="achips">`
      + chip('Which FM deletes cube data?')
      + chip('Forecast revenue query')
      + chip('Planning function to copy FF revenue')
      + `<span class="achip addform">➕ Add object</span>`
      + chip('Clear chat')
      + `</div>`);
  }
  function chip(t) { return `<span class="achip" data-q="${esc(t)}">${esc(t)}</span>`; }

  function clearChat() {
    body.innerHTML = ''; delete body.dataset.greeted;
    State.wizard = null;
    greet(); body.dataset.greeted = '1';
  }

  function addUser(t) {
    const d = document.createElement('div'); d.className = 'msg user'; d.textContent = t;
    body.appendChild(d); body.scrollTop = body.scrollHeight;
  }
  function addBot(html) {
    const d = document.createElement('div'); d.className = 'msg bot'; d.innerHTML = html;
    body.appendChild(d); body.scrollTop = body.scrollHeight;
    d.querySelectorAll('.achip').forEach(c => c.addEventListener('click', () => { if (c.dataset.q) { input.value = c.dataset.q; ask(); } }));
    d.querySelectorAll('.addform').forEach(c => c.addEventListener('click', () => openAddForm()));
    d.querySelectorAll('.open2').forEach(a => a.addEventListener('click', () => openObject(a.dataset.name)));
    return d;
  }

  const HELP = `I turn plain-English questions into the exact custom SAP object you need.<br>`
    + `• <b>Find objects</b>: “which FM deletes cube data”, “forecast revenue query”, “planning function to copy FF revenue”.<br>`
    + `• <b>Add an object</b>: say “add object” and I'll capture its details + process area and save it to the local repository.<br>`
    + `• <b>Commands</b>: “clear chat” / “reset” to wipe this conversation, “help” for this message.<br>`
    + `I rank by confidence and show matches above 80%. When SAP MS1 is connected I also verify against FOX / ABAP code comments.`;

  // fast local intent detection (works without an LLM)
  function localIntent(q) {
    const s = q.toLowerCase().trim();
    if (/^(clear|reset|clean|wipe|erase|new)\b/.test(s) &&
        /\b(chat|response|responses|conversation|messages?|screen|history|all|everything|it|this)\b/.test(s)
        || /^(clear|reset|clean|wipe|start over|new chat|clear all)\.?$/.test(s)
        || /\bclear (the )?(chat|response|screen|conversation)\b/.test(s)) return { action: 'clear' };
    if (/^(help|examples?|what can you|how (do|does|to)|guide|usage)\b/.test(s) || s === '?') return { action: 'help' };
    if ((/^(add|create|register|insert)\b/.test(s) &&
         /\b(object|abap|bw|fm|function|module|class|query|planning|sequence|filter|infoprovider|repository|tile|local)\b/.test(s))
        || /\badd (an?|new|this)\b.*\bobject\b/.test(s) || s === 'add object') return { action: 'add' };
    if (/^(hi|hii|hey|hello|yo|thanks|thank you|thx|good (morning|afternoon|evening))\b/.test(s)) return { action: 'smalltalk' };
    return { action: 'search' };
  }

  /* ---- add-object wizard: capture details + process, save to local repo ---- */
  function startAddWizard() {
    State.wizard = { step: 'name', data: {} };
    addBot(`Let's add a custom object to the <b>local repository</b>. `
      + `First — what is the <b>object name</b>? (Z*/Y*)  <span class="muted">(type <i>cancel</i> anytime)</span>`);
  }

  function handleWizard(q) {
    const w = State.wizard;
    const val = q.trim();
    if (/^(cancel|stop|abort|exit|quit)$/i.test(val)) { State.wizard = null; addBot('Cancelled — nothing was added.'); return; }
    const chipRow = arr => `<div class="achips">${arr.map(chip).join('')}</div>`;
    switch (w.step) {
      case 'name':
        if (!/^[zy]/i.test(val)) { addBot('Please enter a custom object name starting with <b>Z</b> or <b>Y</b> (or type cancel).'); return; }
        w.data.name = val.toUpperCase(); w.step = 'domain';
        addBot(`Is <b>${esc(w.data.name)}</b> an ABAP or BW object?` + chipRow(['ABAP', 'BW']));
        return;
      case 'domain':
        w.data.domain = /bw/i.test(val) ? 'BW' : 'ABAP'; w.step = 'category';
        addBot(`What is the <b>category</b>?` + chipRow(w.data.domain === 'ABAP'
          ? ['Function Module', 'Class', 'Interface', 'Table Maintenance', 'Program', 'Method']
          : ['BEx Query', 'Planning Sequence', 'Planning Function', 'Filter', 'InfoProvider', 'Aggregation Level', 'InfoObject']));
        return;
      case 'category':
        w.data.category = val; w.step = 'l1';
        addBot(`Which <b>Process Area (L1)</b> tile does it belong to?`
          + chipRow(Object.keys(L1_META).filter(x => x !== 'Other')));
        return;
      case 'l1': {
        w.data.l1 = val; w.step = 'process';
        const subs = [...new Set(State.processAreas.filter(p => getL1(p.name) === val).map(p => p.name))].slice(0, 10);
        addBot(`Which <b>Sub-Process area</b> (tile) should it appear under? Pick one or type a new name.`
          + (subs.length ? chipRow(subs) : ''));
        return;
      }
      case 'process':
        w.data.process = val; w.step = 'description';
        addBot(`Add a short <b>description</b>? (or type <i>skip</i>)`);
        return;
      case 'description': {
        w.data.description = /^skip$/i.test(val) ? '' : val; w.step = 'confirm';
        const d = w.data;
        addBot(`Please confirm:<br>• <b>${esc(d.name)}</b> — ${esc(d.category)} (${esc(d.domain)})`
          + `<br>• Tile: <b>${esc(d.l1)}</b> › <b>${esc(d.process)}</b>`
          + (d.description ? `<br>• ${esc(d.description)}` : '')
          + chipRow(['Save', 'Cancel']));
        return;
      }
      case 'confirm':
        if (/^save$/i.test(val)) saveWizardObject();
        else { State.wizard = null; addBot('Cancelled — nothing was added.'); }
        return;
    }
  }

  async function saveWizardObject() {
    const d = State.wizard ? State.wizard.data : null;
    State.wizard = null;
    if (!d) return;
    try {
      const r = await fetch('/api/objects/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ author: (State.assistant && State.assistant.user) || '' }, d)),
      });
      const res = await r.json();
      if (res.ok) {
        try {
          const dr = await fetch('/api/data', { cache: 'no-store' });
          if (dr.ok) { applyData(await dr.json()); initProcess(); renderCustTable(); }
        } catch (e) {}
        addBot(`✅ <b>It's updated to the Local files.</b><br>${esc(d.name)} now appears under `
          + `<b>${esc(d.l1)} › ${esc(d.process)}</b>.`);
      } else {
        addBot('⚠️ ' + esc(res.error || 'Could not add the object.'));
      }
    } catch (e) { addBot('⚠️ Could not reach the backend to save (run python app.py / serve.py).'); }
  }

  function doSearch(displayQ, searchQ) {
    const taught = taughtFor(searchQ);
    const results = rankObjects(searchQ, 8);
    const liveOn = !!(State.assistant && State.assistant.searchMs1);
    const topAcc = results.length ? results[0].acc : 0;
    track('query', { q: displayQ, matched: !!(taught.length || topAcc >= 80), topAcc, live: liveOn });
    if (!results.length && !taught.length) {
      if (liveOn) {
        const b = addBot(`No match in the local catalogue — searching SAP MS1 live…`);
        addTeach(b, displayQ);
        enrichWithLiveSap(searchQ, [], b);
        return;
      }
      const b = addBot(`I couldn't find a matching custom object locally. `
        + `Turn on <b>🌐 Search SAP MS1 live</b> below to also query SAP, or try different words `
        + `(e.g. "delete cube", "forecast revenue", "amendment").`);
      addTeach(b, displayQ);
      return;
    }
    const bubble = addBot('');
    bubble.dataset.q = searchQ;
    bubble.innerHTML = renderTaught(taught) + '<div class="answer">' + renderResults(displayQ, results, false) + '</div>';
    rebindBubble(bubble);
    addTeach(bubble, displayQ);
    if (State.data && State.data.source === 'live') enrichWithComments(searchQ, results, bubble);
    if (liveOn) enrichWithLiveSap(searchQ, results, bubble);
  }

  /* ---- training: match, render, submit corrections ---- */
  function taughtFor(query) {
    const qs = new Set([...new Set(tokenize(query))].map(stem));
    if (!qs.size) return [];
    const out = [];
    (State.teachings || []).forEach(t => {
      const kw = (t.keywords || []).map(stem);
      if (!kw.length) return;
      const matched = kw.filter(k => qs.has(k)).length;
      const cover = matched / kw.length;
      if (matched >= 1 && (cover >= 0.5 || matched >= 2)) out.push({ t, cover, matched });
    });
    return out.sort((a, b) => b.cover - a.cover || b.matched - a.matched).map(x => x.t);
  }

  function renderTaught(taught) {
    if (!taught || !taught.length) return '';
    const row = t => `<div class="arow"><span class="dotd" style="background:#f5b942"></span>`
      + `<a class="rn open2" data-name="${esc(t.object)}">${esc(t.object)}</a>`
      + (t.type ? `<span class="rc">${esc(t.type)}</span>` : '')
      + `<span class="ck" title="taught by you">★ taught</span></div>`
      + (t.note ? `<div class="cmtline">${esc(t.note)}</div>` : '');
    return `<div class="taughtblock"><div class="livehdr" style="color:#f5b942">★ Your verified answer</div>`
      + taught.slice(0, 3).map(row).join('') + `</div>`;
  }

  function addTeach(bubble, query) {
    const wrap = document.createElement('div');
    wrap.className = 'teach';
    wrap.innerHTML = `<a class="teachlink">✎ Not right? Teach the correct object</a>`
      + `<div class="teachform" style="display:none">`
      + `<input class="tobj" placeholder="Correct object name (e.g. ZPS_CPM_VALUATION)"/>`
      + `<input class="tnote" placeholder="Optional note / why"/>`
      + `<div class="trow"><button class="tsave">Save</button><button class="tcancel">Cancel</button></div></div>`;
    bubble.appendChild(wrap);
    const form = wrap.querySelector('.teachform');
    wrap.querySelector('.teachlink').addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
      if (form.style.display === 'block') wrap.querySelector('.tobj').focus();
    });
    wrap.querySelector('.tcancel').addEventListener('click', () => { form.style.display = 'none'; });
    wrap.querySelector('.tsave').addEventListener('click', async () => {
      const obj = wrap.querySelector('.tobj').value.trim();
      const note = wrap.querySelector('.tnote').value.trim();
      if (!obj) { wrap.querySelector('.tobj').focus(); return; }
      try {
        const r = await fetch('/api/assistant/teach', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: query, object: obj, note, author: (State.assistant && State.assistant.user) || '' }),
        });
        const res = await r.json();
        if (res.ok && res.teaching) {
          State.teachings.unshift(res.teaching);
          form.style.display = 'none';
          addBot(`✅ Learned it. For questions like “${esc(query)}”, I'll now surface <b>${esc(obj)}</b> first.`);
        }
      } catch (e) { addBot('⚠️ Could not save the correction (backend needed).'); }
    });
  }

  async function ask() {
    const q = input.value.trim();
    if (!q) return;
    addUser(q); input.value = '';

    // active "add object" wizard takes priority
    if (State.wizard) { handleWizard(q); return; }

    // 1) instant local commands
    const local = localIntent(q);
    if (local.action === 'clear') { clearChat(); return; }
    if (local.action === 'help') { addBot(HELP); return; }
    if (local.action === 'add') { startAddWizard(); return; }
    if (local.action === 'smalltalk') {
      addBot(`Hi! Ask me for any custom ABAP or BW object — e.g. “planning function to copy FF revenue”. Say “help” for more.`);
      return;
    }

    // 2) if an LLM is wired, let it interpret generic phrasing
    if (State.assistant && State.assistant.llm) {
      const thinking = addBot('<span class="acheck"><span class="spin"></span> understanding your question…</span>');
      try {
        const r = await fetch('/api/assistant/llm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: q }),
        });
        const res = r.ok ? await r.json() : null;
        thinking.remove();
        if (res && res.available && res.ok) {
          if (res.action === 'clear') { clearChat(); return; }
          if (res.action === 'help') { addBot(res.message || HELP); return; }
          if (res.action === 'smalltalk') { addBot(res.message || 'Hi! How can I help you find an object?'); return; }
          doSearch(q, res.query || q);   // search with LLM-refined keywords
          return;
        }
      } catch (e) { thinking.remove(); }
    }

    // 3) fallback: local keyword search
    doSearch(q, q);
  }

  window.__assistantAsk = ask; // allow programmatic asks
  window.__assistantClear = clearChat;

  // ---- taught-entries manager ----
  const tModal = document.getElementById('teachModal');
  const tList = document.getElementById('teachList');
  const tAll = document.getElementById('teachAll');
  const tCount = document.getElementById('teachCount');

  const openManager = async () => { await refreshTeachings(); tModal.classList.add('open'); };
  const closeManager = () => tModal.classList.remove('open');
  document.getElementById('aManage').addEventListener('click', openManager);
  document.getElementById('teachClose').addEventListener('click', closeManager);
  tModal.addEventListener('click', e => { if (e.target === tModal) closeManager(); });
  document.getElementById('teachRefresh').addEventListener('click', refreshTeachings);
  tAll.addEventListener('change', () => {
    tList.querySelectorAll('input.tck').forEach(c => { c.checked = tAll.checked; });
  });
  document.getElementById('teachDelete').addEventListener('click', deleteSelected);

  async function refreshTeachings() {
    try {
      const r = await fetch('/api/assistant/teachings');
      const s = r.ok ? await r.json() : { teachings: [] };
      State.teachings = s.teachings || [];
      State.assistant.shared = !!s.shared;
    } catch (e) { /* keep current */ }
    renderTeachList();
  }

  function renderTeachList() {
    const items = State.teachings || [];
    const badge = State.assistant.shared
      ? '<span class="ck" style="background:var(--ok)">● shared</span>'
      : '<span class="ck" style="background:var(--muted2);color:#04231b">● local</span>';
    tCount.innerHTML = `${badge} ${items.length} taught entr${items.length === 1 ? 'y' : 'ies'}`;
    tAll.checked = false;
    if (!items.length) { tList.innerHTML = '<div class="teach-empty">No taught entries yet. Correct an answer to teach the bot.</div>'; return; }
    tList.innerHTML = items.map(t => `<label class="trow2">
      <input type="checkbox" class="tck" value="${esc(t.id)}"/>
      <div class="tinfo">
        <div class="tobjn">${esc(t.object)}${t.type ? ' · ' + esc(t.type) : ''}</div>
        <div class="tq">Q: “${esc(t.question)}”</div>
        ${t.note ? `<div class="tnote2">📝 ${esc(t.note)}</div>` : ''}
        <div class="tmeta">${esc(t.ts || '')}${t.author ? ' · by ' + esc(t.author) : ''} · keywords: ${esc((t.keywords || []).join(', '))}</div>
      </div>
    </label>`).join('');
  }

  async function deleteSelected() {
    const ids = [...tList.querySelectorAll('input.tck:checked')].map(c => c.value);
    if (!ids.length) { toast('Select at least one entry to delete', true); return; }
    const all = ids.length === (State.teachings || []).length;
    if (!confirm(`Delete ${ids.length} taught entr${ids.length === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
    try {
      const r = await fetch('/api/assistant/teach/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(all ? { all: true } : { ids }),
      });
      const res = await r.json();
      if (res.ok) {
        State.teachings = res.teachings || [];
        renderTeachList();
        toast(`Deleted ${ids.length} taught entr${ids.length === 1 ? 'y' : 'ies'}`);
      }
    } catch (e) { toast('Could not delete (backend needed)', true); }
  }
}

const ACC_THRESHOLD = 80;

function renderResults(q, results, checking) {
  // sort by (possibly code-boosted) accuracy, keep only high-confidence
  const sorted = results.slice().sort((a, b) => b.acc - a.acc);
  const strong = sorted.filter(r => r.acc >= ACC_THRESHOLD);
  const shown = strong.length ? strong : sorted.slice(0, 1);
  const best = shown[0];

  const line = r => {
    const o = r.o;
    return `<div class="arow${r === best ? ' best' : ''}" id="am-${cssId(o.name)}">
      <span class="dotd ${o.domain === 'ABAP' ? 'abap' : 'bw'}"></span>
      <a class="rn open2" data-name="${esc(o.name)}">${esc(o.name)}</a>
      <span class="rc">${esc(o.category)}</span>
      ${r.codeConfirmed ? '<span class="ck" title="confirmed in FOX / ABAP code comments">✓ code</span>' : ''}
      <span class="rp${r.acc >= ACC_THRESHOLD ? ' hi' : ''}">${r.acc}%</span>
      ${fbIcons(o.name)}
    </div>`
      + (r.codeConfirmed && r.snippet ? `<div class="cmtline">💬 ${esc(r.snippet)}</div>` : '');
  };

  let head;
  if (strong.length) {
    head = `<div class="lead">Top match (${best.acc}% confidence): <b>${esc(best.o.name)}</b> · ${esc(best.o.category)} (${best.o.domain})</div>`;
  } else {
    head = `<div class="lead">No match above ${ACC_THRESHOLD}% confidence — closest is <b>${esc(best.o.name)}</b> at ${best.acc}%. Try more specific words.</div>`;
  }
  const foot = checking
    ? `<div class="acheck"><span class="spin"></span> checking FOX / ABAP code comments in SAP MS1…</div>` : '';
  return head + shown.map(line).join('') + foot;
}

function cssId(s) { return (s || '').replace(/[^a-z0-9]/gi, '_'); }

/* open the process drawer for a matched object (and highlight it) */
function openObject(name) {
  const o = State.objects.find(x => x.name === name);
  if (!o) return;
  openDrawer(o.process);
}

/* live: check FOX formulas / ABAP class comments and raise accuracy on a hit */
async function enrichWithComments(question, results, bubble) {
  const answer = () => bubble.querySelector('.answer') || bubble;
  // show a "checking…" note while SAP responds
  answer().innerHTML = renderResults(question, results, true);
  rebindBubble(bubble);
  try {
    const objects = results.map(r => ({ name: r.o.name, category: r.o.category }));
    const r = await fetch('/api/assistant/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, objects }),
    });
    let byName = {};
    if (r.ok) byName = (await r.json()).matches || {};
    results.forEach(res => {
      const snips = byName[res.o.name];
      if (snips && snips.length) {
        res.codeConfirmed = true;
        res.snippet = snips[0];
        res.acc = Math.min(99, Math.max(res.acc, ACC_THRESHOLD) + 12); // code proof lifts confidence
      }
    });
  } catch (e) { /* offline / not available */ }
  answer().innerHTML = renderResults(question, results, false);
  rebindBubble(bubble);
}

function rebindBubble(d) {
  d.querySelectorAll('.open2').forEach(a => a.onclick = () => openObject(a.dataset.name));
  const query = d.dataset.q || '';
  d.querySelectorAll('.arow .fbtn').forEach(btn => {
    btn.onclick = async () => {
      const action = btn.dataset.a, name = btn.dataset.name;
      if (!name) return;
      const grp = btn.closest('.fbrow');
      if (grp) grp.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      try {
        const r = await fetch('/api/assistant/feedback', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: query, objects: [name], action, author: (State.assistant && State.assistant.user) || '' }),
        });
        const res = await r.json();
        if (res.ok) State.feedback = res.feedback || State.feedback;
      } catch (e) { /* keep local */ }
      const row = btn.closest('.arow');
      if (action === 'hide' && row) {
        const next = row.nextElementSibling;
        if (next && next.classList.contains('cmtline')) next.remove();
        row.remove();
      } else if (action === 'down' && row) {
        const parent = row.parentElement, next = row.nextElementSibling;
        row.classList.add('demoted');
        if (next && next.classList.contains('cmtline')) parent.appendChild(next);
        parent.appendChild(row);          // move to the bottom
      }
    };
  });
}

/* inline per-object feedback icons */
function fbIcons(name) {
  const n = esc(name);
  return `<span class="fbrow">`
    + `<button class="fbtn up" data-a="up" data-name="${n}" title="Good">👍</button>`
    + `<button class="fbtn down" data-a="down" data-name="${n}" title="Rank lower for similar questions">👎</button>`
    + `<button class="fbtn hide" data-a="hide" data-name="${n}" title="Never show for similar questions">✕</button>`
    + `</span>`;
}

/* live: query SAP MS1 directly (HTTP/ADT + OData catalog) and append results */
async function enrichWithLiveSap(query, results, bubble) {
  const live = document.createElement('div');
  live.className = 'livesap';
  live.innerHTML = '<div class="acheck"><span class="spin"></span> searching SAP MS1 live…</div>';
  bubble.appendChild(live);
  bubble.parentElement && (bubble.parentElement.scrollTop = bubble.parentElement.scrollHeight);
  try {
    const names = results.slice(0, 6).map(r => r.o.name);
    const r = await fetch('/api/assistant/sapsearch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, names }),
    });
    const res = r.ok ? await r.json() : null;
    let objs = (res && res.objects) || [];
    const svcs = (res && res.services) || [];
    const src = res && res.source;
    // honour 👎/✕ feedback on live results too
    const fb = feedbackMatch(query);
    objs = objs.filter(o => !fb.hide.has((o.name || '').toUpperCase()));
    objs.sort((a, b) => (fb.down.has((a.name || '').toUpperCase()) ? 1 : 0)
      - (fb.down.has((b.name || '').toUpperCase()) ? 1 : 0));
    if (src === 'offline' || src === 'http-offline') {
      live.innerHTML = `<div class="livehdr" style="color:var(--muted2)">🌐 SAP MS1 live is on, but not connected — open ⚙ and Test connection.</div>`;
      return;
    }
    const pkgs = (res && res.packages) || ['ZPS_PROJ_EXEC', 'Z_PROF_SERVICES', 'ZCPM'];
    const scope = `<span style="font-weight:400;color:var(--muted)"> · packages ${esc(pkgs.join(' / '))}</span>`;
    if (!objs.length && !svcs.length) {
      live.innerHTML = `<div class="livehdr">🔎 SAP MS1 (live): no Z/Y object in ${esc(pkgs.join(' / '))} matched</div>`;
      return;
    }
    const row = (name, type, desc, dom) =>
      `<div class="arow"><span class="dotd ${dom || 'abap'}"></span>`
      + `<span class="rn open2" data-name="${esc(name)}">${esc(name)}</span>`
      + `<span class="rc">${esc(type)}</span>${fbIcons(name)}</div>`
      + (desc ? `<div class="cmtline">${esc(desc)}</div>` : '');
    let html = `<div class="livehdr">🔎 Live from SAP MS1${scope}</div>`;
    objs.slice(0, 10).forEach(o => html += row(o.name, o.type + (o.package ? ' · ' + o.package : ''), o.description, 'abap'));
    if (svcs.length) {
      html += `<div class="livehdr" style="margin-top:8px">🌐 OData services</div>`;
      svcs.slice(0, 6).forEach(s => html += row(s.name, 'OData Service' + (s.version ? ' v' + s.version : ''), s.description, 'bw'));
    }
    live.innerHTML = html;
    rebindBubble(bubble);
    bubble.parentElement && (bubble.parentElement.scrollTop = bubble.parentElement.scrollHeight);
  } catch (e) {
    live.innerHTML = `<div class="livehdr">🔎 SAP MS1 live search unavailable</div>`;
  }
}

/* ===================== ADMIN (usage metrics) ===================== */
function initAdmin() {
  // resolve admin key: ?admin=KEY (persist + clean URL) or localStorage
  let key = '';
  try {
    const u = new URL(location.href);
    const p = u.searchParams.get('admin');
    if (p) { key = p; localStorage.setItem('pspe.adminKey', p);
      u.searchParams.delete('admin'); history.replaceState({}, '', u.toString()); }
    else key = localStorage.getItem('pspe.adminKey') || '';
  } catch (e) {}
  if (!key) return;                      // not an admin -> tab stays hidden
  State.adminKey = key;
  loadAdminMetrics().then(ok => {
    if (!ok) { try { localStorage.removeItem('pspe.adminKey'); } catch (e) {} return; }
    State.isAdmin = true;
    const tab = document.getElementById('tabAdmin');
    if (tab) tab.style.display = '';
    const rtab = document.getElementById('tabRebuild');
    if (rtab) rtab.style.display = '';
    buildCustHeader();          // reveal the admin-only Edit column
    renderCustTable();
    initRebuild();
    renderAdminKpisLists();
    const rb = document.getElementById('admRefresh');
    if (rb) rb.onclick = async () => { await loadAdminMetrics(); renderAdminKpisLists(); renderAdminCharts(); toast('Admin metrics refreshed'); };
  });
}

async function loadAdminMetrics() {
  try {
    const r = await fetch('/api/admin/metrics?key=' + encodeURIComponent(State.adminKey || ''));
    if (!r.ok) return false;
    State.adminMetrics = await r.json();
    return true;
  } catch (e) { return false; }
}

function renderAdminKpisLists() {
  const m = State.adminMetrics; if (!m) return;
  const k = m.kpis || {};
  setText('admGen', 'data as of ' + (m.generated || '—'));
  const cards = [
    ['Bot queries', k.queries, ''], ['Match rate', (k.match_rate || 0) + '%', 'ok'],
    ['Avg clicks / week', k.avg_clicks_per_week, 'abap'],
    ['Unique questions', k.unique_questions, ''], ['Live SAP searches', k.live_searches, 'abap'],
    ['Teachings', k.teachings, 'bw'], ['Feedback given', k.feedback_total, 'warn'],
    ['Drawer opens', k.drawer_opens, ''], ['Excel exports', k.exports, ''],
    ['Refreshes', k.refreshes, ''], ['Unique users', k.unique_users, 'ok'],
    ['Active days', k.active_days, ''], ['Total events', k.total_events, ''],
  ];
  document.getElementById('admKpis').innerHTML = cards.map(([l, v, c]) =>
    `<div class="kpi ${c}"><div class="k-label">${l}</div><div class="k-val">${v ?? 0}</div></div>`).join('');

  const liRow = (kk, vv) => `<div class="li"><span class="lk">${esc(kk)}</span><span class="lv">${esc(vv)}</span></div>`;
  document.getElementById('admTopQ').innerHTML =
    (m.top_questions || []).map(([q, n]) => liRow(q, n)).join('') || '<div class="muted">No queries yet.</div>';
  document.getElementById('admTopT').innerHTML =
    (m.top_teachers || []).map(([a, n]) => liRow(a || 'unknown', n)).join('') || '<div class="muted">No teachings yet.</div>';
  const repo = m.repo || {};
  document.getElementById('admMisc').innerHTML =
    liRow('Custom objects', repo.custom || 0) + liRow('Process areas', repo.processAreas || 0)
    + liRow('ABAP objects', (repo.byDomain || {}).ABAP || 0) + liRow('BW objects', (repo.byDomain || {}).BW || 0)
    + (m.users || []).slice(0, 8).map(u => liRow('user: ' + u, '●')).join('');
}

function renderAdminCharts() {
  const m = State.adminMetrics; if (!m) return;
  const daily = m.queries_per_day || [];
  makeChart('admDaily', { type: 'bar',
    data: { labels: daily.map(d => d.day.slice(5)),
      datasets: [{ data: daily.map(d => d.n), backgroundColor: '#4f8cff', borderRadius: 6 }] },
    options: barOpts() });
  const tabs = m.tab_views || {};
  makeChart('admTabs', { type: 'doughnut',
    data: { labels: Object.keys(tabs),
      datasets: [{ data: Object.values(tabs),
        backgroundColor: ['#4f8cff', '#22d3ee', '#f5b942', '#2dd4a7', '#f472b6'],
        borderColor: '#0b1020', borderWidth: 2 }] },
    options: doughnutOpts('right') });
  const fb = m.feedback || {};
  makeChart('admFb', { type: 'bar',
    data: { labels: ['👍 up', '👎 down', '✕ hide'],
      datasets: [{ data: [fb.up || 0, fb.down || 0, fb.hide || 0],
        backgroundColor: ['#2dd4a7', '#f5b942', '#ff6b81'], borderRadius: 6 }] },
    options: barOpts() });
  const wk = m.clicks_per_week || [];
  makeChart('admClicks', { type: 'line',
    data: { labels: wk.map(w => w.week),
      datasets: [{ data: wk.map(w => w.n), label: 'clicks',
        borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,.15)',
        fill: true, tension: 0.3, pointRadius: 3 }] },
    options: barOpts() });
}

boot();
