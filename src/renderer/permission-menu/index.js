const menu = document.getElementById('menu');
const titleEl = document.getElementById('title');
const closeBtn = document.getElementById('close-btn');
const rowsEl = document.getElementById('rows');

const STATES = ['ask', 'allow', 'block'];

function iconSvg(inner) {
  return `<svg class="perm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function buildRow(permission) {
  const row = document.createElement('div');
  row.className = 'perm-row';

  const label = document.createElement('span');
  label.className = 'perm-label';
  label.innerHTML = `${iconSvg(permission.icon)}<span>${permission.label}</span>`;
  row.appendChild(label);

  const segmented = document.createElement('div');
  segmented.className = 'segmented';
  STATES.forEach((state) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.state = state;
    btn.textContent = state[0].toUpperCase() + state.slice(1);
    btn.classList.toggle('active', permission.state === state);
    btn.addEventListener('click', () => {
      segmented.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      window.permissionMenuAPI.setState(permission.key, state);
    });
    segmented.appendChild(btn);
  });
  row.appendChild(segmented);

  return row;
}

window.permissionMenuAPI.onOpen(({ title, permissions }) => {
  titleEl.textContent = title;
  rowsEl.innerHTML = '';
  permissions.forEach((permission) => rowsEl.appendChild(buildRow(permission)));
  requestAnimationFrame(() => menu.classList.add('visible'));
});

window.permissionMenuAPI.onClose(() => {
  menu.classList.add('no-transition');
  menu.classList.remove('visible');
  void menu.offsetWidth;
  menu.classList.remove('no-transition');
});

closeBtn.addEventListener('click', () => window.permissionMenuAPI.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.permissionMenuAPI.close();
});

window.permissionMenuAPI.onThemeChanged(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
