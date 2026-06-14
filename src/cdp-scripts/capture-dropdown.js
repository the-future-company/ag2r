(() => {
  for (const child of document.body.children) {
    if (child.getAttribute('role') === 'listbox' && child.getBoundingClientRect().width > 0) {
      let idx = 0;
      const tagged = [];
      child.querySelectorAll('[role="option"], button, a').forEach(el => {
        el.setAttribute('data-ag-click-id', 'scheddlg:' + (100 + idx));
        el.setAttribute('data-ag-click-label', el.textContent.trim().substring(0, 50));
        idx++;
        tagged.push(el);
      });
      const clone = child.cloneNode(true);
      tagged.forEach(el => {
        el.removeAttribute('data-ag-click-id');
        el.removeAttribute('data-ag-click-label');
      });
      return clone.outerHTML;
    }
  }
  return null;
})()
