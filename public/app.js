"use strict";
// ponytail: Twilio sandbox number, move to /api/health when there is a real WhatsApp Business number
const WHATSAPP = '+1 415 523 8886';
// ponytail: Twilio sandbox join code; public/join-qr.svg encodes the same wa.me link, regenerate it if the sandbox changes
const JOIN = 'join ordinary-concerned';
const FIX = new URLSearchParams(location.search).has('fixtures');
const $ = (id) => document.getElementById(id);
const S = {
    health: {}, messages: [], sel: null, detail: null,
    runs: {}, ack: new Set(), reading: {},
    failed: {}, busy: null, open: false,
    find: null, row: null, // the line whose catalogue search replaces the answer buttons / whose row was clicked: its quantity overrides the queue
    thread: {}, more: new Set(), trace: {},
    revealed: new Set(), queue: { order: '', n: 0 },
    cust: null, all: null, q: '', view: 'list', done: new Set(), // the customer open without messages; every ERP customer; the search box; the narrow-screen step; orders confirmed here (their ERP import stays on the right)
    drafting: null, later: new Set(), typed: {}, // the message whose reply is being written; drafts put off with Later
};
const CUST = {}; // per customer id; null = the fetch failed, no line
let writing = false;
let settled = false; // the first paint of a page opened on a message does not animate
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
/* ---------- data access ---------- */
async function api(path, opts) {
    if (FIX)
        return (await fixture(path, opts));
    const r = await fetch('/api' + path, opts && { method: opts.method, headers: { 'Content-Type': 'application/json' }, body: opts.body });
    let j = null;
    try {
        j = await r.json();
    }
    catch { /* not json */ }
    if (!r.ok)
        throw new Error(((j && j.error) || 'Request failed (' + r.status + ').') + (j && j.reasons ? ' ' + j.reasons.join(' ') : ''));
    return j;
}
const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const FX = {};
function fx(name) {
    // the media paths in the files are written for the server's /static; here they sit next to the page
    if (!FX[name])
        FX[name] = fetch('fixtures/' + name + '.json').then((r) => { if (!r.ok)
            throw new Error('No fixture ' + name); return r.text(); }).then((t) => JSON.parse(t.replaceAll('/static/fixtures/', 'fixtures/')));
    return FX[name];
}
async function fixture(path, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    let m;
    if (path === '/health')
        return fx('health');
    if (path === '/messages') {
        const ms = await fx('messages');
        for (const x of ms) {
            const d = await fx('message-' + x.id);
            x.order = d.order ? { id: d.order.id, status: d.order.status, clean: d.order.lines.every((l) => ['ok', 'removed', 'confirmed'].includes(l.state)) && !d.order.flags.some((f) => f.severity === 'high') } : null;
        }
        return ms;
    }
    if ((m = path.match(/^\/messages\/([^/]+)\/read$/))) {
        const d = await fx('message-' + m[1]);
        return { order: d.order, reading: d.order ? { kind: d.order.reading_kind, source: d.order.reading_source, text: d.order.reading } : null, runs: [{ stage: 'extract', cached: false, latency_ms: 1400, tokens_in: 2100, tokens_out: 180, cost_usd: 0.001, error: null }] };
    }
    if ((m = path.match(/^\/messages\/([^/]+)$/)))
        return fx('message-' + m[1]);
    if (path.startsWith('/catalog')) {
        const q = decodeURIComponent(path.split('q=')[1] || '').toLowerCase();
        return (await fx('catalog')).filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20);
    }
    const details = await Promise.all(['wa-001', 'wa-002', 'wa-003', 'ph-001', 'vo-001', 'wa-004'].map((id) => fx('message-' + id)));
    if ((m = path.match(/^\/lines\/([^/]+)$/))) {
        for (const d of details) {
            const l = d && d.order && d.order.lines.find((x) => x.id === m[1]);
            if (!l)
                continue;
            if (body.sku) {
                const p = (await fx('catalog')).find((x) => x.sku === body.sku) || {};
                Object.assign(l, { sku: body.sku, name: p.name || body.sku, pack_label: p.pack_label, state: 'ok', candidates: [], flags: (l.flags || []).filter((f) => f.kind !== 'ambiguous_product') });
            }
            if (body.qty !== undefined)
                l.qty = body.qty;
            if (body.removed !== undefined)
                l.state = body.removed ? 'removed' : 'ok';
            return l;
        }
    }
    if ((m = path.match(/^\/orders\/([^/]+)\/confirm$/))) {
        for (const d of details) {
            if (d && d.order && d.order.id === m[1]) {
                d.order.status = 'confirmed';
                d.order.lines.forEach((l) => { if (l.state !== 'removed')
                    l.state = 'confirmed'; });
                return d.order;
            }
        }
    }
    throw new Error('No fixture for ' + path);
}
/* ---------- helpers ---------- */
function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false)
            continue;
        if (k === 'class')
            e.className = v;
        else if (k.startsWith('on'))
            e.addEventListener(k.slice(2), v);
        else if (k in e)
            e[k] = v;
        else
            e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat(Infinity)) {
        if (k === null || k === undefined || k === false)
            continue;
        e.append(typeof k === 'object' ? k : document.createTextNode(String(k)));
    }
    return e;
}
const fmtTime = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (date) => { const d = new Date(date + 'T12:00:00'); return isNaN(+d) ? date : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };
const eur = (n) => '€' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => (n === null || n === undefined ? '' : String(Math.round(n * 100) / 100));
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 4000); }
const CHANNEL = { whatsapp: 'WhatsApp', voice: 'Voice note', photo: 'Photo of a list', email: 'Email' };
const ICONS = {
    whatsapp: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    voice: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    photo: '<svg viewBox="0 0 24 24"><path d="M4 7h4l2-3h4l2 3h4v13H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    email: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11.5 5.5 5 12l6.5 6.5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 9.5 17 19 7"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
    draft: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4.5-6.5zM11.5 13.5 20 4"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
};
const glyph = (cls, name, label) => {
    const s = h('span', { class: cls, role: label ? 'img' : null, 'aria-label': label, 'aria-hidden': label ? null : 'true' });
    s.innerHTML = ICONS[name] || '';
    return s;
};
// "Gemma on AMD …"; in mock mode nothing runs anywhere, so the parts are only listed
const MOCK = 'Demo mode · scripted answers, no model call';
const engine = (sep) => S.health.mock ? MOCK : [S.health.model, S.health.hardware].filter(Boolean).join(sep);
const lines = (o) => (o && o.lines) || [];
const flagsOf = (o) => (o && o.flags) || [];
const lineName = (l) => l.name || l.product_text;
const sev = (f) => f.severity || 'info';
const hasFlag = (l, kind) => (l.flags || []).some((f) => f.kind === kind);
// the API sends null for "no price"; fixtures omit the field
const hasPrice = (l) => l.unit_price !== undefined && l.unit_price !== null;
const lineTotal = (l) => (l.line_total !== undefined ? l.line_total : (hasPrice(l) && l.qty ? l.unit_price * l.qty : null));
function orderTotal(o) {
    const live = lines(o).filter((l) => l.state !== 'removed');
    if (o.total !== undefined && live.length)
        return o.total;
    const totals = live.map(lineTotal);
    return live.length && totals.every((x) => x !== null) ? totals.reduce((a, b) => a + b, 0) : null;
}
function orderState(o) {
    if (!o)
        return 'unread';
    if (o.status === 'confirmed')
        return 'confirmed';
    return o.clean ? 'clean' : 'check';
}
/* ---------- loading ---------- */
async function boot() {
    renderScreen();
    try {
        S.health = await api('/health');
    }
    catch (e) {
        toast(errMsg(e));
    }
    $('modelText').textContent = engine(' · ');
    $('model').classList.toggle('quiet', !!S.health.mock || !S.health.hardware); // the live dot only where something really runs
    await Promise.all([loadMessages(), loadCustomers()]);
    const qs = new URLSearchParams(location.search), want = qs.get('m'), wc = qs.get('c');
    if (want && S.messages.some((m) => m.id === want))
        await select(want);
    else if (wc && S.all && S.all.some((c) => c.id === wc))
        selectCust(wc);
    settled = true;
}
async function loadCustomers() {
    try {
        S.all = (await api('/customers')).filter((c) => c.id !== 'unknown-sender');
    }
    catch {
        S.all = null;
    } // the list then shows only the chats
    renderInbox();
}
const isLive = (id) => id.startsWith('wa-live-');
// live messages lead, as the server lists them; then newest first (instants: the stored times carry different offsets)
const newest = (a, b) => +isLive(b.id) - +isLive(a.id) || Date.parse(b.received_at) - Date.parse(a.received_at);
async function loadMessages() {
    try {
        S.messages = await api('/messages');
    }
    catch (e) {
        toast(errMsg(e));
        S.messages = [];
    }
    S.messages.sort(newest);
    renderMessages();
}
// live WhatsApp messages (webhook) are read as they arrive: no result yet and under two minutes old = "Reading…"
// a read that ended (with or without an order) is over: without this the poll reopens the trace every 2 s and the box replays forever
const readEnded = new Set();
const isReading = (id, hasOrder, at) => !FIX && isLive(id) && !hasOrder && !readEnded.has(id) && Date.now() - Date.parse(at) < 120000;
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function pollInbox() {
    if (FIX || document.visibilityState !== 'visible' || S.busy)
        return;
    try {
        const next = (await api('/messages')).sort(newest);
        const fresh = next.find((m) => isLive(m.id) && !S.messages.some((x) => x.id === m.id));
        if (sameList(next, S.messages) && !S.messages.some((m) => isReading(m.id, !!m.order, m.received_at)))
            return; // nothing new: no re-render, no flicker
        const cid = S.detail && S.detail.message.customer_id;
        const mine = (l) => JSON.stringify(l.filter((m) => m.customer.id === cid));
        const grew = !!cid && mine(next) !== mine(S.messages); // a new message, or one of them just got its order
        S.messages = next;
        renderMessages();
        if (grew && cid)
            void loadThread(cid);
        if (fresh && !S.sel)
            void select(fresh.id); // a live message lands while the waiting screen is up: show it
    }
    catch { /* the next tick tries again */ }
}
async function pollDetail() {
    const d = S.detail;
    if (document.visibilityState !== 'visible' || S.busy || !d || d.order || !isReading(d.message.id, false, d.message.received_at))
        return;
    await loadDetail();
}
setInterval(() => { void pollInbox(); }, 3000);
setInterval(() => { void pollDetail(); }, 2000);
let keepId = ''; // a bubble clicked inside the open chat: the conversation stays where it is, only the order side changes
async function select(id, keep = false) {
    document.body.classList.remove('idle');
    S.sel = id;
    S.cust = null;
    S.ack = new Set();
    S.find = S.row = null;
    setView('chat');
    remember(id);
    keepId = keep ? id : '';
    if (!keep)
        window.scrollTo(0, 0);
    renderInbox();
    await loadDetail();
}
// the open chat lives in ?m=, so a refresh reopens it
function remember(id) {
    const u = new URL(location.href);
    u.searchParams.delete('c');
    if (id)
        u.searchParams.set('m', id);
    else
        u.searchParams.delete('m');
    history.replaceState(null, '', u);
}
function goWaiting() {
    remember(null);
    document.body.classList.add('idle');
    S.sel = null;
    S.cust = null;
    S.detail = null;
    S.find = S.row = null;
    setView('list');
    renderInbox();
    renderScreen();
}
// a customer who never wrote: the chat is empty, the card is on the right; ?c= keeps it over a refresh
function selectCust(id) {
    const u = new URL(location.href);
    u.searchParams.delete('m');
    u.searchParams.set('c', id);
    history.replaceState(null, '', u);
    S.sel = null;
    S.detail = null;
    S.cust = id;
    S.find = S.row = null;
    setView('chat');
    document.body.classList.remove('idle');
    renderInbox();
    renderScreen();
}
// narrow screens show one column at a time: list, chat, detail
function setView(v) { S.view = v; document.body.dataset.v = v; }
async function loadDetail() {
    const id = S.sel;
    try {
        const d = await api('/messages/' + id);
        if (S.sel !== id)
            return;
        // the detail may carry only customer_id: take the name from the inbox row
        if (!d.message.customer)
            d.message.customer = (S.messages.find((x) => x.id === id) || {}).customer || { id: d.message.customer_id, name: d.message.customer_id };
        S.detail = d;
        if (d.message.customer_id)
            void loadThread(d.message.customer_id);
        if (id && !d.order && S.busy !== id && isReading(id, false, d.message.received_at))
            void startTrace(id);
    }
    catch (e) {
        toast(errMsg(e));
        if (!S.detail || S.detail.message.id !== id)
            S.detail = null;
    }
    renderScreen();
}
async function refresh() { await loadMessages(); await loadDetail(); }
/* ---------- sidebar and inbox ---------- */
const STATE_WORD = { unread: 'New', clean: 'Ready', check: 'Check', confirmed: 'Confirmed' };
// one row per customer, like a chat app: the conversation, its latest message and how many messages still need the operator
const readingMsg = (m) => S.busy === m.id || isReading(m.id, !!m.order, m.received_at);
const todoMsg = (m) => readingMsg(m) || orderState(m.order) === 'unread'; // unread = CatOrder has not read it yet; a read draft is no longer news
function chats() {
    const by = new Map();
    for (const m of S.messages) {
        const k = m.customer.id;
        if (!by.has(k))
            by.set(k, []);
        by.get(k).push(m);
    } // newest first within each, newest chat first
    return [...by.values()];
}
const UNKNOWN = 'unknown-sender';
const selCustomer = () => S.messages.find((m) => m.id === S.sel)?.customer.id;
function inboxRow(ms) {
    const last = ms[0], unk = last.customer.id === UNKNOWN, here = unk ? ms.some((m) => m.id === S.sel) : last.customer.id === selCustomer(), todo = ms.filter(todoMsg);
    const busy = ms.find(readingMsg), target = busy || todo[0] || last;
    const st = unk ? h('span', { class: 'st' }, 'New number') : busy ? h('span', { class: 'st' }, 'Reading', dots())
        : todo.length ? h('span', { class: 'badge', title: todo.length + (todo.length === 1 ? ' message' : ' messages') + ' to handle' }, String(todo.length))
            : h('span', { class: 'st done' }, STATE_WORD[orderState(last.order)]);
    const name = unk ? last.sender || 'New number' : last.customer.name;
    return h('button', { type: 'button', class: 'irow' + (here ? ' sel' : ''), 'data-id': unk ? last.id : last.customer.id, 'aria-current': here ? 'true' : null, onclick: () => { void select(target.id); } }, h('span', { class: 'ic av', 'aria-hidden': 'true' }, unk ? '?' : initials(name)), h('span', { class: 'who' }, name), h('span', { class: 'time' }, fmtShort(last.received_at)), h('span', { class: 'pv' }, glyph('pic', last.channel, CHANNEL[last.channel] || last.channel), last.preview || CHANNEL[last.channel] || ''), st);
}
function custRow(c) {
    const here = S.cust === c.id;
    return h('button', { type: 'button', class: 'irow quiet' + (here ? ' sel' : ''), 'data-id': c.id, 'aria-current': here ? 'true' : null, onclick: () => selectCust(c.id) }, h('span', { class: 'ic av', 'aria-hidden': 'true' }, initials(c.name)), h('span', { class: 'who' }, c.name), h('span', { class: 'pv' }, 'No messages yet'));
}
const initials = (n) => n.split(/\s+/).filter((w) => /^[A-ZÀ-Ý]/.test(w)).slice(0, 2).map((w) => w[0]).join('') || n[0];
const fmtShort = (iso) => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? fmtClock(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
// everything stays in the list: new numbers, chats to handle, the other chats (newest first), then customers who never wrote
function renderInbox() {
    const box = $('inbox'), q = S.q.trim().toLowerCase(), unk = [], todo = [], rest = [];
    const phones = new Map((S.all || []).map((c) => [c.id, c.phone || '']));
    const hit = (name, extra = '') => !q || (name + ' ' + extra).toLowerCase().includes(q);
    for (const ms of chats()) {
        if (ms[0].customer.id === UNKNOWN) {
            for (const m of ms)
                if (hit('New number', m.sender || ''))
                    unk.push([m]);
            continue;
        }
        if (hit(ms[0].customer.name, phones.get(ms[0].customer.id)))
            (ms.some(todoMsg) ? todo : rest).push(ms);
    }
    rest.sort((a, b) => Date.parse(b[0].received_at) - Date.parse(a[0].received_at));
    const wrote = new Set(S.messages.map((m) => m.customer.id));
    const quiet = (S.all || []).filter((c) => !wrote.has(c.id) && hit(c.name, c.phone || ''));
    const rows = [...unk.map(inboxRow), ...todo.map(inboxRow), ...rest.map(inboxRow), ...quiet.map(custRow)];
    $('inboxCount').textContent = String(unk.length + todo.length || '');
    const kept = box.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
    box.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, q ? 'No chat matches.' : 'No chats yet.')]));
    if (kept)
        box.querySelector('[data-id="' + kept + '"]')?.focus({ preventScroll: true }); // a poll must not drop the keyboard's place
}
function renderMessages() { document.body.classList.toggle('idle', !S.sel); renderInbox(); if (!S.sel && !S.cust)
    renderScreen(); }
