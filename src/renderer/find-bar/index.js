const bar = document.getElementById('bar');
const input = document.getElementById('find-input');
const count = document.getElementById('count');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const closeBtn = document.getElementById('close-btn');

function setCount({ activeMatchOrdinal, matches } = {}) {
  const hasText = input.value.length > 0;
  count.textContent = hasText ? `${matches ? activeMatchOrdinal : 0}/${matches || 0}` : '';
  prevBtn.disabled = nextBtn.disabled = !matches;
}

// Typing starts a fresh search from the top; Enter/the arrows step through
// the matches of the current one (see ViewManager.findInFocused).
function find(forward) {
  window.findBarAPI.find(input.value, forward);
  if (!input.value) setCount();
}

window.findBarAPI.onOpen(({ text, alreadyOpen }) => {
  if (!alreadyOpen) {
    input.value = text || '';
    setCount();
    if (input.value) find(true);
  }
  input.focus();
  input.select();
  requestAnimationFrame(() => bar.classList.add('visible'));
});

window.findBarAPI.onClose(() => {
  // Instant, not transitioned — see tab-menu/index.js's identical
  // no-transition dance.
  bar.classList.add('no-transition');
  bar.classList.remove('visible');
  void bar.offsetWidth; // force the instant state to commit before transitions come back
  bar.classList.remove('no-transition');
});

window.findBarAPI.onResult(setCount);

input.addEventListener('input', () => find(true));
prevBtn.addEventListener('click', () => find(false));
nextBtn.addEventListener('click', () => find(true));
closeBtn.addEventListener('click', () => window.findBarAPI.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.findBarAPI.close();
  } else if (e.key === 'Enter' || e.key === 'F3') {
    e.preventDefault();
    find(!e.shiftKey);
  } else if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey)) {
    // Ctrl+F again while already open just reselects the query, like a browser.
    e.preventDefault();
    input.select();
  }
});

window.findBarAPI.onThemeChanged(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
