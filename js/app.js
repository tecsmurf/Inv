import * as db from './db.js';
import {
  UNITS, DEFAULT_ITEMS, round2, parseQty, lineAmount, normalizeLines, billTotals, daySummary, udhaarBalances,
  dateKey, prettyDate, rupees, unitLabel, whatsappText, whatsappLink, newShopCode, normalizeCode, prettyCode, toCSV,
} from './calc.js';

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const $ = (s) => document.querySelector(s);
const main = $('#main');
const setMain = (...kids) => main.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const LS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
function openSheet(...content) {
  const s = $('#sheet');
  s.replaceChildren(h('div', { class: 'panel' }, ...content));
  s.hidden = false;
  s.onclick = (e) => { if (e.target === s) closeSheet(); };
}
const closeSheet = () => { $('#sheet').hidden = true; $('#sheet').replaceChildren(); };
const fail = (e) => { console.error(e); toast('⚠️ ' + (e?.code || e?.message || e)); };

// ---------- state ----------
const S = {
  code: LS.get('shopCode'),
  myName: LS.get('myName') || '',
  shop: null,
  view: 'today',
  today: dateKey(),
  day: { bills: [], payments: [], info: null, pending: false, fromCache: true },
  udhaar: { bills: [], payments: [] },
  days: [],
  unsub: [],
};

const modeOf = (b) => {
  const used = ['upi', 'cash', 'udhaar'].filter((m) => (b.pay?.[m] || 0) > 0);
  return used.length > 1 ? 'mixed' : used[0] || 'cash';
};
const MODE_LABEL = { upi: 'UPI', cash: 'नकद Cash', udhaar: 'उधार', mixed: 'मिक्स' };
const modeTag = (b) => {
  const m = modeOf(b);
  return h('span', { class: 'tag c-' + m }, MODE_LABEL[m]);
};
const nowTime = () => new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const memberName = (uid) => S.shop?.memberNames?.[uid] || '—';
const allItems = () => {
  const seen = new Set();
  return [...(S.shop?.items || []), ...DEFAULT_ITEMS].filter((i) => !seen.has(i.name) && seen.add(i.name));
};

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const emu = new URLSearchParams(location.search).has('emulator');
  if (!db.configured && !emu) return renderNotConfigured();
  try { await db.init(); } catch (e) { setMain(h('div', { class: 'card' }, '⚠️ Could not sign in: ' + (e.code || e.message), h('p', { class: 'small muted' }, 'Check that Anonymous sign-in is enabled in Firebase (README step 3).'))); return; }
  window.addEventListener('online', updateSync); window.addEventListener('offline', updateSync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dateKey() !== S.today) { S.today = dateKey(); subscribeDay(); } });
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => go(b.dataset.view)));
  if (S.code) startShop(); else renderSetup();
}

function renderNotConfigured() {
  setMain(h('div', { class: 'card' },
    h('h2', {}, 'Setup needed / सेटअप बाकी है'),
    h('p', {}, 'Firebase details are not filled in yet. Open js/config.js and paste your Firebase web config. Steps are in README.md.'),
  ));
}

function startShop() {
  S.unsub.forEach((u) => u()); S.unsub = [];
  S.unsub.push(db.watchShop(S.code, (shop, meta) => {
    if (!shop || !shop.memberUids.includes(db.uid)) {
      if (meta && meta.fromCache) return; // wait for server answer before deciding
      toast(shop ? 'This phone was removed from the shop / इस फ़ोन को हटा दिया गया' : 'Shop not found');
      leaveLocal(); return;
    }
    const first = !S.shop;
    S.shop = shop;
    $('#shopTitle').textContent = shop.name;
    $('#tabs').hidden = false;
    if (first) go(S.view); else if (['settings'].includes(S.view)) render();
  }, (e) => { if (e.code === 'permission-denied') { toast('No access to this shop'); leaveLocal(); } else fail(e); }));
  subscribeDay();
  S.unsub.push(db.watchUdhaar(S.code, (k, rows) => { S.udhaar[k] = rows; if (S.view === 'udhaar') render(); }, fail));
  S.unsub.push(db.watchDays(S.code, (rows) => { S.days = rows; if (S.view === 'history') render(); }, fail));
}

let dayUnsub = null;
function subscribeDay() {
  if (dayUnsub) dayUnsub();
  S.day = { bills: [], payments: [], info: null, pending: false, fromCache: true };
  dayUnsub = db.watchDay(S.code, S.today, (k, rows, meta) => {
    if (k === 'bills') { S.day.bills = rows; S.day.pending = meta.hasPendingWrites; S.day.fromCache = meta.fromCache; updateSync(); }
    else if (k === 'payments') S.day.payments = rows;
    else S.day.info = rows;
    if (S.view === 'today') render();
  }, fail);
}

function updateSync() {
  const el = $('#sync');
  el.hidden = false;
  if (!navigator.onLine) { el.textContent = '📴 Offline – saved on phone'; el.className = 'sync off'; }
  else if (S.day.pending) { el.textContent = '⏳ Syncing…'; el.className = 'sync off'; }
  else { el.textContent = '✅ Synced'; el.className = 'sync'; }
}

