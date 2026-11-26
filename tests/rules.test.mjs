// Run with: npm run test:rules  (starts the Firestore emulator)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, arrayUnion, collection, getDocs } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-shop',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
});
const as = (uid) => env.authenticatedContext(uid).firestore();
const CODE = 'ABCD2345';
const bill = (uid) => ({ date: '2026-11-26', total: 100, pay: { cash: 100 }, createdBy: uid, lines: [] });

test.beforeEach(async () => {
  await env.clearFirestore();
  await assertSucceeds(setDoc(doc(as('owner'), 'shops', CODE), { name: 'Shop', ownerUid: 'owner', ownerPhone: '9', memberUids: ['owner'], memberNames: { owner: 'O' }, items: [] }));
});
test.after(() => env.cleanup());

const join = (uid) => updateDoc(doc(as(uid), 'shops', CODE), { memberUids: arrayUnion(uid), [`memberNames.${uid}`]: uid });

test('signed-out users see nothing', async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'shops', CODE)));
});

test('shops cannot be listed, only opened by code', async () => {
  await assertFails(getDocs(collection(as('x'), 'shops')));
  await assertSucceeds(getDoc(doc(as('x'), 'shops', CODE)));
});

test('a stranger cannot read bills until joining', async () => {
  await assertSucceeds(setDoc(doc(as('owner'), 'shops', CODE, 'bills', 'b1'), bill('owner')));
  await assertFails(getDoc(doc(as('x'), 'shops', CODE, 'bills', 'b1')));
  await assertSucceeds(join('x'));
  await assertSucceeds(getDoc(doc(as('x'), 'shops', CODE, 'bills', 'b1')));
});

test('max 5 phones', async () => {
  for (const u of ['a', 'b', 'c', 'd']) await assertSucceeds(join(u));
  await assertFails(join('e'));
});

test('a joiner cannot add someone else or change settings', async () => {
  await assertFails(updateDoc(doc(as('x'), 'shops', CODE), { memberUids: arrayUnion('x', 'y') }));
  await assertFails(updateDoc(doc(as('x'), 'shops', CODE), { memberUids: arrayUnion('x'), ownerPhone: '1' }));
});

test('members can remove a lost phone but not take ownership', async () => {
  await assertSucceeds(join('a'));
  await assertSucceeds(join('b'));
  await assertSucceeds(updateDoc(doc(as('a'), 'shops', CODE), { memberUids: ['owner', 'a'] }));
  await assertFails(updateDoc(doc(as('a'), 'shops', CODE), { ownerUid: 'a' }));
});

test('bills cannot be deleted or forged', async () => {
  await assertSucceeds(join('a'));
  await assertFails(setDoc(doc(as('a'), 'shops', CODE, 'bills', 'b2'), bill('owner')));
  await assertSucceeds(setDoc(doc(as('a'), 'shops', CODE, 'bills', 'b2'), bill('a')));
  await assertSucceeds(updateDoc(doc(as('owner'), 'shops', CODE, 'bills', 'b2'), { cancelled: true }));
  await assertFails(deleteDoc(doc(as('owner'), 'shops', CODE, 'bills', 'b2')));
});

test('a removed phone loses access', async () => {
  await assertSucceeds(join('a'));
  await assertSucceeds(updateDoc(doc(as('owner'), 'shops', CODE), { memberUids: ['owner'] }));
  await assertFails(setDoc(doc(as('a'), 'shops', CODE, 'bills', 'b3'), bill('a')));
});
