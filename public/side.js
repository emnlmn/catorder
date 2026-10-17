// the sidebar's open-chats count and model line on every page but the inbox itself (index.html draws its own from app.js)
(() => {
  const side = document.querySelector('.side');
  const model = document.createElement('span');
  model.id = 'model'; model.className = 'model quiet';
  model.innerHTML = '<i class="eye" aria-hidden="true"></i><span id="modelText"></span>';
  side.append(model);
  const count = document.createElement('span');
  count.className = 'count';
  side.querySelector('.navi').append(count);
  fetch('/api/messages').then((r) => r.json()).then((ms) => {
    // chats with at least one message that has no order yet
    count.textContent = new Set(ms.filter((m) => !m.order && m.customer.id !== 'unknown-sender').map((m) => m.customer.id)).size || '';
  }).catch(() => {});
  fetch('/api/health').then((r) => r.json()).then((h) => {
    document.getElementById('modelText').textContent = h.mock ? 'Demo mode · scripted answers, no model call' : [h.model, h.hardware].filter(Boolean).join(' · ');
    model.classList.toggle('quiet', !!h.mock || !h.hardware);
  }).catch(() => {});
})();
