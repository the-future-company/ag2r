(() => {
  const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
  if (!inputBox) return { ok: false, reason: 'no_input_box' };
  const taskSection = inputBox.querySelector('.rounded-t-2xl');
  if (!taskSection) return { ok: false, reason: 'no_task_section' };
  const btns = taskSection.querySelectorAll('button');
  const idx = __TASK_IDX__;
  if (idx < 0 || idx >= btns.length) return { ok: false, reason: 'task_index_out_of_range', total: btns.length };
  const target = btns[idx];
  const actualLabel = (target.textContent || '').trim().substring(0, 80);
  target.click();
  return { ok: true, label: actualLabel, source: 'task' };
})()