/* ---------- screens ---------- */
let lastAsked = '', lastMsg = '', arrival = false;
function renderScreen() {
    const d = S.detail, b = bandOf(d), asked = b && b.line ? b.line : '';
    // a re-render of the same chat (a message lands, a thread loads) keeps the scroll: pinned to the newest message if the reader was at the bottom
    const old = document.getElementById('msgs'), same = !!d && (d.message.id === lastMsg || d.message.id === keepId), y = window.scrollY;
    const pin = same && !!old && old.scrollHeight - old.scrollTop - old.clientHeight < 48, top = old ? old.scrollTop : 0;
    lastMsg = d ? d.message.id : '';
    if (same)
        keepId = '';
    const ae = document.activeElement, typing = ae instanceof HTMLTextAreaElement && ae.closest('.out.draft') ? [ae.dataset.reply, ae.selectionStart, ae.selectionEnd] : null; // a re-render must not take the draft from under the cursor
    $('screen').replaceChildren(...(d ? [orderScreen(d, asked)] : S.cust ? [custScreen(S.cust)] : waiting()));
    paintBand(b);
    if (typing) {
        const t = draftBox(typing[0]);
        if (t) {
            t.focus({ preventScroll: true });
            t.setSelectionRange(typing[1], typing[2]);
        }
    }
    fitBand();
    const box = document.getElementById('msgs');
    if (same && box && !pin) {
        box.scrollTop = top;
        window.scrollTo(0, y);
    }
    else if (same && box) {
        box.scrollTop = box.scrollHeight;
        window.scrollTo(0, y);
    }
    else
        scrollMsgs();
    // a new question about a line that sits below the fold: bring the line up, clear of the band (not on the first paint of a page opened on a message)
    if (settled && asked && asked !== lastAsked)
        document.querySelector('.row.now')?.scrollIntoView({ block: 'nearest' });
    lastAsked = asked;
}
function waiting() {
    const wa = 'https://wa.me/14155238886?text=' + encodeURIComponent(JOIN);
    return [h('div', { class: 'scr solo' }, h('section', { class: 'conv' }, h('div', { class: 'wait' }, h('img', { class: 'hero', src: 'logo.png', alt: 'CatOrder' }), h('h1', { class: 'toon' }, 'Send an order on WhatsApp'), h('a', { class: 'join', href: wa, target: '_blank', rel: 'noopener' }, h('img', { src: 'join-qr.svg', alt: 'QR code that opens WhatsApp with “' + JOIN + '”' })), h('a', { class: 'num toon', href: wa, target: '_blank', rel: 'noopener' }, h('img', { class: 'wa', src: 'whatsapp.svg', alt: 'WhatsApp' }), WHATSAPP), h('ol', { class: 'steps' }, h('li', {}, h('span', {}, 'Scan the code or message the number')), h('li', {}, h('span', {}, 'First time? Send ', h('b', {}, JOIN))), h('li', {}, h('span', {}, 'Send an order: text, voice note or photo'))))))];
}
function highlighted(text, ls, asked, fresh) {
    // the reading with each line's quote wrapped in a span; overlapping or mismatching quotes are left plain.
    // Lines that share a quote ("il solito" for the whole usual) share its span: data-line lists their ids.
    const spans = ls.filter((l) => l.quote_end > l.quote_start && text.slice(l.quote_start, l.quote_end) === l.quote).sort((a, b) => a.quote_start - b.quote_start);
    const groups = [];
    for (const l of spans) {
        const g = groups[groups.length - 1];
        if (g && g[0].quote_start === l.quote_start && g[0].quote_end === l.quote_end)
            g.push(l);
        else
            groups.push([l]);
    }
    const out = [];
    let pos = 0;
    for (const g of groups) {
        const l = g[0], ids = g.map((x) => x.id);
        if (l.quote_start < pos)
            continue;
        if (l.quote_start > pos)
            out.push(text.slice(pos, l.quote_start));
        out.push(h('span', { class: asked && ids.includes(asked) ? 'now' + (fresh ? ' wipe' : '') : null, 'data-line': ids.join(' '), onmouseenter: () => ids.forEach((i) => link(i, true)), onmouseleave: () => ids.forEach((i) => link(i, false)),
            onclick: () => document.querySelector('.panel .row[data-line="' + ids[0] + '"]')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }, l.quote));
        pos = l.quote_end;
    }
    if (pos < text.length)
        out.push(text.slice(pos));
    return out;
}
function link(id, on) {
    document.querySelectorAll('[data-line~="' + id + '"]').forEach((e) => e.classList.toggle('hl', on));
}
function greyQuoted(nodes) {
    // email: lines starting with ">" and everything after a forwarded-message marker are the quoted part
    const out = [];
    let quoted = false;
    for (const n of nodes) {
        if (typeof n !== 'string') {
            out.push(n);
            continue;
        }
        for (const ln of n.split(/(?<=\n)/)) {
            if (/^\s*(>|-{2,}.*(inoltrat|forward)|Da:|From:)/i.test(ln))
                quoted = true;
            out.push(quoted ? h('span', { class: 'quoted' }, ln) : ln);
        }
    }
    return out;
}
function readingLabel(rd) {
    const kind = { transcript: 'Transcript', transcription: 'Transcription', original: 'Message' }[rd.kind] || 'Reading';
    if (rd.source === 'file')
        return kind + ' from file';
    if (rd.source === 'cache')
        return kind + ' · cached';
    const model = rd.kind === 'transcript' ? S.health.transcribe_model : S.health.model;
    return [kind, model && (model + (S.health.hardware ? ' on ' + S.health.hardware : ''))].filter(Boolean).join(' · ');
}
// one <audio> per message, so a re-render does not cut the voice note off
const audios = {};
// WhatsApp-style voice note: round play button, the note's own waveform (played part dark), elapsed or total time
const BARS = 40;
const peaks = {};
let playEl = null;
// a stand-in shape from the id, shown until the real waveform is decoded (or when the browser cannot decode it)
function seededPeaks(id) {
    let x = 7;
    for (const ch of id)
        x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    return Array.from({ length: BARS }, () => { x = (x * 1103515245 + 12345) >>> 0; return 0.25 + (x % 1000) / 1333; });
}
async function loadPeaks(id, url) {
    try {
        const buf = await (await fetch(url)).arrayBuffer();
        const ctx = new AudioContext();
        const data = (await ctx.decodeAudioData(buf)).getChannelData(0);
        void ctx.close();
        const step = Math.max(1, Math.floor(data.length / BARS));
        const rms = Array.from({ length: BARS }, (_, i) => {
            let s = 0;
            for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++)
                s += data[j] * data[j];
            return Math.sqrt(s / step);
        });
        const max = Math.max(...rms) || 1;
        peaks[id] = rms.map((v) => 0.12 + 0.88 * (v / max));
        if (S.sel === id)
            paintPlay(true);
    }
    catch { /* keep the stand-in shape */ }
}
function paintPlay(reshape = false) {
    const a = S.sel ? audios[S.sel] : undefined;
    if (!playEl || !a || !S.sel)
        return;
    const btn = playEl.querySelector('.vp-btn'), bars = [...playEl.querySelectorAll('.vp-wave i')];
    const t = playEl.querySelector('.vp-t');
    btn.replaceChildren(glyph(a.paused ? 'go' : '', a.paused ? 'play' : 'pause'));
    btn.setAttribute('aria-label', a.paused ? 'Play the voice note' : 'Pause');
    const p = peaks[S.sel] || seededPeaks(S.sel), dur = isFinite(a.duration) ? a.duration : 0;
    const played = dur ? a.currentTime / dur : 0;
    bars.forEach((b, i) => {
        if (reshape)
            b.style.height = Math.round(p[i] * 100) + '%';
        b.classList.toggle('on', (i + 0.5) / BARS <= played);
    });
    t.textContent = dur ? clock(a.paused && !a.currentTime ? dur : a.currentTime) : '';
}
// a transcript that lands while the operator watches ("Transcribing…" was on screen) arrives word by word, once;
// quotes and their marks stay intact. Opening an already-read voice note shows it at once.
const awaited = new Set();
function streamIn(el, on) {
    if (!on)
        return el;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [];
    while (walk.nextNode())
        nodes.push(walk.currentNode);
    const words = nodes.reduce((n, t) => n + (t.data.match(/\S+/g) || []).length, 0);
    const step = Math.min(45, 1400 / Math.max(1, words)); // long transcripts speed up: the whole thing lands within ~1.5 s
    let i = 0;
    for (const t of nodes) {
        const frag = document.createDocumentFragment();
        for (const part of t.data.split(/(\s+)/)) {
            if (!part)
                continue;
            if (/^\s+$/.test(part)) {
                frag.append(part);
                continue;
            }
            frag.append(h('span', { class: 'sw', style: 'animation-delay:' + Math.round(i++ * step) + 'ms' }, part));
        }
        t.replaceWith(frag);
    }
    return el;
}
// one shared <audio> per voice note; playing one pauses the others, and the small play marks in the thread follow it
function audioFor(id, url) {
    let a = audios[id];
    if (a)
        return a;
    a = audios[id] = h('audio', { src: url, preload: 'metadata' });
    for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'timeupdate', 'seeked'])
        a.addEventListener(ev, () => paintPlay());
    a.addEventListener('play', () => { for (const [k, o] of Object.entries(audios))
        if (k !== id)
            o.pause(); });
    for (const ev of ['play', 'pause', 'ended'])
        a.addEventListener(ev, () => {
            for (const b of document.querySelectorAll('.vm-b[data-vm="' + id + '"]'))
                b.replaceChildren(glyph('', audios[id].paused ? 'play' : 'pause'));
        });
    // the small waveform in the thread fills as the note plays, like the big one
    for (const ev of ['timeupdate', 'seeked', 'ended'])
        a.addEventListener(ev, () => {
            const o = audios[id], played = isFinite(o.duration) && o.duration ? o.currentTime / o.duration : 0;
            for (const b of document.querySelectorAll('.vm-b[data-vm="' + id + '"]'))
                [...b.parentElement.querySelectorAll('.vm-w i')].forEach((w, i, all) => w.classList.toggle('on', (i + 0.5) / all.length <= played));
        });
    a.addEventListener('ended', () => { audios[id].currentTime = 0; });
    if (url)
        void loadPeaks(id, url);
    return a;
}
function toggleAudio(a) {
    if (a.paused)
        a.play().catch(() => toast('The voice note could not be played.'));
    else
        a.pause();
}
function player(m) {
    const a = audioFor(m.id, m.media_url);
    const au = a;
    const wave = h('div', { class: 'vp-wave', 'aria-hidden': 'true', onclick: (e) => {
            if (!isFinite(au.duration))
                return;
            const r = e.currentTarget.getBoundingClientRect();
            au.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * au.duration;
        } }, Array.from({ length: BARS }, () => h('i', {})));
    playEl = h('div', { class: 'vp' }, h('button', { type: 'button', class: 'vp-btn', onclick: () => toggleAudio(au) }), wave, h('span', { class: 'vp-t' }));
    paintPlay(true);
    return [playEl, au];
}
function custLine(id) {
    const c = CUST[id];
    if (c === undefined) {
        CUST[id] = null;
        api('/customers/' + id).then((x) => { CUST[id] = x; if (S.detail && S.detail.message.customer_id === id)
            renderScreen(); }, () => { });
        return '';
    }
    if (!c)
        return '';
    const t = c.terms || {}, last = (c.recent_orders || [])[0];
    return [t.discount_pct ? t.discount_pct + '% discount' : '', t.payment_days ? t.payment_days + ' days' : '', last && 'last order ' + fmtDay(last.date)].filter(Boolean).join(' · ');
}
function erp(o, name) {
    let n = 0;
    for (const ch of o.id)
        n = (n * 31 + ch.charCodeAt(0)) % 9000;
    const ls = lines(o).filter((l) => l.state !== 'removed'), total = orderTotal(o), price = (x) => (x === null || x === undefined ? '–' : eur(x));
    return h('div', { class: 'erp' }, h('div', { class: 'erp-h' }, 'ERP · Order no. ' + (1000 + n) + ' created'), h('div', { class: 'erp-c' }, name), h('table', {}, h('tr', {}, ['SKU', 'Product', 'Qty', 'Price', 'Total'].map((x) => h('th', {}, x))), ls.map((l) => h('tr', {}, h('td', {}, l.sku || ''), h('td', {}, lineName(l)), h('td', {}, l.qty === null ? '?' : num(l.qty)), h('td', {}, price(l.unit_price)), h('td', {}, price(lineTotal(l))))), h('tr', { class: 'erp-t' }, h('td', { colspan: 4 }, 'Total'), h('td', {}, price(total)))), h('div', { class: 'erp-n' }, 'Demo: simulated ERP import'));
}
/* ---------- conversation and live trace ---------- */
async function loadThread(cid) {
    try {
        const t = await api('/customers/' + cid + '/messages');
        if (!Array.isArray(t) || JSON.stringify(t) === JSON.stringify(S.thread[cid]))
            return;
        S.thread[cid] = t;
        for (const p of t)
            if (p.trace && p.trace.length && !S.trace[p.id])
                S.trace[p.id] = { steps: p.trace, done: true, open: false, es: null };
        if (S.detail && S.detail.message.customer_id === cid)
            renderScreen();
    }
    catch { /* no thread: the message screen stays as it was */ }
}
// the order a message turned into, docked under it as a ticket stub hooked to its words; a message with no order gets a quiet note
function chip(o, n = 1, id = '') {
    if (!o)
        return false;
    const st = o.status === 'confirmed' ? 'Confirmed' : o.clean ? 'Draft' : 'Check';
    if (!o.lines && o.status !== 'confirmed')
        return h('p', { class: 'noorder' }, 'No order in this message');
    return h('button', { type: 'button', class: 'ticket ' + st.toLowerCase(), title: 'Open this order', onclick: id ? () => { void select(id, true); } : null }, glyph('tk-ic', st === 'Confirmed' ? 'check' : st === 'Check' ? 'alert' : 'draft'), h('span', { class: 'tk-t' }, h('b', null, 'Order'), h('span', null, o.lines + (o.lines === 1 ? ' line' : ' lines') + (n > 1 ? ' · from ' + n + ' messages' : ''))), h('span', { class: 'tk-st' }, st === 'Check' ? 'To check' : st));
}
const pastOf = (m, o) => ({ id: m.id, channel: m.channel, received_at: m.received_at, text: m.text, media_url: m.media_url || null, order: o ? { id: o.id, status: o.status, lines: lines(o).filter((l) => l.state !== 'removed').length, clean: !!o.clean, message_ids: o.message_ids } : null });
// WhatsApp-style: the time sits in the bubble, the day once above the messages of that day
const stamp = (_channel, at) => h('span', { class: 'bm' }, fmtClock(at));
function dayLabel(iso) {
    const d = new Date(iso), mid = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((mid(new Date()) - mid(d)) / 86_400_000);
    if (ago === 0)
        return 'Today';
    if (ago === 1)
        return 'Yesterday';
    if (ago > 1 && ago < 7)
        return d.toLocaleDateString('en-GB', { weekday: 'long' });
    return d.toLocaleDateString('en-GB', d.getFullYear() === new Date().getFullYear()
        ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
// the words of a bubble that belongs to the selected order: its slice of the combined reading, with the quotes that fall in it lit
let curAsked = '';
const unfolded = new Set(); // orders whose long thread the operator opened
function segWords(p, o) {
    const sg = o && p.order && p.order.id === o.id && (o.segments || []).find((x) => x.message_id === p.id);
    if (!o || !sg)
        return p.words ? highlighted(p.words.text, p.words.quotes, undefined, false) : null;
    const ls = lines(o).filter((l) => l.quote_start >= sg.start && l.quote_end <= sg.end).map((l) => ({ ...l, quote_start: l.quote_start - sg.start, quote_end: l.quote_end - sg.start }));
    return highlighted(o.reading.slice(sg.start, sg.end), ls, curAsked, false);
}
// a voice note that is not open still shows what it is: a small play mark and its own shape, so nobody has to click to find out
function miniVoice(p) {
    const pk = peaks[p.id] || seededPeaks(p.id);
    const a = audioFor(p.id, p.media_url);
    const b = h('button', { type: 'button', class: 'vm-b', 'data-vm': p.id, 'aria-label': 'Play the voice note', onclick: () => toggleAudio(a) });
    b.append(glyph('', a.paused ? 'play' : 'pause'));
    return h('span', { class: 'vm' }, b, h('span', { class: 'vm-w' }, Array.from({ length: 24 }, (_, i) => h('i', { style: 'height:' + Math.round(pk[Math.floor(i * BARS / 24)] * 100) + '%' }))));
}
function bubble(p, o = null, solo = true) {
    const media = p.channel === 'whatsapp' ? '' : CHANNEL[p.channel] || '';
    return h('div', { class: 'msg', 'data-msg': p.id }, h('div', { class: 'bub' }, p.channel === 'voice' && p.media_url ? miniVoice(p) : p.channel === 'photo' && !p.text && isReading(p.id, !!p.order, p.received_at) ? h('b', { class: 'bl' }, cat(true), 'Reading the photo') : media && h('b', { class: 'bl' }, media), p.channel === 'photo' && p.media_url && h('a', { class: 'photo', href: p.media_url, target: '_blank', rel: 'noopener', title: 'Open the photo' }, h('img', { src: p.media_url, alt: 'Photo of a list' })), p.text && h('span', { class: 'bt' }, segWords(p, o) || p.text), stamp(p.channel, p.received_at)), solo && chip(p.order, 1, p.id), !p.order && isReading(p.id, false, p.received_at) && thinking('')); // a live message landing under another open order: show it is being read
}
// the whole conversation, oldest first; the open message is its full self (quotes lit, player, photo), the rest are one click away
function threadEl(m, o, open) {
    const t = m.customer_id ? S.thread[m.customer_id] : undefined;
    const all = t && t.some((x) => x.id === m.id) ? t : [...(t || []), pastOf(m, o)];
    const sorted = [...all].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at)).map((p) => (p.id === m.id ? { ...p, order: pastOf(m, o).order } : p));
    // consecutive bubbles of one order share a rail and one chip at the end
    const groups = [];
    for (const p of sorted) {
        const g = groups[groups.length - 1];
        if (g && p.order && g[0].order && g[0].order.id === p.order.id)
            g.push(p);
        else
            groups.push([p]);
    }
    let lastDay = '';
    const day = (p) => {
        const k = new Date(p.received_at).toDateString();
        if (k === lastDay)
            return false;
        lastDay = k;
        return h('p', { class: 'day' }, dayLabel(p.received_at));
    };
    return h('div', { id: 'msgs', class: 'msgs', role: 'log', 'aria-label': 'Conversation' }, groups.map((g) => {
        const solo = g.length === 1, ord = g[g.length - 1].order;
        const item = (p) => [day(p), ...(p.id === m.id ? open(solo) : [bubble(p, o, solo), traceEl(p.id), replyEl(p.reply, p.id)])];
        if (solo)
            return g.map(item);
        // a long order folds to its first and last two messages (and the open one); the fold says how many it holds
        const oid = ord ? ord.id : '', keep = (i) => g.length <= 5 || unfolded.has(oid) || i < 2 || i >= g.length - 2 || g[i].id === m.id;
        const items = [];
        for (let i = 0; i < g.length; i++) {
            if (keep(i)) {
                items.push(item(g[i]));
                continue;
            }
            let j = i;
            while (j < g.length && !keep(j))
                j++;
            const n = j - i;
            g.slice(i, j).forEach(day); // the days inside the fold are passed, not shown
            items.push(h('button', { type: 'button', class: 'fold', onclick: () => { unfolded.add(oid); renderScreen(); } }, h('span', { class: 'fold-n' }, '+' + n), n === 1 ? '1 more message in this order' : n + ' more messages in this order'));
            i = j - 1;
        }
        return h('div', { class: 'og ' + (!ord ? '' : ord.status === 'confirmed' ? 'confirmed' : ord.clean ? 'draft' : 'check') }, items, chip(ord, Math.max(g.length, (ord && ord.message_ids || []).length), g[g.length - 1].id));
    }));
}
// our side of the chat, on the right: the reply being written, the draft to edit, or what was sent
function replyEl(r, msgId) {
    if (S.drafting === msgId)
        return h('div', { class: 'msg out rise', role: 'status' }, h('span', { class: 'think-b' }, cat(true), 'Writing the reply'));
    if (!r)
        return false;
    if (r.status === 'draft') {
        const ta = h('textarea', { class: 'said', rows: 2, 'data-reply': r.id, 'aria-label': 'Reply to the customer, not sent yet',
            oninput: () => { S.typed[r.id] = ta.value; },
            onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void doSend(r);
            } } });
        ta.value = S.typed[r.id] ?? r.text;
        return h('div', { class: 'msg out draft' + (S.later.has(r.id) ? ' later' : '') }, h('label', { class: 'bub' }, h('span', { class: 'bl' }, 'Draft reply · not sent'), ta), h('p', { class: 'hint' }, '⌘ Enter sends it'));
    }
    return h('div', { class: 'msg out' }, h('div', { class: 'bub' }, h('span', { class: 'bt' }, r.text), h('span', { class: 'bm' }, r.via === 'whatsapp' ? 'Sent ' + fmtClock(r.sent_at || r.created_at) : 'Demo · not delivered', glyph('ic', 'check'))));
}
function scrollMsgs(smooth = false) {
    const box = document.getElementById('msgs'), sel = box && box.querySelector('.msg.sel');
    if (!box || !sel)
        return;
    const tr = document.getElementById('trace'), rp = box.querySelector('.msg.sel ~ .msg.out');
    const end = Math.max(sel.offsetTop + sel.offsetHeight, tr && !tr.hidden ? tr.offsetTop + tr.offsetHeight : 0, rp ? rp.offsetTop + rp.offsetHeight : 0);
    box.scrollTo({ top: Math.max(0, end - box.clientHeight + 24), behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
}
const quoted = (s) => s.split(/(«[^»]*»)/).map((x) => (x.startsWith('«') ? h('b', {}, x) : x));
const secs = (ms) => (ms / 1000).toFixed(1) + ' s';
function paintTrace(id, scroll = true) {
    const o = S.sel === id ? document.getElementById('trace') : document.querySelector('[data-trace="' + id + '"]');
    if (!o)
        return;
    const box = document.getElementById('msgs'), atEnd = !!box && box.scrollHeight - box.scrollTop - box.clientHeight < 48; // someone reading further up is left there
    const n = traceEl(id) || h('div', { id: S.sel === id ? 'trace' : null, 'data-trace': id, hidden: true });
    o.replaceWith(n);
    if (scroll && atEnd && S.sel === id)
        reveal(n);
}
// something just grew in the chat (steps opened, a draft written): it moves down only as far as needed to show it,
// never so far that its top leaves the view, and never up
function reveal(el) {
    const box = document.getElementById('msgs');
    if (!el || !box)
        return;
    const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    const down = Math.min(r.bottom + 16 - b.bottom, r.top - 12 - b.top);
    if (down > 0)
        box.scrollBy({ top: down, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function showTrace(id) {
    const tr = document.querySelector('[data-trace="' + id + '"]');
    tr?.querySelector('.tsum')?.focus({ preventScroll: true });
    reveal(tr);
}
// CatOrder's own pills carry the cat; at work, the sparks of the logo flicker by its ear
const cat = (on) => h('span', { class: 'cat' + (on ? ' on' : ''), 'aria-hidden': 'true' }, h('img', { src: 'logo.png', alt: '' }), h('i'), h('i'), h('i'));
// three little lines of text: reading, the green highlighter runs over them as it does over the customer's words; writing, they fill in
const dots = () => h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
// before the first step arrives (or with no trace at all) CatOrder still answers in the chat: a bubble that it is reading
function thinking(id = 'trace') {
    return h('section', { id: id || null, class: 'think rise', role: 'status', 'aria-label': 'CatOrder is reading the message' }, h('span', { class: 'think-b' }, cat(true), 'Reading the message'));
}
function traceEl(id) {
    const t = S.trace[id], d = S.detail;
    const reading = S.busy === id || (!!d && d.message.id === id && !d.order && isReading(id, false, d.message.received_at));
    if (!t || !t.steps.length)
        return reading ? thinking(S.sel === id ? 'trace' : '') : false;
    const last = t.steps[t.steps.length - 1], ms = last ? last.at : 0, open = !t.done || t.open;
    const rows = t.steps.map((s) => {
        const fresh = s.fresh;
        s.fresh = false;
        return h('li', { class: 'ts ' + s.status + (fresh ? ' rise' : '') }, h('span', { class: 'ti' }, s.status === 'run' ? h('span', { class: 'spin' }) : s.status === 'ok' ? '✓' : '!'), h('span', { class: 'tw' }, h('span', { class: 'tt' }, quoted(s.title)), s.detail && h('span', { class: 'td' }, s.detail)), s.at >= 100 && h('span', { class: 'tm' }, secs(s.at)));
    });
    return h('section', { id: S.sel === id ? 'trace' : null, 'data-trace': id, class: 'trace', 'aria-label': 'What CatOrder did' }, !t.done && h('p', { class: 'th toon' }, cat(true), 'CatOrder is reading'), t.done && h('button', { type: 'button', class: 'tsum', 'aria-expanded': String(open), onclick: () => { t.open = !t.open; paintTrace(id, false); showTrace(id); } }, cat(false), (ms >= 100 ? 'Read in ' + secs(ms) + ' · ' : '') + t.steps.length + ' steps · ', h('u', {}, open ? 'Hide steps' : 'Show steps')), open && h('ol', { class: 'tl' }, rows), t.done && last.kind === 'error' && S.sel === id && !S.busy && h('button', { type: 'button', class: 'pick', style: 'margin-top:10px', onclick: doRead }, 'Retry'));
}
// opened BEFORE the read is posted; resolves when the server says done/idle or the stream fails
// fresh: skip a finished read and wait for the next one; onOpen fires once the stream is listening (or after 1.5 s)
function startTrace(id, fresh = false, onOpen) {
    if (FIX || typeof EventSource === 'undefined' || (S.trace[id] && S.trace[id].es)) {
        onOpen?.();
        return Promise.resolve();
    }
    return new Promise((res) => {
        const t = S.trace[id] = { steps: [], done: false, open: false, es: null };
        const es = t.es = new EventSource('/api/messages/' + id + '/trace' + (fresh ? '?fresh=1' : ''));
        let opened = false;
        const open = () => { if (!opened) {
            opened = true;
            onOpen?.();
        } };
        es.onopen = open;
        setTimeout(open, 1500);
        const end = () => {
            es.close();
            t.es = null;
            t.done = true;
            t.steps = t.steps.filter((x) => x.status !== 'run'); // a finished read has no spinner left (a replayed 'run' frame can land after its 'ok')
            if (!t.steps.length)
                delete S.trace[id];
            paintTrace(id);
            res();
        };
        es.addEventListener('step', (e) => {
            try {
                const s = JSON.parse(e.data);
                if (s.status === 'run' && t.steps.some((x) => x.kind === s.kind && x.status !== 'run'))
                    return; // late 'run' frame of a step already finished
                const i = t.steps.map((x) => x.kind + x.status).lastIndexOf(s.kind + 'run');
                if (i >= 0 && s.status !== 'run')
                    t.steps[i] = s;
                else
                    t.steps.push(s);
                s.fresh = i < 0 || s.status === 'run';
                if (t.steps.length === 1)
                    renderScreen();
                else
                    paintTrace(id);
            }
            catch { /* a bad frame is skipped */ }
        });
        es.addEventListener('done', (e) => {
            try {
                const d = JSON.parse(e.data);
                readEnded.add(id);
                if (!d.order_id && d.error)
                    S.failed[id] = d.error;
            }
            catch { /* no payload: treat as a normal end */ }
            end();
            if (S.sel === id && !S.busy)
                void loadMessages().then(loadDetail);
        });
        es.addEventListener('idle', end);
        es.onerror = () => { open(); end(); };
    });
}
const PILL = { unread: 'New', clean: 'Ready', check: 'Check', confirmed: 'Confirmed' };
// start the demo over with this customer: two clicks, the second one deletes every message, order and reply of the chat
function clearBtn(cid) {
    const b = h('button', { type: 'button', class: 'clr' }, 'Clear chat');
    let t;
    b.onclick = async () => {
        if (!b.classList.toggle('sure')) {
            clearTimeout(t);
            await send('DELETE', '/customers/' + cid + '/messages').catch((e) => toast(errMsg(e)));
            goWaiting();
            await loadMessages();
            return;
        }
        b.textContent = 'Delete all messages?';
        t = setTimeout(() => { b.classList.remove('sure'); b.textContent = 'Clear chat'; }, 4000);
    };
    return b;
}
// a number we do not know: pick the customer once, every message from it (now and later) follows
function whoPanel(m) {
    const pick = async (c) => {
        if (S.busy)
            return;
        try {
            await send('POST', '/messages/' + m.id + '/assign', { customer_id: c.id });
        }
        catch (e) {
            toast(errMsg(e));
            return;
        }
        toast('This number is now ' + c.name + '.');
        await loadMessages();
        await loadDetail();
        void loadCustomers();
        if (S.detail && S.detail.order)
            void doRead(); // read again as that customer: "the usual" now has a history
    };
    return h('aside', { class: 'panel who-p', 'aria-label': 'Who is this?' }, backBtn('chat'), h('header', { class: 'panel-h' }, h('h2', { class: 'toon' }, 'Who is this?')), h('p', { class: 'none' }, 'Link ' + (senderOf(m) || 'this number') + ' to a customer. CatOrder reads the order once it is linked.'), h('div', { class: 'who-l' }, (S.all || []).map((c) => h('button', { type: 'button', class: 'who-b', onclick: () => { void pick(c); } }, c.name))));
}
const senderOf = (m) => m.sender || S.messages.find((x) => x.id === m.id)?.sender;
const backBtn = (to) => h('button', { type: 'button', class: 'bk', onclick: () => { if (to === 'list')
        goWaiting();
    else
        setView('chat'); } }, '‹ ' + (to === 'list' ? 'Chats' : 'Chat'));
// the customer card: terms, when they are due, their last orders; it is the right column whenever there is no order to handle
const PRED = {}; // undefined = not asked, null = no answer (no history, model away): the line is left out
function custCard(id, name) {
    const c = (S.all || []).find((x) => x.id === id), t = (c && c.terms) || {}, last = c ? c.recent_orders.slice(0, 5) : [];
    if (PRED[id] === undefined && c && c.order_count >= 2 && !FIX) {
        PRED[id] = null;
        api('/customers/' + id + '/prediction').then((p) => { PRED[id] = p; if (S.cust === id || (S.detail && S.detail.message.customer_id === id))
            renderScreen(); }, () => { });
    }
    const p = PRED[id], due = p && (p.days_overdue > 0 ? p.days_overdue + (p.days_overdue === 1 ? ' day' : ' days') + ' late' : fmtDay(p.next_order_date));
    const kv = (k, v) => !!v && h('div', { class: 'kv' }, h('dt', {}, k), h('dd', {}, v));
    return h('aside', { class: 'panel card', 'aria-label': 'Customer' }, backBtn('chat'), h('header', { class: 'panel-h' }, h('h2', { class: 'toon' }, name)), h('dl', {}, kv('WhatsApp', c && c.phone), kv('Discount', t.discount_pct ? t.discount_pct + '%' : ''), kv('Payment', t.payment_days ? t.payment_days + ' days' : ''), kv('Free delivery from', t.free_delivery_min ? eur(t.free_delivery_min) : ''), kv(p && p.days_overdue > 0 ? 'Next order' : 'Next order expected', due)), h('h3', { class: 'sub' }, 'Last orders'), last.length ? h('ul', { class: 'lo' }, last.map((o) => h('li', {}, h('span', {}, fmtDay(o.date)), h('span', {}, (o.lines || []).length + ((o.lines || []).length === 1 ? ' line' : ' lines'))))) : h('p', { class: 'none' }, c ? 'No orders yet.' : 'Loading…'), c && h('a', { class: 'more', href: 'orders.html?c=' + encodeURIComponent(id) }, 'All orders'));
}
// a customer with no messages yet
function custScreen(id) {
    const c = (S.all || []).find((x) => x.id === id), name = c ? c.name : id;
    return h('div', { class: 'scr' }, h('section', { class: 'conv' }, h('header', { class: 'conv-h' }, backBtn('list'), h('h1', { class: 'toon' }, name), c && c.phone && h('div', { class: 'meta cust' }, c.phone), h('button', { type: 'button', class: 'dtl', onclick: () => setView('detail') }, 'Details')), h('div', { class: 'blank' }, h('span', { class: 'ic av', 'aria-hidden': 'true' }, initials(name)), h('h2', { class: 'toon' }, 'No messages yet'), c && c.phone && h('p', { class: 'num2' }, c.phone), h('p', {}, 'When they write, CatOrder reads the order here.'))), custCard(id, name));
}
function orderScreen(d, asked) {
    const m = d.message, o = d.order, who = m.customer;
    const rd = o ? { kind: o.reading_kind, source: o.reading_source, text: o.reading } : S.reading[m.id];
    const sg0 = o && (o.segments || []).find((x) => x.message_id === m.id);
    const text = sg0 && rd ? rd.text.slice(sg0.start, sg0.end) : rd ? rd.text : m.text || '';
    const fresh = settled && !!o && !S.revealed.has(o.id); // first time this order shows: its asked words wipe in, its rows rise
    arrival = fresh;
    curAsked = asked || '';
    const words = o ? highlighted(text, sg0 ? lines(o).filter((l) => l.quote_start >= sg0.start && l.quote_end <= sg0.end).map((l) => ({ ...l, quote_start: l.quote_start - sg0.start, quote_end: l.quote_end - sg0.start })) : lines(o), asked, fresh) : [text];
    const infos = flagsOf(o).filter((f) => sev(f) === 'info');
    const reading = S.busy === m.id || (!o && isReading(m.id, false, m.received_at));
    const mine = pastOf(m, o);
    const pill = reading ? 'Reading' : PILL[orderState(o && { id: o.id, status: o.status, clean: !!o.clean })];
    const open = (solo) => [
        h('div', { class: 'msg sel', 'data-msg': m.id }, h('div', { class: 'bub' }, m.channel === 'voice' && m.media_url && h('div', { class: 'bl' }, player(m)), m.channel === 'photo' && m.media_url && h('a', { class: 'photo', href: m.media_url, target: '_blank', rel: 'noopener', title: 'Open the photo' }, h('img', { src: m.media_url, alt: 'Photo of a list sent by ' + who.name })), text ? streamIn(h('p', { class: 'said' + (m.channel === 'voice' ? ' tx' : '') }, m.channel === 'email' ? greyQuoted(words) : words), awaited.delete(m.id))
            : m.channel === 'voice' && reading && (awaited.add(m.id), h('p', { class: 'said tx wait' }, 'Transcribing', dots())), !text && m.channel === 'photo' && reading && h('p', { class: 'said tx wait' }, cat(true), 'Reading the photo'), stamp(m.channel, m.received_at)), solo && chip(mine.order)),
        traceEl(m.id) || h('div', { id: 'trace', 'data-trace': m.id, hidden: true }),
        replyEl(d.reply, m.id),
    ];
    const nMsgs = o && o.message_ids ? o.message_ids.length : 1;
    const prior = m.customer_id && (S.thread[m.customer_id] || []).some((p) => p.order && p.order.status === 'draft' && o && p.order.id !== o.id && Date.parse(p.received_at) < Date.parse(m.received_at));
    const routeBtn = !o || o.status !== 'draft' ? null
        : nMsgs > 1 ? { to: 'new', label: 'Start a new order with this message' }
            : prior && o.message_ids ? { to: 'attach', label: 'Add to the previous order' } : null;
    const unk = m.customer_id === UNKNOWN, showOrder = !o || o.status !== 'confirmed' || S.done.has(o.id); // nothing left to do on a confirmed order: the customer card takes the column
    const delivery = o && o.delivery_date && 'Deliver ' + fmtDay(o.delivery_date);
    const total = o && orderTotal(o);
    return h('div', { class: 'scr' }, h('section', { class: 'conv' }, h('header', { class: 'conv-h' }, backBtn('list'), h('h1', { class: 'toon' }, unk ? senderOf(m) || 'New number' : who.name), m.customer_id && h('div', { class: 'meta cust' }, unk ? 'New number' : custLine(m.customer_id)), h('button', { type: 'button', class: 'dtl', onclick: () => setView('detail') }, 'Details'), m.customer_id && clearBtn(m.customer_id)), threadEl(m, o, open)), unk ? whoPanel(m) : !showOrder ? custCard(m.customer_id, who.name) : h('aside', { class: 'panel', 'aria-label': 'Order' }, backBtn('chat'), h('header', { class: 'panel-h' }, h('h2', { class: 'toon' }, 'Order', nMsgs > 1 && h('span', { class: 'nmsg' }, ' · ' + nMsgs + ' messages')), h('span', { class: 'pill ' + pill.toLowerCase() }, pill)), routeBtn && h('button', { type: 'button', class: 'route', onclick: () => { void doRead(routeBtn.to); } }, routeBtn.label), o ? [
        delivery && h('p', { class: 'deliver' }, delivery),
        list(o, asked, fresh),
        o.status === 'draft' && m.customer_id && suggestions(o, m.customer_id),
        !!total && h('p', { class: 'total' }, h('span', {}, 'Total'), h('b', { class: 'toon' }, eur(total))),
        h('div', { class: 'foot' }, infos.map((f) => h('p', {}, f.message))),
        o.status === 'confirmed' && erp(o, who.name),
    ] : h('p', { class: 'none' }, reading ? 'Reading the message…' : 'Not read yet.')));
}
const SUG = {}; // per customer id; null = fetching or failed, nothing shown
const SUGGONE = new Set(); // order id + sku, answered
function suggestions(o, cid) {
    if (!(cid in SUG)) {
        SUG[cid] = null;
        api('/customers/' + cid + '/prediction').then((x) => { SUG[cid] = x.basket.filter((b) => b.p >= 0.5); if (S.detail && S.detail.message.customer_id === cid)
            renderScreen(); }, () => { });
    }
    const have = new Set(lines(o).filter((l) => l.state !== 'removed').map((l) => l.sku));
    const left = (SUG[cid] || []).filter((b) => !have.has(b.sku) && !SUGGONE.has(o.id + b.sku)).slice(0, 3);
    if (!left.length)
        return false;
    const answer = (b, action) => {
        SUGGONE.add(o.id + b.sku);
        void send('POST', '/suggestions/feedback', { customer_id: cid, order_id: o.id, sku: b.sku, qty: b.qty, p: b.p, action }).catch(() => { });
        if (action === 'dismissed')
            return renderScreen();
        send('POST', '/orders/' + o.id + '/lines', { sku: b.sku, qty: b.qty }).then(() => loadDetail(), (e) => { SUGGONE.delete(o.id + b.sku); toast(errMsg(e)); });
    };
    return h('section', { class: 'sugs', 'aria-label': 'Suggested by the forecast model' }, h('p', { class: 'sugs-h' }, 'Usually also takes · forecast model'), left.map((b) => h('div', { class: 'sugrow' }, h('span', { class: 'what' }, h('i', { class: 'eye' }), b.qty + ' × ' + b.name), h('button', { type: 'button', class: 'sug-add', onclick: () => answer(b, 'added') }, 'Add'), h('button', { type: 'button', class: 'sug-x', 'aria-label': 'Dismiss ' + b.name, onclick: () => answer(b, 'dismissed') }, '×'))));
}
function list(o, asked, fresh) {
    const ls = lines(o);
    if (!ls.length)
        return false;
    S.revealed.add(o.id);
    let i = 0;
    const draft = o.status === 'draft'; // a confirmed order is read-only; in a draft every row is a button that opens its quantity in the band
    const row = (l, gap) => {
        const out = l.state === 'removed';
        const notes = out ? [] : [l.note, ...(l.flags || []).filter((f) => sev(f) === 'info').map((f) => f.message)].filter(Boolean);
        const doubt = !out && l.state === 'flag' ? (l.flags || []).find((f) => sev(f) !== 'info') : undefined; // a line the operator must settle
        const attrs = { class: 'row' + (out ? ' out' : '') + (doubt ? ' doubt' : '') + (gap ? ' first' : '') + (fresh ? ' rise' : '') + (l.id === asked ? ' now' + (fresh ? ' wipe' : '') : ''), 'data-line': l.id, style: fresh ? 'animation-delay:' + i++ * 40 + 'ms' : null, onmouseenter: () => link(l.id, true), onmouseleave: () => link(l.id, false) };
        const cells = [
            h('span', { class: 'n toon' }, l.qty === null ? '?' : num(l.qty), l.sell_unit === 'kg' && h('small', {}, ' kg')),
            h('span', { class: 'what' }, lineName(l), doubt && h('span', { class: 'chk' }, h('b', {}, '!'), DOUBT[doubt.kind] || 'Check this line'), notes.length > 0 && h('span', { class: 'note' }, notes.join(' · '))),
            h('span', { class: 'pr' }, !out && lineTotal(l) !== null ? eur(lineTotal(l)) : ''),
        ];
        // a doubtful line is settled in the band, which already asks about it; the row only points there
        return draft ? h('button', { ...attrs, type: 'button', title: doubt ? 'Settle this line below' : out ? 'Restore or change this line' : 'Change the quantity or remove this line', onclick: () => doubt ? $('band').focus() : editRow(l) }, cells) : h('div', attrs, cells);
    };
    const live = ls.filter((l) => l.state !== 'removed'), need = live.filter((l) => l.state === 'flag').length;
    return h('section', { class: 'list', 'aria-label': 'Draft order' }, draft && live.length > 0 && h('p', { class: 'trust' + (need ? ' need' : '') }, need
        ? need + (need === 1 ? ' line' : ' lines') + ' to check before you can confirm'
        : live.length === 1 ? '1 line matched to the catalogue · it cites the message' : 'All ' + live.length + ' lines matched to the catalogue · each one cites the message'), ls.map((l) => row(l, false))); // one list: the order this message asks for, the usual is only where it started
}
/* ---------- the band: a queue of decisions, one at a time ---------- */
const CHECK_KINDS = ['ambiguous_product', 'illegible', 'quantity_missing'];
const pick = (label, on, extra = {}) => h('button', { type: 'button', class: 'pick', onclick: on, ...extra }, label);
// a suggestion: the product to pick, and under it why CatOrder offers it; the eye marks one this customer already orders
const sug = (name, why, on, theirs = false, extra = {}) => h('button', { type: 'button', class: 'pick sug', onclick: on, ...extra }, h('span', { class: 'sn' }, name), why && h('span', { class: 'why' }, theirs && h('i', { class: 'eye' }), why));
// a side road out of the question (search, ask, back): a quiet button beside it, never one of the answers
const alt = (label, on, icon) => h('button', { type: 'button', class: 'alt', onclick: on }, icon && glyph('ai', icon), label);
const exportLink = (o, fmt) => h('a', { class: 'pick', href: '/api/orders/' + o.id + '/export?format=' + fmt, download: '', onclick: (e) => e.target.closest('dialog')?.close() }, fmt === 'csv' ? 'CSV · spreadsheet' : 'JSON · for the ERP');
// one Export button; the format is chosen in a native modal dialog
const exportMenu = (o) => {
    const dlg = h('dialog', { class: 'xmenu' }, h('p', null, 'Export as'), exportLink(o, 'csv'), exportLink(o, 'json'), pick('Cancel', () => dlg.close(), { class: 'pick quiet' }));
    dlg.addEventListener('click', (e) => { if (e.target === dlg)
        dlg.close(); });
    return h('span', { style: 'display:contents' }, pick('Export', () => dlg.showModal(), { class: 'pick quiet' }), dlg);
};
function back() { S.find = S.row = null; renderScreen(); }
function bandOf(d) {
    if (!d)
        return null;
    const m = d.message, o = d.order;
    if (m.customer_id === UNKNOWN)
        return { key: 'link', q: 'Who is this?', sub: 'Reading starts once the number is linked to a customer.', ctl: () => pick('Choose customer', () => setView('detail')) };
    if (S.busy === m.id || (!o && isReading(m.id, false, m.received_at)))
        return { key: 'reading', q: 'Reading…', sub: engine(' on ') };
    if (!o) {
        const err = S.failed[m.id];
        return err ? { key: 'failed', q: 'Could not read it.', sub: err, ctl: () => pick('Try again', doRead) } : { key: 'unread', q: 'Read this message?', ctl: () => pick('Read', doRead) };
    }
    const r = d.reply;
    if (S.drafting === m.id)
        return { key: 'drafting', icon: 'send', q: 'Writing the reply…', sub: engine(' on ') };
    if (r && r.status === 'draft' && !S.later.has(r.id))
        return replyStep(r);
    if (o.status === 'confirmed') {
        const sent = r && r.status === 'sent', first = m.customer.name;
        return { key: 'confirmed' + (sent ? ':sent' : ''), icon: 'check', q: sent ? 'Confirmed and answered.' : 'Confirmed.',
            // the main action ends the row: the reply while there is none sent, then Done
            ctl: () => [exportMenu(o), pick('Done', goWaiting, sent ? {} : { class: 'pick quiet' }), !sent && pick(r ? 'Back to the reply' : 'Reply to ' + first, () => (r ? (S.later.delete(r.id), renderScreen()) : doDraft()))] };
    }
    const editing = lines(o).find((l) => l.id === S.row);
    if (editing)
        return rowStep(editing); // not part of the queue: no counter
    const steps = pending(o), total = orderTotal(o);
    // the queue ends in Ready, or in "Nothing to order" once no line is left (it is also the only step of an order with no lines and no flags)
    steps.push(lines(o).some((l) => l.state !== 'removed')
        ? { key: 'ready', q: 'Ready.', ctl: () => pick('Confirm order' + (total === null ? '' : ' · ' + eur(total)), doConfirm, { 'data-main': true }) }
        : { key: 'empty', q: 'Nothing to order in this message.', ctl: () => pick('Done', goWaiting) });
    if (S.queue.order !== o.id)
        S.queue = { order: o.id, n: 0 };
    S.queue.n = Math.max(S.queue.n, steps.length); // "n of m": m is what the order asked when it loaded, it does not shrink while answering
    return { ...steps[0], n: S.queue.n - steps.length + 1, of: S.queue.n };
}
// what is still open on a draft order, in the order the band asks it: lines to check, unknown products, then flags
const DOUBT = { unknown_product: 'Not in the catalogue', ambiguous_product: 'More than one product fits', unusual_quantity: 'Unusual quantity', quantity_missing: 'Quantity missing' };
function pending(o) {
    const live = lines(o).filter((l) => l.state !== 'removed');
    const out = [];
    for (const l of live)
        if (l.state === 'check')
            out.push(lineStep(l, ((l.flags || []).find((f) => sev(f) !== 'info') || { message: 'Check «' + l.product_text + '».' }).message));
    for (const l of live) {
        const f = (l.flags || []).find((x) => x.kind === 'unknown_product');
        if (l.state === 'flag' && f)
            out.push(lineStep(l, f.message));
    }
    const all = [...flagsOf(o).map((f) => [f]), ...live.filter((l) => l.state !== 'check').flatMap((l) => (l.flags || []).map((f) => [f, l]))];
    const seen = new Set(); // ponytail: one acknowledgement per flag kind, which is also what the server asks for
    const rules = [['high', ['unknown_product'], 'Seen'], ['medium', CHECK_KINDS, 'OK']];
    for (const [level, skip, label] of rules) {
        for (const [f, l] of all) {
            if (sev(f) !== level || skip.includes(f.kind) || S.ack.has(f.kind) || seen.has(f.kind))
                continue;
            seen.add(f.kind);
            out.push(flagStep(f, label, l));
        }
    }
    return out;
}
// the words every candidate shares are already in the question: "Prosecco Brut Vallecorta 75cl" and "Prosecco Extra Dry Vallecorta 75cl" read "Brut" and "Extra Dry"
function distinct(names) {
    const orig = names.map((n) => n.split(/\s+/)), toks = orig.map((t) => t.map((w) => w.toLowerCase()));
    const room = Math.min(...toks.map((t) => t.length)) - 1; // every name keeps a word
    let head = 0, tail = 0;
    while (head < room && toks.every((t) => t[head] === toks[0][head]))
        head++;
    while (tail < room - head && toks.every((t) => t[t.length - 1 - tail] === toks[0][toks[0].length - 1 - tail]))
        tail++;
    const cut = () => orig.map((t) => t.slice(head, t.length - tail).join(' '));
    if (tail && cut().some((c) => /(^| )[\d.,]+$/.test(c)))
        tail--; // "… 1 l" and "… 5 l" must not become "1" and "5"
    const short = cut();
    return names.length > 1 && short.every(Boolean) && new Set(short.map((c) => c.toLowerCase())).size === short.length ? short : names;
}
function lineStep(l, msg) {
    const finding = S.find === l.id;
    const cands = (l.candidates || []).slice(0, 3);
    const kind = l.sku === null && cands.length ? 'which' : l.sku !== null && (l.qty === null || l.qty <= 0) ? 'qty' : cands.length ? 'which' : 'other';
    const missing = kind === 'other' && hasFlag(l, 'unknown_product');
    const q = kind === 'which' ? 'Which ' + l.product_text + '?' : kind === 'qty' ? 'How many ' + l.product_text + '?' : missing ? '«' + l.product_text + '» is not in your catalogue.' : msg;
    const find = () => { S.find = l.id; renderScreen(); };
    const asCands = () => {
        const full = cands.map((c) => c.name || c.sku), short = distinct(full);
        return cands.map((c, i) => sug(short[i], c.why || '', () => patch(l.id, { sku: c.sku }), /their/.test(c.why || ''), { title: full[i], 'aria-label': full[i] + (c.why ? ', ' + c.why : '') }));
    };
    const ctl = () => {
        if (finding)
            return searchBox(l);
        if (kind === 'qty')
            return qtyForm(l);
        // no candidate: the closest products in the catalogue are offered straight away, searching is the fallback
        if (!cands.length)
            return [fill(h('div', { class: 'results inline' }), l, l.product_text, find), hasFlag(l, 'unknown_product') && pick('Remove line', () => patch(l.id, { removed: true }), { class: 'pick quiet' })];
        return asCands();
    };
    const alts = () => (finding ? alt('Back', back, 'back') : [(kind === 'which' || missing) && alt('Search catalogue', find, 'search'), alt('Ask the customer', doDraft, 'whatsapp')]);
    return { key: 'line:' + l.id + ':' + kind + (finding ? ':find' : ''), q, sub: missing && !finding ? 'Closest in the catalogue. Pick one or remove the line; CatOrder never guesses.' : undefined, line: l.id, ctl, alt: alts };
}
function flagStep(f, label, l) {
    return { key: 'flag:' + f.kind, q: f.message, line: l && l.id, ctl: () => pick(label, () => { S.ack.add(f.kind); renderScreen(); }) };
}
// a click on a row (or "Change quantity"): that line's quantity, whatever the queue was asking, until Set, Remove line / Restore or Back
function editRow(l) { S.row = l.id; S.find = null; renderScreen(); }
function rowStep(l) {
    const out = l.state === 'removed';
    return {
        key: 'row:' + l.id, q: 'How many ' + lineName(l) + '?', line: l.id,
        ctl: () => qtyForm(l, true),
        alt: () => [alt('Back', back, 'back'), alt(out ? 'Restore' : 'Remove line', () => patch(l.id, { removed: !out }))], // removing is a side road, not a second button
    };
}
function qtyForm(l, editing = false) {
    const unit = { case: 'cases', piece: 'pieces', kg: 'kg' }[l.sell_unit || ''];
    const inp = h('input', { type: 'number', class: 'field', min: 0, step: 'any', inputMode: 'decimal', 'aria-label': 'Quantity' + (unit ? ' in ' + unit : ''), value: editing && l.qty !== null ? l.qty : null, onkeydown: (e) => {
            if (e.key === 'Enter')
                set();
            else if (e.key === 'Escape' && editing) {
                e.stopPropagation();
                back();
            }
        } });
    const set = () => { const v = Number(inp.value); if (inp.value === '' || !(v > 0))
        inp.focus();
    else
        void patch(l.id, { qty: v }); };
    // one row: the number, its unit always visible (not a placeholder that vanishes on typing), then Set
    return h('div', { class: 'qrow' }, h('label', { class: 'qin' }, inp, unit && h('span', { class: 'unit', 'aria-hidden': 'true' }, unit)), pick('Set', set));
}
function searchBox(l) {
    const res = h('div', { class: 'results' });
    let tm;
    // opens on the customer's own words, already searched; typing replaces them (the band selects the field)
    const inp = h('input', { type: 'search', class: 'field', placeholder: 'Product name', 'aria-label': 'Search the catalogue', autocomplete: 'off', value: l.product_text,
        onkeydown: (e) => { if (e.key === 'Escape') {
            e.stopPropagation();
            back();
        } },
        oninput: () => {
            clearTimeout(tm);
            tm = setTimeout(() => fill(res, l, inp.value), 180);
        } });
    return [inp, fill(res, l, l.product_text)];
}
const found = new Map(); // ponytail: per-page cache, the catalogue does not change under the band
// three catalogue products for a query, as suggestions in `res`; with none, `none` offers a way on
function fill(res, l, q, none) {
    q = q.trim().toLowerCase();
    if (!q) {
        res.replaceChildren();
        return res;
    }
    if (!found.has(q))
        found.set(q, api('/catalog?q=' + encodeURIComponent(q)).catch((e) => { found.delete(q); toast(errMsg(e)); return []; }));
    void found.get(q).then((ps) => res.replaceChildren(...(ps.length
        ? ps.slice(0, 3).map((p) => sug(p.name, p.pack_label, () => patch(l.id, { sku: p.sku }), false, { title: p.name })) // ponytail: three fit the band, a longer query narrows them
        : none ? [pick('Find the product', none)] : [h('p', { class: 'nofind' }, 'Nothing in the catalogue matches «' + q + '». Try fewer words.')])));
    return res;
}
let lastKey = '';
function paintBand(b) {
    const el = $('band');
    el.hidden = !b;
    if (!b) {
        lastKey = '';
        el.replaceChildren();
        return;
    }
    const inside = el.contains(document.activeElement);
    const counted = (b.of || 0) > 1 && b.key !== 'ready', at = b.n || 0;
    const prog = counted && h('div', { class: 'prog', 'aria-hidden': 'true' }, // the queue along the top edge: answered, the one asked now (green: look here), still to come
    Array.from({ length: b.of || 0 }, (_, i) => h('i', { class: i + 1 < at ? 'done' : i + 1 === at ? 'now' : null })));
    el.replaceChildren(...[prog, h('div', { class: 'in' + (settled && b.key !== lastKey ? (arrival ? ' lift' : ' fade') : '') }, b.icon && glyph('mark ' + b.icon, b.icon), h('div', { class: 'words' }, h('p', { class: 'q' + (b.q.length <= 32 ? '' : b.q.length <= 60 ? ' mid' : ' long') }, b.q, counted && h('span', { class: 'step' }, b.n + ' of ' + b.of)), // a flag sentence is not a headline
        b.sub && h('p', { class: 'sub' }, b.sub)), b.alt && h('div', { class: 'alts' }, b.alt()), b.ctl && h('div', { class: 'ctl' }, b.ctl()))].filter((n) => !!n));
    lastKey = b.key;
    el.querySelectorAll('.pick').forEach((p, i) => { if (i < 9)
        p.setAttribute('aria-keyshortcuts', String(i + 1)); });
    // an input gets the cursor; after an action the cursor stays in the band but never lands on a button, so a second Enter confirms nothing
    const field = el.querySelector('input');
    if (field && (inside || document.activeElement === document.body)) {
        field.focus();
        field.select();
    }
    else if (inside)
        el.focus({ preventScroll: true });
}
/* ---------- actions ---------- */
async function doRead(to) {
    const route = to === 'new' || to === 'attach' ? to : undefined; // a click passes its event, not a route
    if (S.busy || !S.sel)
        return;
    const id = S.sel;
    S.busy = id;
    delete S.failed[id];
    delete S.trace[id];
    readEnded.delete(id);
    renderScreen();
    renderInbox();
    let traced = Promise.resolve();
    await new Promise((ok) => { traced = startTrace(id, true, ok); });
    try {
        const r = await (route ? send('POST', '/messages/' + id + '/route', { to: route }) : send('POST', '/messages/' + id + '/read'));
        S.runs[id] = r.runs || [];
        if (r.reading)
            S.reading[id] = r.reading;
        const err = (r.runs || []).find((x) => x.error);
        if (!r.order)
            S.failed[id] = (err && err.error) || r.error || 'The model gave no answer.';
        S.ack = new Set();
    }
    catch (e) {
        S.failed[id] = errMsg(e);
        toast(errMsg(e));
    }
    await Promise.race([traced, new Promise((ok) => setTimeout(ok, 20000))]); // the draft appears once the steps have played out
    S.busy = null;
    const tr = S.trace[id];
    if (tr && tr.es) {
        tr.es.close();
        tr.es = null;
        tr.done = true;
    }
    await loadMessages();
    if (S.sel === id)
        await loadDetail();
}
// one write at a time: a second click while the first is on its way does nothing
async function write(fn) {
    if (writing)
        return;
    writing = true;
    try {
        await fn();
    }
    catch (e) {
        toast(errMsg(e));
    }
    S.find = S.row = null;
    try {
        await refresh();
    }
    finally {
        writing = false;
    }
}
const patch = (lineId, body) => write(() => send('PATCH', '/lines/' + lineId, body));
// the model writes the reply from the order as it stands; it lands in the chat as a draft for the operator
async function doDraft() {
    const d = S.detail;
    if (!d || S.drafting || writing)
        return;
    const id = d.message.id;
    S.drafting = id;
    renderScreen();
    try {
        const r = await send('POST', '/messages/' + id + '/reply');
        S.later.delete(r.id);
        delete S.typed[r.id];
        if (S.detail && S.detail.message.id === id)
            S.detail.reply = r;
    }
    catch (e) {
        toast(errMsg(e));
    }
    S.drafting = null;
    renderScreen();
    // the new draft, not the first one in the chat (older messages keep theirs); the chat follows it down, never up
    const r = S.detail && S.detail.message.id === id ? S.detail.reply : null;
    requestAnimationFrame(() => { const t = draftBox(r && r.id); t?.focus({ preventScroll: true }); reveal(t && t.closest('.msg')); });
}
const draftBox = (id) => (id ? document.querySelector('textarea[data-reply="' + id + '"]') : null);
// what the operator typed in the draft is saved before anything else happens to it
async function saveReply(r) {
    const t = S.typed[r.id];
    if (t === undefined || t.trim() === r.text)
        return true;
    try {
        Object.assign(r, await send('PATCH', '/replies/' + r.id, { text: t }));
        delete S.typed[r.id];
        return true;
    }
    catch (e) {
        toast(errMsg(e));
        return false;
    }
}
async function doSend(r) {
    if (writing || !(await saveReply(r)))
        return;
    await write(async () => {
        const x = await send('POST', '/replies/' + r.id + '/send');
        toast(x.via === 'whatsapp' ? 'Sent on WhatsApp.' : 'Marked as sent. Demo: this customer has no WhatsApp number, nothing was delivered.');
    });
    const cid = S.detail && S.detail.message.customer_id;
    if (cid)
        void loadThread(cid);
}
function replyStep(r) {
    const by = r.model === 'template' ? 'Written from the order in demo mode' : 'Drafted by ' + r.model;
    return { key: 'reply:' + r.id, icon: 'send', q: 'Send this reply?', sub: by + ' · edit it in the chat first if you like',
        ctl: () => pick('Send on WhatsApp', () => doSend(r), { 'data-main': true }),
        alt: () => [alt('Write it again', async () => { if (await saveReply(r))
                void doDraft(); }), alt('Later', () => { void saveReply(r); S.later.add(r.id); renderScreen(); })] };
}
async function doConfirm() {
    const o = S.detail && S.detail.order;
    if (S.busy || !o || o.status !== 'draft' || pending(o).length || !lines(o).some((l) => l.state !== 'removed'))
        return;
    S.done.add(o.id);
    await write(() => send('POST', '/orders/' + o.id + '/confirm', { acknowledged: [...S.ack] }));
    // the ERP import lands below the lines: bring it into view above the band
    requestAnimationFrame(() => document.querySelector('.erp')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end' }));
}
/* ---------- keyboard and pointer ---------- */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (S.sel || S.cust)
            goWaiting();
        return;
    }
    // ⌘↵ presses the band's main action (Confirm, Send); the draft textarea handles its own and marks it handled
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (!e.defaultPrevented) {
            e.preventDefault();
            $('band').querySelector('[data-main]')?.click();
        }
        return;
    }
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))
        return;
    if (e.key === 'j' || e.key === 'k') {
        const i = S.messages.findIndex((m) => m.id === S.sel);
        const n = S.messages[Math.max(0, Math.min(S.messages.length - 1, i + (e.key === 'j' ? 1 : -1)))];
        if (n)
            void select(n.id).then(() => { const r = document.querySelector('.irow.sel'); if (r)
                r.scrollIntoView({ block: 'nearest' }); });
    }
    else if (e.key === 'r') {
        const o = S.detail && S.detail.order;
        if (S.sel && (!o || o.status !== 'confirmed'))
            void doRead();
    }
    else if (/^[1-9]$/.test(e.key)) {
        $('band').querySelectorAll('.pick')[Number(e.key) - 1]?.click();
    }
});
$('inboxBtn').addEventListener('click', goWaiting);
$('find').addEventListener('input', (e) => { S.q = e.target.value; renderInbox(); });
$('home').addEventListener('click', goWaiting);
// the page leaves room for the band, whatever height its question and buttons give it
const fitBand = () => document.documentElement.style.setProperty('--band-h', $('band').offsetHeight + 'px');
new ResizeObserver(fitBand).observe($('band'));
void boot();
