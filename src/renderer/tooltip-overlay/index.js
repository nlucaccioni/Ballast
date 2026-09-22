const tooltip = document.getElementById('tooltip');
const tooltipLabel = document.getElementById('tooltip-label');
const tooltipTitle = document.getElementById('tooltip-title');

window.tooltipAPI.onUpdate(({ title, label, visible }) => {
  if (visible && title) {
    tooltipTitle.textContent = title;
    tooltipLabel.textContent = label || '';
    tooltipLabel.hidden = !label;
    // display:none -> displayed *and* adding .visible in the same tick can
    // get coalesced into one style recalc with nothing painted in between —
    // a single requestAnimationFrame isn't reliably late enough to avoid
    // that. Forcing a synchronous reflow (reading a layout property) between
    // the two guarantees the "not visible" state actually commits first, so
    // there's something real for the transition to animate from. Same
    // void-offsetWidth trick tab-menu/group-menu use for their close path,
    // just applied on entry here instead of exit.
    tooltip.classList.remove('visible');
    tooltip.hidden = false;
    void tooltip.offsetWidth;
    tooltip.classList.add('visible');
  } else {
    tooltip.hidden = true;
    tooltip.classList.remove('visible');
  }
});

window.tooltipAPI.onThemeChanged(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
