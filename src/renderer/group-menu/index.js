const menu = document.getElementById('menu');
const labelForm = document.getElementById('label-form');
const labelInput = document.getElementById('label-input');
const swatchRow = document.getElementById('swatches');

// Duplicated from main/ipc.js's GROUP_COLORS — separate page, can't share
// that module directly, so kept in sync by hand (same reasoning as this
// page's CSS palette, see index.html's comment).
const COLORS = [
  { label: 'No color', value: null },
  { label: 'Blue', value: '#4c8bf5' },
  { label: 'Green', value: '#34a853' },
  { label: 'Yellow', value: '#f2b84b' },
  { label: 'Orange', value: '#f2994a' },
  { label: 'Red', value: '#eb5757' },
  { label: 'Pink', value: '#e056a0' },
  { label: 'Purple', value: '#9b6bdf' },
  { label: 'Cyan', value: '#29b6b0' },
];

const swatchButtons = COLORS.map(({ label, value }) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = label;
  btn.className = value ? 'swatch' : 'swatch swatch-none';
  if (value) {
    // Sets both background and (text) color to the same hex so the
    // selected-state ring in index.html can key off currentColor instead
    // of needing a separate CSS rule per swatch.
    btn.style.background = value;
    btn.style.color = value;
  }
  btn.addEventListener('click', () => {
    setSelected(value);
    window.groupMenuAPI.setColor(value);
  });
  swatchRow.appendChild(btn);
  return { value, btn };
});

function setSelected(color) {
  swatchButtons.forEach(({ value, btn }) => btn.classList.toggle('selected', value === color));
}

window.groupMenuAPI.onOpen(({ label, color }) => {
  labelInput.value = label || '';
  setSelected(color);
  requestAnimationFrame(() => menu.classList.add('visible'));
});

window.groupMenuAPI.onClose(() => {
  // Instant, not transitioned — see tab-menu/index.js's identical
  // no-transition dance for why animating this removal broke the *next*
  // open's animation.
  menu.classList.add('no-transition');
  menu.classList.remove('visible');
  void menu.offsetWidth; // force the instant state to commit before transitions come back
  menu.classList.remove('no-transition');
});

// Picking a color doesn't close the menu — it's meant to stay open for
// further edits (the label too), unlike a one-shot native menu selection.
// Only an explicit dismissal (Escape, submitting the label, or clicking
// elsewhere in the sidebar — see sidebar/index.js) closes it.
labelForm.addEventListener('submit', (e) => {
  e.preventDefault();
  window.groupMenuAPI.setLabel(labelInput.value.trim());
  window.groupMenuAPI.close();
});
labelInput.addEventListener('blur', () => window.groupMenuAPI.setLabel(labelInput.value.trim()));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.groupMenuAPI.close();
});

window.groupMenuAPI.onThemeChanged(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
