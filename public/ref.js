// Shared by the reference pages (Customers, Orders, Catalog): formatting and the ERP sync toolbar.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = (n) => '€' + Number(n).toFixed(2);
const day = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const setCount = (n, noun) => { document.getElementById('cnt').innerHTML = `${n} ${noun} <span>· from your ERP, read-only</span>`; };
let failed = false; // set by a failed load or sync: the toolbar keeps saying so, and the 15s tick must not turn it back into "Synced just now"
const markFailed = () => { failed = true; document.getElementById('last').textContent = 'Sync failed · try again'; document.querySelector('.bar .dot').classList.add('off'); };
const fail = () => { document.getElementById('out').innerHTML = '<div class="dt-box"><p class="dt-empty">Could not load the data. Press Sync now to try again.</p></div>'; markFailed(); };
// load() fetches and draws; the button re-runs it and keeps the spinner up long enough to be seen.
const sync = (load) => {
  let at = Date.now();
  const last = document.getElementById('last'), dot = document.querySelector('.bar .dot');
  const tick = () => { if (failed || document.getElementById('syncBtn').disabled) return; const m = Math.floor((Date.now() - at) / 60000); last.textContent = 'Synced ' + (m < 1 ? 'just now' : m + ' min ago'); };
  setInterval(tick, 15000);
  load().catch(fail);
  document.getElementById('syncBtn').onclick = async (e) => {
    const b = e.currentTarget, t = b.querySelector('span'), had = document.activeElement === b; // a disabled button loses focus: give it back afterwards
    b.disabled = true; b.classList.add('busy'); t.textContent = 'Syncing…'; last.textContent = 'Syncing…';
    let ok = true;
    try { await Promise.all([load(), new Promise((r) => setTimeout(r, 1200))]); } catch (_) { ok = false; }
    b.disabled = false; b.classList.remove('busy'); t.textContent = 'Sync now';
    if (ok) { failed = false; at = Date.now(); tick(); dot.classList.remove('off'); } else markFailed();
    if (had) b.focus({ preventScroll: true });
  };
};
