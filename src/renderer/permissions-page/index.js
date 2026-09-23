const backdrop = document.getElementById('backdrop');
const card = document.getElementById('card');
const closeBtn = document.getElementById('close-btn');
const headerRow = document.getElementById('header-row');
const tableEl = document.getElementById('table');
const tableBody = document.getElementById('table-body');
const emptyEl = document.getElementById('empty');

const STATES = ['ask', 'allow', 'block'];

function nextState(state) {
  return STATES[(STATES.indexOf(state) + 1) % STATES.length];
}

// Column metadata (currently just label — icons dropped from this page's
// header to match the simpler plain-text column headers of the reference
// layout; the per-app popover still shows them) — set once per onOpen,
// read by every row build afterward (see view-manager.js's
// openPermissionsPage).
let columns = [];

function buildHeader() {
  headerRow.innerHTML = '';
  const appTh = document.createElement('th');
  appTh.textContent = 'App';
  headerRow.appendChild(appTh);
  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = column.label;
    headerRow.appendChild(th);
  });
}

function stateLabel(state) {
  return state[0].toUpperCase() + state.slice(1);
}

// A single sliding tri-state switch rather than three separate buttons —
// see index.html's .toggle comment for the Ask/Allow/Block position and
// color scheme. One click cycles through all three, same interaction the
// old three-button version used. The .toggle-tip child shows the current
// state on hover (see index.html's own comment for the pure-CSS 0.5s
// reveal delay) — its text has to be kept in sync here rather than read
// via CSS attr(data-state), since that can't be capitalized cleanly.
function buildToggle(appId, permission) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toggle';
  btn.dataset.state = permission.state;
  btn.setAttribute('aria-label', permission.label);

  const knob = document.createElement('span');
  knob.className = 'knob';
  btn.appendChild(knob);

  const tip = document.createElement('span');
  tip.className = 'toggle-tip';
  tip.textContent = stateLabel(permission.state);
  btn.appendChild(tip);

  let current = permission.state;
  btn.addEventListener('click', () => {
    current = nextState(current);
    btn.dataset.state = current;
    tip.textContent = stateLabel(current);
    window.permissionsPageAPI.setState(appId, permission.key, current);
  });

  return btn;
}

function buildAppRow(row) {
  const tr = document.createElement('tr');

  // Hostname first (bold) — a stable identifier — with the live page title
  // (which drifts as the page navigates, e.g. "Google Calendar - September
  // 2026") underneath as secondary detail, not the other way around.
  const appTd = document.createElement('td');
  appTd.className = 'app-cell';
  appTd.textContent = row.hostname || row.title;
  // A group's accent color as a slim left-edge bar (see index.html's own
  // .group-bar comment) — appended after textContent above, which would
  // otherwise wipe it out (textContent replaces all children). Color is
  // set inline since it comes from the group's own stored color, not
  // something CSS alone can express; an ungrouped app just gets the bar
  // with the stylesheet's default transparent background.
  const groupBar = document.createElement('span');
  groupBar.className = 'group-bar';
  if (row.groupColor) groupBar.style.background = row.groupColor;
  appTd.appendChild(groupBar);
  if (row.title) {
    const titleSpan = document.createElement('span');
    titleSpan.className = 'app-title';
    titleSpan.textContent = row.title;
    appTd.appendChild(titleSpan);
  }
  tr.appendChild(appTd);

  row.permissions.forEach((permission) => {
    const td = document.createElement('td');
    td.appendChild(buildToggle(row.id, permission));
    tr.appendChild(td);
  });

  return tr;
}

function close() {
  window.permissionsPageAPI.close();
}

window.permissionsPageAPI.onOpen((payload) => {
  columns = payload.columns;
  tableBody.innerHTML = '';
  const hasRows = payload.rows.length > 0;
  tableEl.hidden = !hasRows;
  emptyEl.hidden = hasRows;
  if (hasRows) {
    buildHeader();
    payload.rows.forEach((row) => tableBody.appendChild(buildAppRow(row)));
  }
  requestAnimationFrame(() => backdrop.classList.add('visible'));
});

window.permissionsPageAPI.onClose(() => {
  backdrop.classList.add('no-transition');
  backdrop.classList.remove('visible');
  void card.offsetWidth;
  backdrop.classList.remove('no-transition');
});

closeBtn.addEventListener('click', close);

// Clicking the backdrop itself (not the card) closes — clicks inside the
// card are on the card or its children, never the backdrop element itself.
backdrop.addEventListener('click', (e) => {
  if (e.target === backdrop) close();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
});

window.permissionsPageAPI.onThemeChanged(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