function leaveLocal() {
  S.unsub.forEach((u) => u()); S.unsub = []; if (dayUnsub) dayUnsub();
  LS.set('shopCode', null); S.code = null; S.shop = null;
  $('#tabs').hidden = true; $('#shopTitle').textContent = 'दुकान का हिसाब';
  renderSetup();
}

function go(view, arg) {
  S.view = view; S.arg = arg;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view || (view === 'bill' && b.dataset.view === 'today')));
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (!S.shop) return;
  ({ today: renderToday, bill: renderBillForm, udhaar: renderUdhaar, history: renderHistory, settings: renderSettings })[S.view]?.();
}

// ---------- setup: create or join ----------
function renderSetup() {
  const nameIn = h('input', { placeholder: 'जैसे: Raju', value: S.myName, autocomplete: 'name' });
  const shopIn = h('input', { placeholder: 'जैसे: श्री गणेश हैंडलूम' });
  const phoneIn = h('input', { type: 'tel', inputmode: 'tel', placeholder: '10 digit mobile' });
  const codeIn = h('input', { placeholder: 'ABCD-1234', autocapitalize: 'characters', style: 'text-transform:uppercase;letter-spacing:2px' });
  const needName = () => {
    const n = nameIn.value.trim();
    if (!n) { toast('पहले अपना नाम लिखें / Enter your name'); nameIn.focus(); return null; }
    S.myName = n; LS.set('myName', n); return n;
  };
  setMain(
    h('div', { class: 'welcome' }, h('div', { class: 'big' }, '🧶'), h('h2', {}, 'नमस्ते! Welcome'),
      h('p', { class: 'muted' }, 'रोज़ की बिक्री अब फ़ोन में – 5 फ़ोन तक एक साथ।')),
    h('div', { class: 'card' }, h('label', {}, 'आपका नाम · Your name'), nameIn),
    h('div', { class: 'card' },
      h('h3', {}, '🔑 कोड से जुड़ें · Join a shop'),
      h('p', { class: 'small muted' }, 'दुकान के मालिक से 8 अक्षर का कोड लें।'),
      codeIn,
      h('div', { style: 'height:10px' }),
      h('button', { class: 'btn primary block', onclick: async (e) => {
        const n = needName(); if (!n) return;
        const code = normalizeCode(codeIn.value);
        if (code.length !== 8) return toast('Code 8 अक्षर का होता है');
        e.target.disabled = true;
        try {
          const r = await db.joinShop(code, n);
          if (r === 'notfound') toast('❌ यह कोड नहीं मिला / Code not found');
          else if (r === 'full') toast('❌ 5 फ़ोन पहले से जुड़े हैं। सेटिंग में किसी पुराने फ़ोन को हटाएं।', 4500);
          else { LS.set('shopCode', code); S.code = code; toast('✅ जुड़ गए! Joined'); startShop(); }
        } catch (err) { fail(err); }
        e.target.disabled = false;
      } }, 'जुड़ें · Join'),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '🏪 नई दुकान बनाएं · Create new shop'),
      h('p', { class: 'small muted' }, 'सिर्फ़ मालिक एक बार करें। Only the owner, once.'),
      h('label', {}, 'दुकान का नाम · Shop name'), shopIn,
      h('label', {}, 'मालिक का WhatsApp नंबर · Owner WhatsApp'), phoneIn,
      h('div', { style: 'height:10px' }),
      h('button', { class: 'btn block', onclick: async (e) => {
        const n = needName(); if (!n) return;
        if (!shopIn.value.trim()) return toast('दुकान का नाम लिखें');
        if (phoneIn.value.replace(/\D/g, '').length < 10) return toast('सही WhatsApp नंबर लिखें');
        e.target.disabled = true;
        const code = newShopCode(() => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32);
        try {
          await db.createShop({ code, shopName: shopIn.value.trim(), ownerPhone: phoneIn.value.trim(), myName: n });
          LS.set('shopCode', code); S.code = code; S.view = 'settings';
          toast('✅ दुकान बन गई! अब कोड दूसरे फ़ोन को भेजें।', 4000);
          startShop();
        } catch (err) { fail(err); e.target.disabled = false; }
      } }, 'दुकान बनाएं · Create'),
    ),
  );
}

// ---------- today ----------
function statCards(s) {
  return h('div', { class: 'stats' },
    h('div', { class: 'stat total' }, h('span', { class: 'lbl' }, 'कुल बिक्री · Total sale'), h('b', {}, rupees(s.total)), h('span', { class: 'lbl' }, `${s.billCount} bills`)),
    h('div', { class: 'stat' }, h('span', { class: 'lbl c-upi' }, '📱 UPI'), h('b', {}, rupees(s.upi))),
    h('div', { class: 'stat' }, h('span', { class: 'lbl c-cash' }, '💵 नकद Cash'), h('b', {}, rupees(s.cash))),
    h('div', { class: 'stat' }, h('span', { class: 'lbl c-udhaar' }, '📒 उधार दिया'), h('b', {}, rupees(s.udhaar))),
    h('div', { class: 'stat' }, h('span', { class: 'lbl' }, '↩️ उधार वापस'), h('b', {}, rupees(s.recvCash + s.recvUpi))),
  );
}

