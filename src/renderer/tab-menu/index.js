const menu = document.getElementById('menu');
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url-input');
const promoteBtn = document.getElementById('promote-btn');
const setPrimaryBtn = document.getElementById('set-primary-btn');

window.tabMenuAPI.onOpen(({ url, isPrimary }) => {
  urlInput.value = url;
  // "Open as new app" and "Set as primary" only make sense for a secondary
  // tab — the primary view is already the app, and can't be set as itself.
  promoteBtn.hidden = isPrimary;
  setPrimaryBtn.hidden = isPrimary;

  requestAnimationFrame(() => menu.classList.add('visible'));
});

window.tabMenuAPI.onClose(() => {
  // Instant, not transitioned — see #menu.no-transition's comment in
  // index.html for why animating this removal broke the *next* open's
  // animation.
  menu.classList.add('no-transition');
  menu.classList.remove('visible');
  void menu.offsetWidth; // force the instant state to commit before transitions come back
  menu.classList.remove('no-transition');
});

urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = urlInput.value.trim();
  if (value) window.tabMenuAPI.navigate(value);
});

document.getElementById('duplicate-btn').addEventListener('click', () => window.tabMenuAPI.duplicate());
promoteBtn.addEventListener('click', () => window.tabMenuAPI.promote());
setPrimaryBtn.addEventListener('click', () => window.tabMenuAPI.setPrimary());
document.getElementById('external-btn').addEventListener('click', () => window.tabMenuAPI.openExternal());

window.tabMenuAPI.onThemeChanged(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
