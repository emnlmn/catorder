// the sidebar's message list and model line on every page but the inbox itself (index.html draws its own from app.js)
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PIC = {
    whatsapp: '<path d="M4 5h16v11H9l-5 4z"/>',
    voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    photo: '<path d="M4 7h4l2-3h4l2 3h4v13H4z"/><circle cx="12" cy="13" r="3.5"/>',
    email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  };
  const WORD = { whatsapp: 'WhatsApp', voice: 'Voice note', photo: 'Photo', email: 'Email' };
  const short = (iso) => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  const initials = (n) => n.split(/\s+/).filter((w) => /^[A-ZÀ-Ý]/.test(w)).slice(0, 2).map((w) => w[0]).join('') || n[0];
  const todo = (m) => !m.order || !(m.order.status === 'confirmed');
  const side = document.querySelector('.side');
  const wrap = document.createElement('div');
  wrap.className = 'inbox-wrap';
  wrap.innerHTML = '<div id="inbox" class="inbox" role="region" aria-label="Messages" hidden></div>';
  const model = document.createElement('span');
  model.id = 'model'; model.className = 'model quiet';
  model.innerHTML = '<i class="eye" aria-hidden="true"></i><span id="modelText"></span>';
  side.append(wrap, model);
  const count = document.createElement('span');
  count.className = 'count';
  side.querySelector('.navi').append(count);
  fetch('/api/messages').then((r) => r.json()).then((ms) => {
    const by = new Map();
    for (const m of ms) { if (!by.has(m.customer.id)) by.set(m.customer.id, []); by.get(m.customer.id).push(m); }
    const cs = [...by.values()];
    count.textContent = cs.filter((g) => g.some(todo)).length || '';
    wrap.firstChild.innerHTML = cs.map((g) => {
      const last = g[0], t = g.filter(todo), target = t[0] || last;
      return `<a class="irow" href="./?m=${encodeURIComponent(target.id)}"><span class="ic av" aria-hidden="true">${esc(initials(last.customer.name))}</span><span class="who">${esc(last.customer.name)}</span><span class="time">${short(last.received_at)}</span><span class="pv"><span class="pic" aria-hidden="true"><svg viewBox="0 0 24 24">${PIC[last.channel] || ''}</svg></span>${esc(last.preview || WORD[last.channel] || '')}</span>${t.length ? `<span class="badge">${t.length}</span>` : ''}</a>`;
    }).join('') || '<p class="empty">No messages.</p>';
  }).catch(() => {});
  fetch('/api/health').then((r) => r.json()).then((h) => {
    document.getElementById('modelText').textContent = h.mock ? 'Demo mode · scripted answers, no model call' : [h.model, h.hardware].filter(Boolean).join(' · ');
    model.classList.toggle('quiet', !!h.mock || !h.hardware);
  }).catch(() => {});
})();
