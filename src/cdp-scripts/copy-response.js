(async () => {
  const clickId = __CLICK_ID__;
  const colonIdx = clickId.indexOf(':');
  if (colonIdx === -1) return { ok: false, reason: 'invalid_click_id' };
  const source = clickId.substring(0, colonIdx);
  const idx = parseInt(clickId.substring(colonIdx + 1), 10);

  // Find root — same logic as click handler
  let root = null;
  if (source === 'chat') {
    root = findChatContainer();
  }
  if (!root) return { ok: false, reason: 'no_root' };

  // Build same interactive element list as capture/click
  const maxLen = (source === 'chat') ? 80 : 0;
  const visible = buildInteractiveList(root, false, maxLen);

  const target = visible[idx];
  if (!target) return { ok: false, reason: 'element_not_found', idx, total: visible.length };

  // Intercept clipboard.writeText to capture markdown
  let captured = null;
  const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (text) => {
    captured = text;
    return orig(text);
  };
  try {
    target.click();
    await new Promise(r => setTimeout(r, 300));
  } finally {
    navigator.clipboard.writeText = orig;
  }
  return { ok: true, text: captured || '' };
})()
