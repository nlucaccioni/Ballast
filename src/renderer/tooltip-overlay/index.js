const tooltip = document.getElementById('tooltip');

window.tooltipAPI.onUpdate(({ text, visible }) => {
  if (visible && text) {
    tooltip.textContent = text;
    tooltip.hidden = false;
  } else {
    tooltip.hidden = true;
  }
});
