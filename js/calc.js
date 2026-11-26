// Pure helpers: no Firebase, no DOM. Tested in tests/calc.test.mjs.

export const UNITS = [
  { id: 'pc', hi: 'पीस', en: 'piece' },
  { id: 'kg', hi: 'किलो', en: 'kg' },
  { id: 'm', hi: 'मीटर', en: 'metre' },
  { id: 'ft', hi: 'फ़ीट', en: 'feet' },
  { id: 'sqft', hi: 'वर्ग फ़ीट', en: 'sq.ft' },
  { id: 'pair', hi: 'जोड़ी', en: 'pair' },
  { id: 'set', hi: 'सेट', en: 'set' },
];

export const DEFAULT_ITEMS = [
  { name: 'कंबल Kambal', unit: 'pc' },
  { name: 'चादर Chadar', unit: 'pc' },
  { name: 'गलीचा Galicha', unit: 'sqft' },
  { name: 'दरी Darri', unit: 'sqft' },
  { name: 'तकिया Pillow', unit: 'pc' },
  { name: 'पर्दा Parda', unit: 'pc' },
  { name: 'रजाई Razai', unit: 'pc' },
  { name: 'रजाई कवर Razai cover', unit: 'pc' },
  { name: 'शॉल Shawl', unit: 'pc' },
  { name: 'दोहर Dohar', unit: 'pc' },
  { name: 'कपड़ा Kapda', unit: 'm' },
  { name: 'ऊन Oon', unit: 'kg' },
];

export const MODES = ['upi', 'cash', 'udhaar'];

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Parse a quantity typed by the shopkeeper.
 * Accepts "2", "2.5", "1/2", and sizes like "4x6" or "4*6" (=24, for sq.ft carpets).
 * Returns NaN for anything else.
 */
export function parseQty(input) {
  if (typeof input === 'number') return input;
  const s = String(input ?? '').trim().toLowerCase().replace(/×/g, 'x').replace(/\s+/g, '');
  if (s === '') return NaN;
  const size = s.match(/^(\d+(?:\.\d+)?)[x*](\d+(?:\.\d+)?)$/);
  if (size) return round2(parseFloat(size[1]) * parseFloat(size[2]));
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac && Number(frac[2]) !== 0) return round2(Number(frac[1]) / Number(frac[2]));
  if (/^\d*\.?\d+$/.test(s)) return parseFloat(s);
  return NaN;
}

export function lineAmount(line) {
  const q = parseQty(line.qty);
  const r = Number(line.rate);
  if (!isFinite(q) || !isFinite(r)) return 0;
  return round2(q * r);
}

/** Clean up lines from the form into what we store. Empty lines are dropped. */
export function normalizeLines(lines) {
  return (lines || [])
    .map((l) => {
      const qtyText = String(l.qty ?? '').trim() || '1';
      const qty = parseQty(qtyText);
      const rate = Number(l.rate);
      return {
        name: String(l.name || '').trim(),
        qtyText,
        qty: isFinite(qty) ? qty : 0,
        unit: l.unit || 'pc',
        rate: isFinite(rate) ? rate : 0,
        amount: lineAmount({ qty: qtyText, rate }),
      };
    })
    .filter((l) => l.amount > 0 || l.name);
}

/**
 * Work out totals and how the bill was paid.
 * mode: 'upi' | 'cash' | 'udhaar' | 'mixed'.
 * For 'mixed', split = { upi, cash } and the rest becomes udhaar.
 */
export function billTotals(lines, discount = 0, mode = 'cash', split = {}) {
  const subtotal = round2(normalizeLines(lines).reduce((s, l) => s + l.amount, 0));
  const disc = Math.max(0, round2(discount));
  const total = Math.max(0, round2(subtotal - disc));
  const pay = { upi: 0, cash: 0, udhaar: 0 };
  if (mode === 'mixed') {
    pay.upi = Math.max(0, round2(split.upi));
    pay.cash = Math.max(0, round2(split.cash));
    pay.udhaar = Math.max(0, round2(total - pay.upi - pay.cash));
  } else if (MODES.includes(mode)) {
    pay[mode] = total;
  }
  const paidOver = round2(pay.upi + pay.cash + pay.udhaar - total);
  return { subtotal, discount: disc, total, pay, error: paidOver > 0 ? 'overpaid' : null };
}

/** Summary of one day. bills/payments are plain objects as stored. */
export function daySummary(bills, udhaarPayments = []) {
  const live = bills.filter((b) => !b.cancelled);
  const s = {
    billCount: live.length,
    total: 0,
    upi: 0,
    cash: 0,
    udhaar: 0,
    discount: 0,
    recvUpi: 0,
    recvCash: 0,
    udhaarList: [],
    items: [],
  };
  const items = new Map();
  for (const b of live) {
    s.total += b.total || 0;
    s.upi += b.pay?.upi || 0;
    s.cash += b.pay?.cash || 0;
    s.udhaar += b.pay?.udhaar || 0;
    s.discount += b.discount || 0;
    if ((b.pay?.udhaar || 0) > 0) s.udhaarList.push({ name: b.customer?.name || '?', amount: b.pay.udhaar });
    for (const l of b.lines || []) {
      const key = (l.name || '—') + '|' + l.unit;
      const it = items.get(key) || { name: l.name || '—', unit: l.unit, qty: 0, amount: 0 };
      it.qty += l.qty || 0;
      it.amount += l.amount || 0;
      items.set(key, it);
    }
  }
  for (const p of udhaarPayments) {
    if (p.cancelled) continue;
    if (p.mode === 'upi') s.recvUpi += p.amount || 0;
    else s.recvCash += p.amount || 0;
  }
  for (const k of ['total', 'upi', 'cash', 'udhaar', 'discount', 'recvUpi', 'recvCash']) s[k] = round2(s[k]);
  s.items = [...items.values()]
    .map((i) => ({ ...i, qty: round2(i.qty), amount: round2(i.amount) }))
    .sort((a, b) => b.amount - a.amount);
  s.cashInHand = round2(s.cash + s.recvCash);
  s.upiReceived = round2(s.upi + s.recvUpi);
  return s;
}

