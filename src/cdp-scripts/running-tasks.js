export const RUNNING_TASKS_SCRIPT = `
(() => {
  const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
  if (!inputBox) return null;
  const taskSection = inputBox.querySelector('.rounded-t-2xl');
  if (!taskSection || taskSection.getBoundingClientRect().height <= 0) return null;
  // Verify this section actually contains running tasks — not just a structural wrapper.
  // Real task sections have: 1 header toggle button + N task name buttons + N stop buttons.
  // If fewer than 3 buttons (header + 1 name + 1 stop), there are no real tasks.
  const allBtns = taskSection.querySelectorAll('button');
  if (allBtns.length < 3) return null;
  let taskIdx = 0;
  const taskTagged = [];
  taskSection.querySelectorAll('button').forEach(btn => {
    btn.setAttribute('data-ag-click-id', 'task:' + taskIdx);
    btn.setAttribute('data-ag-click-label', (btn.textContent || '').trim().substring(0, 80));
    taskIdx++;
    taskTagged.push(btn);
  });
  const taskClone = taskSection.cloneNode(true);
  taskTagged.forEach(el => {
    el.removeAttribute('data-ag-click-id');
    el.removeAttribute('data-ag-click-label');
  });
  return taskClone.outerHTML;
})()
`;
