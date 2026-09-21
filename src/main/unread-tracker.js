// Strategy: title-count — e.g. document.title becomes "Inbox (3) - Gmail"
function watchTitleCount(view, onChange) {
  view.webContents.on('page-title-updated', (event, title) => {
    const match = title.match(/\((\d+)\)/);
    onChange(match ? parseInt(match[1], 10) : 0);
  });
}

module.exports = { watchTitleCount };