function billRow(b, i) {
  const items = (b.lines || []).map((l) => l.name ? `${l.name} ${l.qtyText || l.qty}${l.unit !== 'pc' ? ' ' + unitLabel(l.unit) : ''}` : '').filter(Boolean).join(', ');
  return h('div', { class: 'bill' + (b.cancelled ? ' cancelled' : ''), onclick: () => showBill(b) },
    h('div', { class: 'no' }, i + 1),
    h('div', { class: 'grow' },
      h('div', {}, modeTag(b), b.customer?.name ? h('b', {}, b.customer.name) : null, b._pending ? ' ⏳' : ''),
      h('div', { class: 'small' }, items || b.note || '—'),
      h('div', { class: 'small muted' }, `${b.time || ''} · ${b.byName || ''}${b.cancelled ? ' · CANCELLED' : ''}`)),
    h('div', { class: 'amt' }, rupees(b.total)),
  );
}

function renderToday() {
  const bills = [...S.day.bills].sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
  const s = daySummary(bills, S.day.payments);
  const info = S.day.info;
  const afterClose = info?.closed ? bills.filter((b) => (b.createdAtMs || 0) > (info.closedAtMs || 0)).length : 0;
  setMain(
    h('div', { class: 'row between' }, h('h2', {}, 'आज · ' + prettyDate(S.today)), S.day.fromCache && navigator.onLine ? h('span', { class: 'small muted' }, 'loading…') : null),
    info?.closed ? h('div', { class: 'banner' + (afterClose ? ' warn' : '') },
      afterClose ? `⚠️ दिन ${info.closedTime || ''} पर बंद हुआ था, उसके बाद ${afterClose} नया बिल। फिर से भेजें।` : `✅ दिन बंद · Day closed at ${info.closedTime || ''} by ${info.closedByName || ''}`) : null,
    statCards(s),
    h('div', { class: 'fab-row' },
      h('button', { class: 'btn primary big block', onclick: () => go('bill') }, '➕ नया बिल · New bill'),
    ),
    h('div', { class: 'card' },
      h('h3', {}, `बिल · Bills (${bills.length})`),
      bills.length ? bills.map(billRow).reverse() : h('p', { class: 'muted center' }, 'आज अभी कोई बिल नहीं। No bills yet.')),
    h('button', { class: 'btn wa big block', onclick: () => showCloseDay(s) }, '🔒 दिन बंद करें · Close day → WhatsApp'),
    h('p', { class: 'small muted center' }, 'आखिरी ग्राहक के बाद दबाएं। Press after the last customer.'),
  );
}