/** Outstanding udhaar per customer, from all udhaar bills and repayments. */
export function udhaarBalances(bills, payments) {
  const map = new Map();
  const keyOf = (name) => String(name || '').trim().toLowerCase();
  const get = (name, phone) => {
    const k = keyOf(name);
    if (!map.has(k)) map.set(k, { key: k, name: String(name || '').trim(), phone: phone || '', given: 0, received: 0, last: '' });
    const c = map.get(k);
    if (phone && !c.phone) c.phone = phone;
    return c;
  };
  for (const b of bills) {
    if (b.cancelled || !(b.pay?.udhaar > 0)) continue;
    const c = get(b.customer?.name, b.customer?.phone);
    c.given += b.pay.udhaar;
    if (b.date > c.last) c.last = b.date;
  }
  for (const p of payments) {
    if (p.cancelled) continue;
    const c = get(p.customerName, p.phone);
    c.received += p.amount || 0;
    if (p.date > c.last) c.last = p.date;
  }
  return [...map.values()]
    .map((c) => ({ ...c, given: round2(c.given), received: round2(c.received), due: round2(c.given - c.received) }))
    .sort((a, b) => b.due - a.due);
}

export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function prettyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export const rupees = (n) => '₹' + round2(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export const unitLabel = (id) => UNITS.find((u) => u.id === id)?.en || id;

/** The daily message for WhatsApp. Plain text with WhatsApp *bold*. */
export function whatsappText({ shopName, date, summary: s, closedBy, time }) {
  const L = [];
  L.push(`🧾 *${shopName}* – आज का हिसाब / Daily sales`);
  L.push(`📅 ${prettyDate(date)}`);
  L.push(`Bills: ${s.billCount}`);
  L.push('');
  L.push(`💰 *कुल बिक्री Total sale: ${rupees(s.total)}*`);
  L.push(`📱 UPI: ${rupees(s.upi)}`);
  L.push(`💵 नकद Cash: ${rupees(s.cash)}`);
  L.push(`📒 उधार Udhaar: ${rupees(s.udhaar)}`);
  if (s.discount > 0) L.push(`🏷️ छूट Discount: ${rupees(s.discount)}`);
  if (s.recvUpi + s.recvCash > 0) {
    L.push('');
    L.push(`↩️ उधार वापस मिला Udhaar received: ${rupees(s.recvUpi + s.recvCash)} (Cash ${rupees(s.recvCash)}, UPI ${rupees(s.recvUpi)})`);
  }
  L.push('');
  L.push(`💵 *गल्ले में नकद Cash in hand: ${rupees(s.cashInHand)}*`);
  L.push(`📱 *कुल UPI आया: ${rupees(s.upiReceived)}*`);
  if (s.udhaarList.length) {
    L.push('');
    L.push('📒 आज का उधार:');
    for (const u of s.udhaarList) L.push(`  • ${u.name} – ${rupees(u.amount)}`);
  }
  if (s.items.length) {
    L.push('');
    L.push('📦 सामान Items:');
    for (const i of s.items.slice(0, 12)) L.push(`  • ${i.name}: ${i.qty} ${unitLabel(i.unit)} – ${rupees(i.amount)}`);
  }
  if (closedBy) {
    L.push('');
    L.push(`✅ Closed by ${closedBy}${time ? ' at ' + time : ''}`);
  }
  return L.join('\n');
}

/** Indian mobile -> digits for wa.me (adds 91 for 10-digit numbers). */
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d;
}

export function whatsappLink(phone, text) {
  const n = waNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export function newShopCode(rand = Math.random) {
  let c = '';
  for (let i = 0; i < 8; i++) c += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return c;
}
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const prettyCode = (c) => (c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c);

export function toCSV(bills) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [['date', 'time', 'bill_id', 'item', 'qty', 'unit', 'rate', 'amount', 'bill_total', 'discount', 'upi', 'cash', 'udhaar', 'customer', 'phone', 'by', 'note', 'cancelled']];
  for (const b of bills) {
    const lines = b.lines?.length ? b.lines : [{}];
    for (const l of lines) {
      rows.push([b.date, b.time || '', b.id || '', l.name || '', l.qtyText ?? l.qty ?? '', l.unit || '', l.rate ?? '', l.amount ?? '', b.total, b.discount || 0, b.pay?.upi || 0, b.pay?.cash || 0, b.pay?.udhaar || 0, b.customer?.name || '', b.customer?.phone || '', b.byName || '', b.note || '', b.cancelled ? 'yes' : '']);
    }
  }
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\n');
}
