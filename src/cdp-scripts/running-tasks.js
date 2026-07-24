export const RUNNING_TASKS_SCRIPT = `
(() => {
  const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
  if (!inputBox) return null;
  const taskSection = inputBox.querySelector('.rounded-t-2xl');
  if (!taskSection || taskSection.getBoundingClientRect().height <= 0) return null;
  // Verify this section actually contains running tasks or goals — not just a structural wrapper.
  // Task rows have: name button + stop button. Goal rows have: name button only (no stop).
  // Minimum viable: 1 header toggle button + 1 name button = 2 buttons.
  const allBtns = taskSection.querySelectorAll('button');
  if (allBtns.length < 2) return null;
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
