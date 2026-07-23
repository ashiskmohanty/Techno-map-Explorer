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
  l1Filter: null,    // selected Level-1 process area (drill-down)
};

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
  try {
    const r = await fetch('data.json', { cache: 'no-store' });
    if (r.ok) data = await r.json();
  } catch (e) { /* file:// — fall through */ }
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
  State.edges.forEach(e => {
    if (RENAME[e.source]) e.source = RENAME[e.source];
    if (RENAME[e.target]) e.target = RENAME[e.target];
  });
  // env / connection state
  document.getElementById('envText').textContent = data.environment || 'SAP MS1';
  const dot = document.getElementById('connDot');
  if ((data.source || 'offline') === 'live') dot.classList.remove('offline');
  else dot.classList.add('offline');
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
      if (v === 'depmap') renderDepGraph();
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
  return L2_TO_L1[l2name] || 'Other';
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
  const els = buildElements(objs, { onlyConnected: true });
  const info = document.getElementById('dgInfo');
  if (!els.length) {
    container.innerHTML = '<div class="empty">No linked dependencies for this process — see the object hierarchy above.</div>';
    if (info) info.textContent = '';
    return;
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
  // enrich with real SAP where-used edges when a live session is available
  if (State.data && State.data.source === 'live') enrichWhereUsed(objs);
}

