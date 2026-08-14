// settings.js — backup export / restore import, plus danger zone.
// Uses globals from app.js: el, $, toast, show.
(function () {

function render() {
  const scr = $('#screen-settings');
  scr.innerHTML = '';
  const wrap = el('div', 'wrap');
  wrap.appendChild(el('div', 'h-section', 'Settings'));

  // Data summary
  const tpls = window.Store.getTemplates().length;
  const sessions = window.Store.completedSessions().length;
  const info = el('div', 'tpl-card');
  info.appendChild(el('div', 'tpl-meta', 'Stored locally on this device'));
  info.appendChild(el('div', 'settings-stat', `${tpls} templates · ${sessions} sessions`));
  wrap.appendChild(info);

  wrap.appendChild(el('div', 'h-section', 'Rest bell'));

  const testBtn = el('button', 'btn btn-block', '🔔 Test bell');
  testBtn.onclick = () => { window.Bell.test(); toast('Ringing'); };
  wrap.appendChild(testBtn);

  wrap.appendChild(toggleRow('Bell sound', null, 'bellEnabled', true));
  wrap.appendChild(toggleRow(
    'Ring when the app is closed',
    'Pauses your music during rest',
    'bgBellEnabled', true));

  wrap.appendChild(el('div', 'h-section', 'Backup'));

  const exportBtn = el('button', 'btn btn-primary btn-block', '⭳ Export all data (JSON)');
  exportBtn.onclick = doExport;
  wrap.appendChild(exportBtn);

  const importBtn = el('button', 'btn btn-block', '⭱ Import / restore from file');
  importBtn.style.marginTop = '10px';
  const fileIn = el('input');
  fileIn.type = 'file'; fileIn.accept = 'application/json,.json'; fileIn.style.display = 'none';
  fileIn.onchange = () => { if (fileIn.files[0]) doImport(fileIn.files[0]); };
  importBtn.onclick = () => fileIn.click();
  wrap.append(importBtn, fileIn);

  wrap.appendChild(el('div', 'meta-line', 'Weight in lbs · single-user · no account, no cloud'));

  // Danger zone
  wrap.appendChild(el('div', 'h-section', 'Danger zone'));
  const wipe = el('button', 'btn btn-danger btn-block', 'Erase all data');
  wipe.onclick = () => {
    if (confirm('Erase ALL templates and history? This cannot be undone. Export a backup first.')) {
      localStorage.removeItem(window.Store.STORAGE_KEY);
      location.reload();
    }
  };
  wrap.appendChild(wipe);

  scr.appendChild(wrap);
}

function toggleRow(label, sublabel, key, dflt) {
  const row = el('div', 'toggle-row');
  const text = el('div');
  text.appendChild(el('div', 'toggle-label', label));
  if (sublabel) text.appendChild(el('div', 'toggle-sub', sublabel));
  row.appendChild(text);

  const btn = el('button', 'toggle');
  const paint = () => {
    const on = window.Store.getSetting(key, dflt);
    btn.classList.toggle('on', !!on);
    btn.textContent = on ? 'ON' : 'OFF';
  };
  btn.onclick = () => {
    window.Store.setSetting(key, !window.Store.getSetting(key, dflt));
    paint();
  };
  paint();
  row.appendChild(btn);
  return row;
}

function doExport() {
  const data = window.Store.exportJSON();
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `liftlog-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup exported');
}

function doImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      if (!confirm('Importing will REPLACE all current data. Continue?')) return;
      window.Store.importJSON(reader.result);
      toast('Data restored');
      render();
      window.App.renderTemplates();
      window.History.render();
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  };
  reader.readAsText(file);
}

window.Settings = { render };

})();
