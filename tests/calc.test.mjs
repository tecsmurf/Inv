import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQty, lineAmount, billTotals, daySummary, udhaarBalances, whatsappText, waNumber, whatsappLink, newShopCode, normalizeCode, toCSV } from '../js/calc.js';

test('parseQty handles numbers, fractions and carpet sizes', () => {
  assert.equal(parseQty('2'), 2);
  assert.equal(parseQty('2.5'), 2.5);
  assert.equal(parseQty('1/2'), 0.5);
  assert.equal(parseQty('4x6'), 24);
  assert.equal(parseQty('4 X 6'), 24);
  assert.equal(parseQty('5*7.5'), 37.5);
  assert.ok(Number.isNaN(parseQty('abc')));
  assert.ok(Number.isNaN(parseQty('')));
});

test('line amount = qty x rate', () => {
  assert.equal(lineAmount({ qty: '3', rate: '250' }), 750);
  assert.equal(lineAmount({ qty: '4x6', rate: '50' }), 1200);
  assert.equal(lineAmount({ qty: '1.25', rate: '480' }), 600);
});

test('bill totals by payment mode', () => {
  const lines = [{ name: 'Kambal', qty: '2', rate: '800' }, { name: 'Pillow', qty: '1', rate: '100' }, { name: '', qty: '', rate: '' }];
  const t = billTotals(lines, 50, 'upi');
  assert.equal(t.subtotal, 1700);
  assert.equal(t.total, 1650);
  assert.deepEqual(t.pay, { upi: 1650, cash: 0, udhaar: 0 });
  const m = billTotals(lines, 0, 'mixed', { upi: '1000', cash: '200' });
  assert.deepEqual(m.pay, { upi: 1000, cash: 200, udhaar: 500 });
  assert.equal(billTotals(lines, 0, 'mixed', { upi: '2000' }).error, 'overpaid');
});

test('day summary splits by mode and adds udhaar repayments to cash in hand', () => {
  const bills = [
    { total: 1000, pay: { upi: 1000 }, lines: [{ name: 'Kambal', unit: 'pc', qty: 1, amount: 1000 }] },
    { total: 500, pay: { cash: 500 }, lines: [{ name: 'Kambal', unit: 'pc', qty: 1, amount: 500 }] },
    { total: 2000, pay: { udhaar: 2000 }, customer: { name: 'Shankar ji' }, lines: [] },
    { total: 9999, pay: { cash: 9999 }, cancelled: true, lines: [] },
  ];
  const s = daySummary(bills, [{ amount: 300, mode: 'cash' }, { amount: 200, mode: 'upi' }]);
  assert.equal(s.billCount, 3);
  assert.equal(s.total, 3500);
  assert.equal(s.upi, 1000);
  assert.equal(s.cash, 500);
  assert.equal(s.udhaar, 2000);
  assert.equal(s.cashInHand, 800);
  assert.equal(s.upiReceived, 1200);
  assert.deepEqual(s.items[0], { name: 'Kambal', unit: 'pc', qty: 2, amount: 1500 });
  const text = whatsappText({ shopName: 'Test', date: '2026-11-26', summary: s, closedBy: 'Raju', time: '8:30 pm' });
  assert.match(text, /Total sale: ₹3,500/);
  assert.match(text, /Shankar ji – ₹2,000/);
});

test('udhaar balances per customer (name is case-insensitive)', () => {
  const b = udhaarBalances(
    [{ date: '2026-11-20', pay: { udhaar: 2000 }, customer: { name: 'Shankar ji', phone: '98' } }, { date: '2026-11-21', pay: { udhaar: 500 }, customer: { name: 'shankar ji ' } }],
    [{ date: '2026-11-25', customerName: 'Shankar Ji', amount: 1000 }]);
  assert.equal(b.length, 1);
  assert.equal(b[0].due, 1500);
  assert.equal(b[0].last, '2026-11-25');
});

test('WhatsApp numbers get the India code', () => {
  assert.equal(waNumber('98765 43210'), '919876543210');
  assert.equal(waNumber('09876543210'), '919876543210');
  assert.equal(waNumber('+91 98765-43210'), '919876543210');
  assert.ok(whatsappLink('9876543210', 'a b').startsWith('https://wa.me/919876543210?text=a%20b'));
});

test('shop codes are 8 chars without confusing letters', () => {
  for (let i = 0; i < 200; i++) assert.match(newShopCode(), /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(normalizeCode(' abcd-2345 '), 'ABCD2345');
});

test('CSV export has one row per item', () => {
  const csv = toCSV([{ date: '2026-11-26', total: 10, pay: { cash: 10 }, lines: [{ name: 'a, b', qty: 1, rate: 10, amount: 10, unit: 'pc' }] }]);
  assert.equal(csv.trim().split('\n').length, 2);
  assert.match(csv, /"a, b"/);
});