/* pull live where-used edges from SAP and merge them into the flow map */
async function enrichWhereUsed(objs) {
  const cy = State.drawerCy;
  if (!cy) return;
  const names = objs.filter(o => o.domain === 'ABAP').map(o => o.name);
  if (!names.length) return;
  try {
    const r = await fetch('/api/sap/whereused', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    if (!r.ok) return;
    const res = await r.json();
    const edges = res.edges || [];
    if (!edges.length || cy !== State.drawerCy) return;
    let added = 0;
    edges.forEach(e => {
      if (!cy.getElementById(e.target).length) {
        cy.add({ group: 'nodes', data: { id: e.target, label: e.target, color: '#f472b6', cat: 'ABAP', proc: '', size: 18 } });
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
      const info = document.getElementById('dgInfo');
      if (info) info.textContent = `${cy.nodes().length} nodes · ${cy.edges().length} edges · SAP where-used`;
    }
  } catch (e) { /* offline / not configured - keep local edges */ }
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
    if (!els.length) { container.innerHTML = '<div class="empty">No linked dependencies to display for this selection.</div>'; return; }
    container.innerHTML = '';
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
  { key: 'process', label: 'Process Area' },
  { key: 'package', label: 'Package' },
  { key: 'author', label: 'Author' },
  { key: 'created', label: 'Created / Last Used' },
  { key: 'validity', label: 'Validity' },
];

function initCustom() {
  const labels = document.getElementById('custHeadLabels');
  const filters = document.getElementById('custHeadFilters');
  labels.innerHTML = CUST_COLS.map(c => `<th><div class="th-l" data-sort="${c.key}">${c.label} <span class="muted">⇅</span></div></th>`).join('');
  filters.innerHTML = CUST_COLS.map(c => `<th><input data-col="${c.key}" placeholder="filter *"/></th>`).join('');

  filters.querySelectorAll('input').forEach(inp =>
    inp.addEventListener('input', () => { State.custFilters[inp.dataset.col] = inp.value; renderCustTable(); }));
  labels.querySelectorAll('[data-sort]').forEach(th =>
    th.addEventListener('click', () => { sortCust(th.dataset.sort); }));
  document.getElementById('custSearch').addEventListener('input', e => { State.custSearch = e.target.value; renderCustTable(); });
  document.getElementById('btnExport').addEventListener('click', exportExcel);
  document.getElementById('btnRefresh').addEventListener('click', refreshFromSap);

  State.custSort = { key: 'name', dir: 1 };
  renderCustTable();
}

function getCustRows() {
  let rows = State.objects.filter(o => o.custom);
  // global search
  if (State.custSearch.trim()) {
    const q = State.custSearch;
    rows = rows.filter(o => CUST_COLS.some(c => wildcard(q, o[c.key])) || wildcard(q, o.name));
  }
  // per-column
  Object.entries(State.custFilters).forEach(([col, pat]) => {
    if (pat && pat.trim()) rows = rows.filter(o => wildcard(pat, o[col]));
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
    <td>${esc(o.process)}</td>
    <td class="mono muted">${esc(o.package)}</td>
    <td>${esc(o.author)}</td>
    <td class="muted">${esc(o.created)}</td>
    <td>${valBadge(o.validity) || '<span class="muted">—</span>'}</td>
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
  ws['!cols'] = CUST_COLS.map((c, i) => ({ wch: [34, 44, 18, 8, 20, 18, 14, 18, 10][i] || 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Custom Objects');
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `PS_Custom_Objects_MS1_${stamp}.xlsx`);
  toast(`Exported ${rows.length} objects to Excel`);
}

/* ---------- Refresh from SAP MS1 ---------- */
async function refreshFromSap() {
  const btn = document.getElementById('btnRefresh');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Connecting to MS1…';
  try {
    const r = await fetch('/api/refresh', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = await r.json();
    if (res.status === 'ok' && res.data) {
      applyData(res.data);
      initProcess(); initTech(); renderCustTable();
      const live = (res.data.source === 'live');
      toast(`${live ? 'Live refresh from ' : 'Rebuilt from '}${res.source || 'SAP MS1'} · ` +
            `${res.data.objects.length} objects`, !live);
      if (!live && res.message) setTimeout(() => toast(res.message, true), 3200);
    } else {
      toast('Refresh returned: ' + (res.message || 'no data'), true);
    }
  } catch (e) {
    toast('SAP refresh needs the backend (python app.py) with RFC creds. ' +
          'Open ⚙ SAP Connection to configure MS1.', true);
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
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
  };
  if (pkgs.length) cfg.packages = pkgs;
  return cfg;
}

function setSapStatus(msg, kind) {
  const el = document.getElementById('sapStatus');
  if (!el) return;
  el.className = 'conn-status show ' + (kind || 'info');
  el.innerHTML = esc(msg);
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

    updateConnDot(s);
    if (!silent) {
      if (!s.pyrfc)
        setSapStatus('Backend is up but <b>pyrfc / SAP RFC SDK is not installed</b>. ' +
                     'Install it to enable live reads (pip install pyrfc).', 'err');
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
  const dot = document.getElementById('connDot');
  const live = (State.data && State.data.source === 'live');
  if (live || (s && s.configured && s.pyrfc)) dot.classList.remove('offline');
  else dot.classList.add('offline');
}

async function sapTest() {
  const btn = document.getElementById('sapTest');
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Testing…';
  setSapStatus('Opening a session to SAP MS1…', 'info');
  try {
    const r = await fetch('/api/sap/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sapForm()),
    });
    const res = await r.json();
    if (res.ok)
      setSapStatus(`✅ Connected to <b>${esc(res.system || 'MS1')}</b> ` +
                   `(release ${esc(res.release || '?')}, host ${esc(res.host || '?')}) ` +
                   `as ${esc(res.user)} · client ${esc(res.client)}.`, 'ok');
    else
      setSapStatus('❌ ' + esc(res.error || 'Connection failed'), 'err');
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
    FIELDS.forEach(f => {
      const val = (o[f.key] || '').toString().toLowerCase();
      if (!val) return;
      const words = new Set(val.split(/[^a-z0-9/_]+/).filter(Boolean));
      tokens.forEach(t => {
        if (words.has(t)) { score += f.w * 2; hits.add(t); }        // exact word
        else if (val.includes(t)) { score += f.w; hits.add(t); }     // substring
      });
    });
    // phrase / bigram bonus in description or name
    const dn = ((o.description || '') + ' ' + o.name).toLowerCase();
    for (let i = 0; i < tokens.length - 1; i++) {
      if (dn.includes(tokens[i] + ' ' + tokens[i + 1])) score += 3;
    }
    // intent-category boost
    if (intentCats.size && intentCats.has(o.category)) score += 4;
    // small boost for having a real description (more informative match)
    if (o.description) score += 0.3;
    return { o, score, hits: [...hits] };
  }).filter(r => r.score > 0 && r.hits.length);

  scored.sort((a, b) => b.score - a.score || (b.o.description || '').length - (a.o.description || '').length);
  const top = scored.slice(0, limit);
  const max = top.length ? top[0].score : 1;
  top.forEach(r => r.pct = Math.round(Math.min(100, r.score / max * 100)));
  return top;
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

  function greet() {
    addBot(`Hi! Ask me in plain English and I'll match your words against the <b>descriptions</b>, `
      + `names and technical details of every custom ABAP & BW object — and, when SAP MS1 is connected, `
      + `the <b>comments inside the ABAP / FOX code</b> too.`
      + `<div class="achips">`
      + chip('Which FM deletes cube data?')
      + chip('Forecast revenue query')
      + chip('Planning function to copy FF revenue')
      + chip('Release and activate project')
      + `</div>`);
  }
  function chip(t) { return `<span class="achip" data-q="${esc(t)}">${esc(t)}</span>`; }

  function addUser(t) {
    const d = document.createElement('div'); d.className = 'msg user'; d.textContent = t;
    body.appendChild(d); body.scrollTop = body.scrollHeight;
  }
  function addBot(html) {
    const d = document.createElement('div'); d.className = 'msg bot'; d.innerHTML = html;
    body.appendChild(d); body.scrollTop = body.scrollHeight;
    d.querySelectorAll('.achip').forEach(c => c.addEventListener('click', () => { input.value = c.dataset.q; ask(); }));
    d.querySelectorAll('.open2').forEach(a => a.addEventListener('click', () => openObject(a.dataset.name)));
    return d;
  }

  async function ask() {
    const q = input.value.trim();
    if (!q) return;
    addUser(q); input.value = '';
    const results = rankObjects(q);
    if (!results.length) {
      addBot(`I couldn't find a matching custom object for that. Try naming the action or data `
        + `(e.g. "delete cube", "forecast revenue", "amendment", "cost rate").`);
      return;
    }
    addBot(renderResults(q, results));
    // enrich with SAP code-comment matches when a live session exists
    if (State.data && State.data.source === 'live') enrichWithComments(q, results);
  }

  window.__assistantAsk = ask; // allow programmatic asks
}

function renderResults(q, results) {
  const best = results[0];
  const line = (r, i) => {
    const o = r.o;
    return `<div class="arow${i === 0 ? ' best' : ''}" id="am-${cssId(o.name)}">
      <span class="dotd ${o.domain === 'ABAP' ? 'abap' : 'bw'}"></span>
      <a class="rn open2" data-name="${esc(o.name)}">${esc(o.name)}</a>
      <span class="rc">${esc(o.category)}</span>
      <span class="rp">${r.pct}%</span>
    </div>`;
  };
  let html = `<div class="lead">Top match: <b>${esc(best.o.name)}</b> · ${esc(best.o.category)} (${best.o.domain})</div>`;
  html += results.map(line).join('');
  return html;
}

function cssId(s) { return (s || '').replace(/[^a-z0-9]/gi, '_'); }

/* open the process drawer for a matched object (and highlight it) */
function openObject(name) {
  const o = State.objects.find(x => x.name === name);
  if (!o) return;
  openDrawer(o.process);
}

/* live: ask backend to scan ABAP/FOX code comments for the question terms */
async function enrichWithComments(question, results) {
  try {
    const names = results.map(r => r.o.name);
    const r = await fetch('/api/assistant/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, names }),
    });
    if (!r.ok) return;
    const res = await r.json();
    const byName = res.matches || {};
    Object.entries(byName).forEach(([name, snippets]) => {
      const row = document.getElementById('am-' + cssId(name));
      if (row && snippets && snippets.length) {
        const div = document.createElement('div');
        div.className = 'cmtline';
        div.innerHTML = '💬 ' + esc(snippets[0]);
        row.insertAdjacentElement('afterend', div);
      }
    });
  } catch (e) { /* offline / not available */ }
}

boot();