function showBill(b) {
  const receipt = billText(b);
  openSheet(
    h('div', { class: 'row between' }, h('h3', {}, `Bill · ${b.time || ''}`), h('button', { class: 'x', onclick: closeSheet }, '✕')),
    b.cancelled ? h('div', { class: 'banner warn' }, 'यह बिल रद्द है · Cancelled') : null,
    h('table', {},
      h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'r' }, 'Qty'), h('th', { class: 'r' }, 'Rate'), h('th', { class: 'r' }, '₹')),
      (b.lines || []).map((l) => h('tr', {}, h('td', {}, l.name || '—'), h('td', { class: 'r' }, `${l.qtyText || l.qty} ${unitLabel(l.unit)}`), h('td', { class: 'r' }, l.rate), h('td', { class: 'r' }, rupees(l.amount)))),
      b.discount ? h('tr', {}, h('td', { colspan: 3 }, 'छूट Discount'), h('td', { class: 'r' }, '-' + rupees(b.discount))) : null,
      h('tr', {}, h('th', { colspan: 3 }, 'Total'), h('th', { class: 'r' }, rupees(b.total))),
    ),
    h('p', {}, ['upi', 'cash', 'udhaar'].filter((m) => b.pay?.[m] > 0).map((m) => h('span', { class: 'tag c-' + m }, `${MODE_LABEL[m]} ${rupees(b.pay[m])}`))),
    b.customer?.name ? h('p', {}, '👤 ', b.customer.name, b.customer.phone ? ' · ' + b.customer.phone : '') : null,
    b.note ? h('p', { class: 'muted' }, '📝 ', b.note) : null,
    h('p', { class: 'small muted' }, `By ${b.byName || '—'}${b.editedAt ? ' · edited' : ''}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn grow', onclick: () => { closeSheet(); go('bill', b); } }, '✏️ Edit'),
      b.customer?.phone ? h('a', { class: 'btn wa grow', href: whatsappLink(b.customer.phone, receipt), target: '_blank', rel: 'noopener' }, '📤 Customer') : null,
    ),
    h('div', { style: 'height:8px' }),
    h('button', { class: 'btn danger block', onclick: () => {
      db.cancelBill(S.code, b.id, !b.cancelled).catch(fail);
      closeSheet(); toast(b.cancelled ? 'बिल वापस चालू' : 'बिल रद्द किया · Cancelled');
    } }, b.cancelled ? '↩️ Restore bill' : '🗑️ बिल रद्द करें · Cancel bill'),
  );
}

function billText(b) {
  const L = [`🧾 ${S.shop.name}`, prettyDate(b.date) + ' ' + (b.time || ''), ''];
  for (const l of b.lines || []) L.push(`${l.name || 'Item'} – ${l.qtyText || l.qty} ${unitLabel(l.unit)} × ${l.rate} = ${rupees(l.amount)}`);
  if (b.discount) L.push(`Discount: -${rupees(b.discount)}`);
  L.push(`*Total: ${rupees(b.total)}*`);
  for (const m of ['upi', 'cash', 'udhaar']) if (b.pay?.[m] > 0) L.push(`${MODE_LABEL[m]}: ${rupees(b.pay[m])}`);
  L.push('', 'धन्यवाद! 🙏');
  return L.join('\n');
}

function showCloseDay(s) {
  const time = nowTime();
  const text = whatsappText({ shopName: S.shop.name, date: S.today, summary: s, closedBy: S.myName, time });
  const link = whatsappLink(S.shop.ownerPhone, text);
  openSheet(
    h('div', { class: 'row between' }, h('h3', {}, '🔒 दिन बंद करें · Close day'), h('button', { class: 'x', onclick: closeSheet }, '✕')),
    h('p', { class: 'small muted' }, `यह संदेश मालिक (${S.shop.ownerPhone}) को WhatsApp पर जाएगा। WhatsApp खुलने पर Send दबाएं।`),
    h('pre', {}, text),
    h('a', { class: 'btn wa big block', href: link, target: '_blank', rel: 'noopener', onclick: () => {
      db.closeDay(S.code, S.today, { summary: { ...s, items: s.items.slice(0, 30) }, closedByName: S.myName, closedTime: time, closedAtMs: Date.now() }).catch(fail);
      setTimeout(closeSheet, 300);
    } }, '📤 WhatsApp पर भेजें · Send'),
  );
}

// ---------- bill form ----------
function renderBillForm() {
  const editing = S.arg && S.arg.id ? S.arg : null;
  const F = editing
    ? { lines: editing.lines.map((l) => ({ name: l.name, qty: l.qtyText ?? String(l.qty), unit: l.unit, rate: String(l.rate) })),
        discount: editing.discount ? String(editing.discount) : '', mode: modeOf(editing),
        split: { upi: String(editing.pay?.upi || ''), cash: String(editing.pay?.cash || '') },
        customer: { ...(editing.customer || { name: '', phone: '' }) }, note: editing.note || '' }
    : { lines: [{ name: '', qty: '1', unit: 'pc', rate: '' }], discount: '', mode: 'upi', split: { upi: '', cash: '' }, customer: { name: '', phone: '' }, note: '' };

  const items = allItems();
  const dl = h('datalist', { id: 'itemlist' }, items.map((i) => h('option', { value: i.name })));
  const linesBox = h('div');
  const totalEl = h('b');
  const subEl = h('div', { class: 'small muted' });
  const modeBox = h('div');
  const errEl = h('div', { class: 'small c-udhaar' });

  const recalc = () => {
    linesBox.querySelectorAll('.line').forEach((row, i) => { row.querySelector('.amt').textContent = rupees(lineAmount(F.lines[i])); });
    const t = billTotals(F.lines, F.discount, F.mode, F.split);
    totalEl.textContent = rupees(t.total);
    subEl.textContent = t.discount ? `${rupees(t.subtotal)} − ${rupees(t.discount)}` : `${normalizeLines(F.lines).length} item`;
    const udEl = modeBox.querySelector('.udrest');
    if (udEl) udEl.textContent = rupees(t.pay.udhaar);
    errEl.textContent = t.error === 'overpaid' ? 'UPI + Cash कुल से ज़्यादा है' : '';
    return t;
  };

  const drawLines = () => {
    linesBox.replaceChildren(...F.lines.map((l, i) => {
      const name = h('input', { value: l.name, placeholder: 'सामान · Item (e.g. कंबल)', list: 'itemlist', oninput: (e) => {
        l.name = e.target.value;
        const known = items.find((it) => it.name === l.name);
        if (known) {
          l.unit = known.unit || l.unit; unit.value = l.unit;
          if (known.rate && !l.rate) { l.rate = String(known.rate); rate.value = l.rate; }
          recalc();
        }
      } });
      const qty = h('input', { value: l.qty, inputmode: 'decimal', placeholder: '1 / 4x6', oninput: (e) => { l.qty = e.target.value; qty.style.borderColor = e.target.value && !isFinite(parseQty(e.target.value)) ? 'var(--udhaar)' : ''; recalc(); } });
      const unit = h('select', { onchange: (e) => { l.unit = e.target.value; } }, UNITS.map((u) => h('option', { value: u.id, selected: u.id === l.unit }, `${u.hi} ${u.en}`)));
      const rate = h('input', { value: l.rate, inputmode: 'decimal', placeholder: '₹', oninput: (e) => { l.rate = e.target.value; recalc(); } });
      return h('div', { class: 'line' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, name),
          F.lines.length > 1 ? h('button', { class: 'x', title: 'remove', onclick: () => { F.lines.splice(i, 1); drawLines(); } }, '✕') : null),
        h('div', { class: 'g' },
          h('div', {}, h('label', {}, 'मात्रा Qty'), qty),
          h('div', {}, h('label', {}, 'इकाई Unit'), unit),
          h('div', {}, h('label', {}, 'रेट Rate ₹'), rate)),
        h('div', { class: 'amt' }, rupees(lineAmount(l))));
    }));
    recalc();
  };

  const drawMode = () => {
    const seg = h('div', { class: 'seg' }, [['upi', 'UPI', '📱'], ['cash', 'नकद', 'Cash'], ['udhaar', 'उधार', 'Credit'], ['mixed', 'मिक्स', 'Split']].map(([m, a, b]) =>
      h('button', { 'data-mode': m, class: F.mode === m ? 'on' : '', onclick: () => { F.mode = m; drawMode(); } }, a, h('small', {}, b))));
    const parts = [seg];
    if (F.mode === 'mixed') {
      parts.push(h('div', { class: 'row', style: 'margin-top:8px' },
        h('div', { class: 'grow' }, h('label', {}, 'UPI ₹'), h('input', { value: F.split.upi, inputmode: 'decimal', oninput: (e) => { F.split.upi = e.target.value; recalc(); } })),
        h('div', { class: 'grow' }, h('label', {}, 'Cash ₹'), h('input', { value: F.split.cash, inputmode: 'decimal', oninput: (e) => { F.split.cash = e.target.value; recalc(); } }))),
        h('p', { class: 'small' }, 'बाकी उधार · Rest as udhaar: ', h('b', { class: 'udrest c-udhaar' }, '₹0')));
    }
    if (F.mode === 'udhaar' || F.mode === 'mixed') {
      const names = udhaarBalances(S.udhaar.bills, S.udhaar.payments);
      parts.push(
        h('datalist', { id: 'custlist' }, names.map((c) => h('option', { value: c.name }))),
        h('label', {}, 'ग्राहक का नाम · Customer name (उधार के लिए ज़रूरी)'),
        h('input', { value: F.customer.name, list: 'custlist', placeholder: 'जैसे: शंकर जी कोरिया', oninput: (e) => {
          F.customer.name = e.target.value;
          const c = names.find((n) => n.name === e.target.value);
          if (c?.phone && !F.customer.phone) { F.customer.phone = c.phone; phoneIn.value = c.phone; }
        } }));
    }
    const phoneIn = h('input', { type: 'tel', inputmode: 'tel', value: F.customer.phone || '', placeholder: 'optional', oninput: (e) => (F.customer.phone = e.target.value) });
    parts.push(h('label', {}, 'ग्राहक मोबाइल · Customer mobile'), phoneIn);
    modeBox.replaceChildren(...parts);
    recalc();
  };

  const save = (e) => {
    const t = recalc();
    const lines = normalizeLines(F.lines);
    if (!lines.length || t.total <= 0) return toast('कम से कम एक सामान और रेट लिखें');
    if (F.lines.some((l) => String(l.qty).trim() && !isFinite(parseQty(l.qty)))) return toast('मात्रा गलत है (जैसे 2, 2.5 या 4x6)');
    if (t.error) return toast('UPI + Cash कुल से ज़्यादा है');
    if (t.pay.udhaar > 0 && !F.customer.name.trim()) return toast('उधार के लिए ग्राहक का नाम लिखें');
    const bill = {
      date: editing ? editing.date : S.today,
      time: editing ? editing.time : nowTime(),
      createdAtMs: editing ? editing.createdAtMs : Date.now(),
      lines, subtotal: t.subtotal, discount: t.discount, total: t.total, pay: t.pay,
      customer: { name: F.customer.name.trim(), phone: F.customer.phone.trim() },
      note: F.note.trim(),
      byName: editing ? editing.byName : S.myName,
      cancelled: editing ? !!editing.cancelled : false,
    };
    if (editing) bill.createdBy = editing.createdBy;
    e.target.disabled = true;
    const r = db.saveBill(S.code, bill, editing?.id);
    r.done.catch(fail);
    // remember new item names for next time
    const known = new Set(allItems().map((i) => i.name));
    const fresh = lines.filter((l) => l.name && !known.has(l.name)).map((l) => ({ name: l.name, unit: l.unit, rate: l.rate }));
    if (fresh.length) db.updateShop(S.code, { items: [...(S.shop.items || []), ...fresh].slice(-200) }).catch(() => {});
    toast(editing ? '✅ बिल बदला · Updated' : `✅ ${rupees(t.total)} saved`);
    go('today');
  };

  setMain(
    h('div', { class: 'row between' }, h('h2', {}, editing ? '✏️ बिल बदलें · Edit bill' : '🧾 नया बिल · New bill'), h('button', { class: 'btn small', onclick: () => go('today') }, '✕ Back')),
    dl, linesBox,
    h('button', { class: 'btn block', onclick: () => { F.lines.push({ name: '', qty: '1', unit: 'pc', rate: '' }); drawLines(); linesBox.lastChild.querySelector('input').focus(); } }, '➕ और सामान · Add item'),
    h('p', { class: 'small muted' }, 'Tip: गलीचा/दरी के लिए मात्रा में 4x6 लिखें = 24 वर्ग फ़ीट।'),
    h('label', {}, 'छूट · Discount ₹'),
    h('input', { value: F.discount, inputmode: 'decimal', placeholder: '0', oninput: (e) => { F.discount = e.target.value; recalc(); } }),
    h('div', { class: 'totalbar' }, h('div', {}, h('div', {}, 'कुल · Total'), subEl), totalEl),
    h('h3', {}, 'भुगतान · Payment'),
    modeBox, errEl,
    h('label', {}, 'नोट · Note'),
    h('input', { value: F.note, placeholder: 'optional (e.g. rate difference, wholesale)', oninput: (e) => (F.note = e.target.value) }),
    h('div', { style: 'height:14px' }),
    h('button', { class: 'btn primary big block', onclick: save }, '💾 सेव करें · Save bill'),
  );
  drawLines(); drawMode();
}

// ---------- udhaar ----------
function renderUdhaar() {
  const list = udhaarBalances(S.udhaar.bills, S.udhaar.payments);
  const open = list.filter((c) => c.due > 0.009);
  const totalDue = round2(open.reduce((s, c) => s + c.due, 0));
  if (S.arg?.customer) return renderCustomer(list.find((c) => c.key === S.arg.customer));
  setMain(
    h('h2', {}, '📒 उधार खाता · Udhaar'),
    h('div', { class: 'stats' }, h('div', { class: 'stat total' }, h('span', { class: 'lbl' }, 'कुल बाकी · Total due'), h('b', {}, rupees(totalDue)), h('span', { class: 'lbl' }, `${open.length} customers`))),
    h('div', { class: 'card' },
      open.length ? open.map((c) => h('div', { class: 'list-item', onclick: () => go('udhaar', { customer: c.key }) },
        h('div', {}, h('b', {}, c.name || '?'), h('div', { class: 'small muted' }, `last: ${c.last ? prettyDate(c.last) : ''}`)),
        h('b', { class: 'c-udhaar' }, rupees(c.due))))
        : h('p', { class: 'muted center' }, 'कोई उधार बाकी नहीं 🎉')),
    list.length > open.length ? h('details', { class: 'card' }, h('summary', {}, `चुकता · Settled (${list.length - open.length})`),
      list.filter((c) => c.due <= 0.009).map((c) => h('div', { class: 'list-item', onclick: () => go('udhaar', { customer: c.key }) }, c.name, h('span', { class: 'muted' }, rupees(c.given))))) : null,
  );
}

function renderCustomer(c) {
  if (!c) return go('udhaar');
  const amt = h('input', { inputmode: 'decimal', placeholder: '₹', value: c.due > 0 ? String(c.due) : '' });
  let mode = 'cash';
  const seg = h('div', { class: 'seg', style: 'grid-template-columns:1fr 1fr' });
  const drawSeg = () => seg.replaceChildren(...[['cash', 'नकद Cash'], ['upi', 'UPI']].map(([m, l]) => h('button', { 'data-mode': m, class: mode === m ? 'on' : '', onclick: () => { mode = m; drawSeg(); } }, l)));
  drawSeg();
  const entries = [
    ...S.udhaar.bills.filter((b) => !b.cancelled && (b.customer?.name || '').trim().toLowerCase() === c.key).map((b) => ({ date: b.date, time: b.time, give: b.pay.udhaar, b })),
    ...S.udhaar.payments.filter((p) => !p.cancelled && (p.customerName || '').trim().toLowerCase() === c.key).map((p) => ({ date: p.date, time: p.time, recv: p.amount, mode: p.mode, p })),
  ].sort((a, b) => (b.date + (b.b?.createdAtMs || b.p?.createdAtMs || 0)).localeCompare(a.date + (a.b?.createdAtMs || a.p?.createdAtMs || 0)));
  const remind = `नमस्ते ${c.name} जी, ${S.shop.name} का ${rupees(c.due)} उधार बाकी है। कृपया जल्द भुगतान करें। धन्यवाद 🙏`;
  setMain(
    h('div', { class: 'row between' }, h('h2', {}, '👤 ' + c.name), h('button', { class: 'btn small', onclick: () => go('udhaar') }, '← Back')),
    h('div', { class: 'stats' },
      h('div', { class: 'stat total' }, h('span', { class: 'lbl' }, 'बाकी · Due'), h('b', {}, rupees(c.due))),
      h('div', { class: 'stat' }, h('span', { class: 'lbl' }, 'उधार दिया'), h('b', {}, rupees(c.given))),
      h('div', { class: 'stat' }, h('span', { class: 'lbl' }, 'वापस मिला'), h('b', {}, rupees(c.received)))),
    h('div', { class: 'card' },
      h('h3', {}, '↩️ पैसा मिला · Payment received'),
      amt, h('div', { style: 'height:8px' }), seg, h('div', { style: 'height:10px' }),
      h('button', { class: 'btn primary block', onclick: () => {
        const a = round2(amt.value);
        if (!(a > 0)) return toast('रकम लिखें');
        db.addUdhaarPayment(S.code, { customerName: c.name, phone: c.phone || '', amount: a, mode, date: S.today, time: nowTime(), createdAtMs: Date.now(), byName: S.myName }).catch(fail);
        toast(`✅ ${rupees(a)} जमा`); amt.value = '';
      } }, 'जमा करें · Save payment'),
      c.phone ? h('div', { style: 'margin-top:8px' }, h('a', { class: 'btn wa block', href: whatsappLink(c.phone, remind), target: '_blank', rel: 'noopener' }, '📤 याद दिलाएं · Remind on WhatsApp')) : null),
    h('div', { class: 'card' }, h('h3', {}, 'खाता · Ledger'),
      h('table', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'r' }, 'उधार'), h('th', { class: 'r' }, 'जमा')),
        entries.map((e) => h('tr', { onclick: e.b ? () => showBill(e.b) : null },
          h('td', {}, prettyDate(e.date), h('div', { class: 'small muted' }, e.time || '', e.mode ? ' · ' + e.mode.toUpperCase() : '')),
          h('td', { class: 'r c-udhaar' }, e.give ? rupees(e.give) : ''),
          h('td', { class: 'r c-cash' }, e.recv ? rupees(e.recv) : ''))))),
  );
}

// ---------- history ----------
let histUnsub = null;
function renderHistory() {
  const picked = S.arg?.date;
  if (picked) return renderPastDay(picked);
  if (histUnsub) { histUnsub(); histUnsub = null; }
  const dateIn = h('input', { type: 'date', max: S.today, value: S.today });
  const month = h('input', { type: 'month', value: S.today.slice(0, 7) });
  const days = [...S.days].sort((a, b) => b.id.localeCompare(a.id));
  setMain(
    h('h2', {}, '📅 पुराना हिसाब · History'),
    h('div', { class: 'card' }, h('label', {}, 'कोई भी दिन देखें · Open a day'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, dateIn), h('button', { class: 'btn primary', onclick: () => dateIn.value && go('history', { date: dateIn.value }) }, 'देखें'))),
    h('div', { class: 'card' }, h('h3', {}, 'बंद किए गए दिन · Closed days'),
      days.length ? h('table', {},
        h('tr', {}, h('th', {}, 'Day'), h('th', { class: 'r' }, 'Total'), h('th', { class: 'r' }, 'UPI'), h('th', { class: 'r' }, 'Cash'), h('th', { class: 'r' }, 'उधार')),
        days.map((d) => h('tr', { onclick: () => go('history', { date: d.id }), style: 'cursor:pointer' },
          h('td', {}, prettyDate(d.id)), h('td', { class: 'r' }, h('b', {}, rupees(d.summary?.total))),
          h('td', { class: 'r c-upi' }, rupees(d.summary?.upi)), h('td', { class: 'r c-cash' }, rupees(d.summary?.cash)), h('td', { class: 'r c-udhaar' }, rupees(d.summary?.udhaar)))))
        : h('p', { class: 'muted' }, 'अभी कोई दिन बंद नहीं हुआ।')),
    h('div', { class: 'card' }, h('h3', {}, '⬇️ Excel/CSV backup'),
      h('p', { class: 'small muted' }, 'पूरे महीने के सारे बिल एक फ़ाइल में (Excel में खुलती है)।'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, month), h('button', { class: 'btn', onclick: async (e) => {
        if (!month.value) return;
        e.target.disabled = true;
        try {
          const [y, m] = month.value.split('-').map(Number);
          const last = new Date(y, m, 0).getDate();
          const bills = await db.billsBetween(S.code, `${month.value}-01`, `${month.value}-${String(last).padStart(2, '0')}`);
          bills.sort((a, b) => a.date.localeCompare(b.date) || (a.createdAtMs || 0) - (b.createdAtMs || 0));
          const url = URL.createObjectURL(new Blob([toCSV(bills)], { type: 'text/csv;charset=utf-8' }));
          h('a', { href: url, download: `sales-${month.value}.csv` }).click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          toast(`${bills.length} bills exported`);
        } catch (err) { fail(err); }
        e.target.disabled = false;
      } }, 'Download'))),
  );
}

function renderPastDay(date) {
  if (histUnsub) histUnsub();
  const D = { bills: [], payments: [], info: null };
  const draw = () => {
    if (S.view !== 'history' || S.arg?.date !== date) return;
    const bills = [...D.bills].sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    const s = daySummary(bills, D.payments);
    const text = whatsappText({ shopName: S.shop.name, date, summary: s, closedBy: D.info?.closedByName, time: D.info?.closedTime });
    setMain(
      h('div', { class: 'row between' }, h('h2', {}, prettyDate(date)), h('button', { class: 'btn small', onclick: () => { histUnsub?.(); histUnsub = null; go('history'); } }, '← Back')),
      statCards(s),
      s.items.length ? h('div', { class: 'card' }, h('h3', {}, '📦 सामान · Items'), h('table', {}, s.items.map((i) => h('tr', {}, h('td', {}, i.name), h('td', { class: 'r' }, `${i.qty} ${unitLabel(i.unit)}`), h('td', { class: 'r' }, rupees(i.amount)))))) : null,
      h('div', { class: 'card' }, h('h3', {}, `बिल · Bills (${bills.length})`), bills.length ? bills.map(billRow).reverse() : h('p', { class: 'muted' }, 'No bills')),
      h('a', { class: 'btn wa block', href: whatsappLink(S.shop.ownerPhone, text), target: '_blank', rel: 'noopener' }, '📤 यह हिसाब WhatsApp पर भेजें'),
    );
  };
  setMain(h('p', { class: 'muted center' }, 'Loading…'));
  histUnsub = db.watchDay(S.code, date, (k, rows) => { if (k === 'bills') D.bills = rows; else if (k === 'payments') D.payments = rows; else D.info = rows; draw(); }, fail);
}

// ---------- settings ----------
function renderSettings() {
  const sh = S.shop;
  const invite = `${sh.name} के हिसाब ऐप से जुड़ें 🧾\n1. यह लिंक खोलें: ${location.origin + location.pathname}\n2. "कोड से जुड़ें" में यह कोड डालें: ${prettyCode(S.code)}`;
  const nameIn = h('input', { value: S.myName });
  const shopIn = h('input', { value: sh.name });
  const phoneIn = h('input', { type: 'tel', value: sh.ownerPhone || '' });
  const newItem = { name: h('input', { placeholder: 'नाम Name' }), unit: h('select', {}, UNITS.map((u) => h('option', { value: u.id }, u.en))), rate: h('input', { placeholder: '₹ rate', inputmode: 'decimal' }) };
  setMain(
    h('h2', {}, '⚙️ सेटिंग · Settings'),
    h('div', { class: 'card' },
      h('h3', {}, '🔑 दुकान कोड · Shop code'),
      h('div', { class: 'code' }, prettyCode(S.code)),
      h('p', { class: 'small muted' }, `यह कोड दूसरे फ़ोन पर डालें। ${sh.memberUids.length}/5 फ़ोन जुड़े हैं। Keep it private: anyone with this code can join.`),
      h('div', { class: 'row' },
        h('a', { class: 'btn wa grow', href: 'https://wa.me/?text=' + encodeURIComponent(invite), target: '_blank', rel: 'noopener' }, '📤 Invite'),
        h('button', { class: 'btn grow', onclick: () => navigator.clipboard?.writeText(prettyCode(S.code)).then(() => toast('Copied'), () => toast(prettyCode(S.code))) }, '📋 Copy'))),
    h('div', { class: 'card' },
      h('h3', {}, '📱 जुड़े फ़ोन · Phones (' + sh.memberUids.length + '/5)'),
      sh.memberUids.map((u) => h('div', { class: 'list-item', style: 'cursor:default' },
        h('div', {}, memberName(u), u === db.uid ? h('span', { class: 'muted' }, ' (यह फ़ोन)') : '', u === sh.ownerUid ? h('span', { class: 'tag', style: 'margin-left:6px' }, 'owner') : ''),
        u !== db.uid ? h('button', { class: 'btn small danger', onclick: (e) => {
          if (e.target.dataset.sure) { db.removeMember(S.code, u).then(() => toast('हटा दिया'), fail); }
          else { e.target.dataset.sure = 1; e.target.textContent = 'पक्का? Sure?'; }
        } }, 'हटाएं') : null)),
      h('p', { class: 'small muted' }, 'फ़ोन खो गया या बदल गया? पुराने फ़ोन को यहाँ से हटाएं, फिर नया फ़ोन कोड से जोड़ें।')),
    h('div', { class: 'card' },
      h('h3', {}, '🏪 दुकान · Shop'),
      h('label', {}, 'आपका नाम · Your name (this phone)'), nameIn,
      h('label', {}, 'दुकान का नाम · Shop name'), shopIn,
      h('label', {}, 'मालिक का WhatsApp · Owner WhatsApp (daily total goes here)'), phoneIn,
      h('div', { style: 'height:10px' }),
      h('button', { class: 'btn primary block', onclick: () => {
        const n = nameIn.value.trim() || S.myName;
        S.myName = n; LS.set('myName', n);
        db.updateShop(S.code, { name: shopIn.value.trim() || sh.name, ownerPhone: phoneIn.value.trim() || sh.ownerPhone, [`memberNames.${db.uid}`]: n }).catch(fail);
        toast('✅ Saved');
      } }, 'सेव · Save')),
    h('div', { class: 'card' },
      h('h3', {}, '📦 सामान की सूची · Item list'),
      h('p', { class: 'small muted' }, 'बिल में नाम लिखते ही इकाई और रेट अपने आप भर जाएंगे।'),
      (sh.items || []).length ? h('table', {}, sh.items.map((it, i) => h('tr', {},
        h('td', {}, it.name), h('td', {}, unitLabel(it.unit)), h('td', { class: 'r' }, it.rate ? rupees(it.rate) : ''),
        h('td', { class: 'r' }, h('button', { class: 'x', onclick: () => db.updateShop(S.code, { items: sh.items.filter((_, j) => j !== i) }).catch(fail) }, '✕'))))) : null,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { style: 'flex:2' }, newItem.name), h('div', { style: 'flex:1.2' }, newItem.unit), h('div', { style: 'flex:1' }, newItem.rate)),
      h('div', { style: 'height:8px' }),
      h('button', { class: 'btn block', onclick: () => {
        const name = newItem.name.value.trim(); if (!name) return;
        const items = (sh.items || []).filter((x) => x.name !== name);
        items.push({ name, unit: newItem.unit.value, rate: round2(newItem.rate.value) || 0 });
        db.updateShop(S.code, { items }).catch(fail);
      } }, '➕ Add / update item')),
    h('div', { class: 'card' },
      h('button', { class: 'btn danger block', onclick: (e) => {
        if (!e.target.dataset.sure) { e.target.dataset.sure = 1; e.target.textContent = 'पक्का? इस फ़ोन से दुकान हटेगी (डेटा सुरक्षित रहेगा)'; return; }
        db.removeMember(S.code, db.uid).catch(() => {}).finally(leaveLocal);
      } }, '🚪 इस फ़ोन से बाहर निकलें · Leave shop on this phone'),
      h('p', { class: 'small muted center' }, 'Data stays safe in the cloud.')),
  );
}

boot();
