const backdrop = document.getElementById('backdrop');
const card = document.getElementById('card');
const closeBtn = document.getElementById('close-btn');
const modeSwitch = document.getElementById('mode-switch');
const idleSelect = document.getElementById('idle-select');
const tabsCheckbox = document.getElementById('tabs-checkbox');
const tableEl = document.getElementById('table');
const tableBody = document.getElementById('table-body');
const emptyEl = document.getElementById('empty');

const STATES = ['never', 'default', 'always'];

function nextState(state) {
  return STATES[(STATES.indexOf(state) + 1) % STATES.length];
}

function stateLabel(state) {
  return state[0].toUpperCase() + state.slice(1);
}

// Same single-sliding-switch component as permissions-page/index.js's own
// buildToggle — see index.html's .toggle comment for the Never/Default/
// Always position and color scheme.
function buildToggle(appId, policy) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toggle';
  btn.dataset.state = policy;
  btn.setAttribute('aria-label', 'Hibernate when idle');

  const knob = document.createElement('span');
  knob.className = 'knob';
  btn.appendChild(knob);

  const tip = document.createElement('span');
  tip.className = 'toggle-tip';
  tip.textContent = stateLabel(policy);
  btn.appendChild(tip);

  let current = policy;
  btn.addEventListener('click', () => {
    current = nextState(current);
    btn.dataset.state = current;
    tip.textContent = stateLabel(current);
    window.hibernationPageAPI.setAppPolicy(appId, current);
  });

  return btn;
}

function buildAppRow(row) {
  const tr = document.createElement('tr');

  const appTd = document.createElement('td');
  appTd.className = 'app-cell';
  appTd.textContent = row.hostname || row.title;
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

  const toggleTd = document.createElement('td');
  toggleTd.appendChild(buildToggle(row.id, row.policy));
  tr.appendChild(toggleTd);

  return tr;
}

function setMode(mode) {
  modeSwitch.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

modeSwitch.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setMode(btn.dataset.mode);
    window.hibernationPageAPI.setMode(btn.dataset.mode);
  });
});

idleSelect.addEventListener('change', () => {
  window.hibernationPageAPI.setIdleMinutes(Number(idleSelect.value));
});

tabsCheckbox.addEventListener('change', () => {
  window.hibernationPageAPI.setTabsEnabled(tabsCheckbox.checked);
});

function close() {
  window.hibernationPageAPI.close();
}

window.hibernationPageAPI.onOpen((payload) => {
  setMode(payload.mode);
  idleSelect.value = String(payload.idleMinutes);
  tabsCheckbox.checked = payload.tabsEnabled;

  tableBody.innerHTML = '';
  const hasRows = payload.rows.length > 0;
  tableEl.hidden = !hasRows;
  emptyEl.hidden = hasRows;
  if (hasRows) payload.rows.forEach((row) => tableBody.appendChild(buildAppRow(row)));
  requestAnimationFrame(() => backdrop.classList.add('visible'));
});

window.hibernationPageAPI.onClose(() => {
  backdrop.classList.add('no-transition');
  backdrop.classList.remove('visible');
  void card.offsetWidth;
  backdrop.classList.remove('no-transition');
});

closeBtn.addEventListener('click', close);

backdrop.addEventListener('click', (e) => {
  if (e.target === backdrop) close();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
});

window.hibernationPageAPI.onThemeChanged(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
