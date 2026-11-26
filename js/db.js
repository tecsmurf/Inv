// All Firebase access lives here.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, collection, getDoc, setDoc, updateDoc, addDoc, onSnapshot, query, where, getDocs,
  serverTimestamp, arrayUnion, arrayRemove, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './config.js';

export const configured = !String(firebaseConfig.projectId || '').startsWith('PASTE');

let app, auth, db;
export let uid = null;

export function init() {
  const params = new URLSearchParams(location.search);
  const emulator = params.has('emulator') && ['localhost', '127.0.0.1'].includes(location.hostname);
  const cfg = emulator && !configured ? { apiKey: 'demo-key', projectId: 'demo-shop', appId: 'demo' } : firebaseConfig;
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  if (emulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, (u) => {
      if (u) { uid = u.uid; stop(); resolve(u.uid); }
    });
    if (!auth.currentUser) signInAnonymously(auth).catch(reject);
  });
}

const shopRef = (code) => doc(db, 'shops', code);
const sub = (code, name) => collection(db, 'shops', code, name);

export async function createShop({ code, shopName, ownerPhone, myName }) {
  await setDoc(shopRef(code), {
    name: shopName,
    ownerUid: uid,
    ownerPhone,
    memberUids: [uid],
    memberNames: { [uid]: myName },
    items: [],
    createdAt: serverTimestamp(),
  });
}

/** Returns 'ok' | 'notfound' | 'full'. */
export async function joinShop(code, myName) {
  const snap = await getDoc(shopRef(code));
  if (!snap.exists()) return 'notfound';
  const s = snap.data();
  if (s.memberUids.includes(uid)) {
    await updateDoc(shopRef(code), { [`memberNames.${uid}`]: myName });
    return 'ok';
  }
  if (s.memberUids.length >= 5) return 'full';
  await updateDoc(shopRef(code), { memberUids: arrayUnion(uid), [`memberNames.${uid}`]: myName });
  return 'ok';
}

export const watchShop = (code, cb, err) =>
  onSnapshot(shopRef(code), { includeMetadataChanges: true }, (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null, s.metadata), err);

export const updateShop = (code, data) => updateDoc(shopRef(code), data);

export const removeMember = (code, memberUid) =>
  updateDoc(shopRef(code), { memberUids: arrayRemove(memberUid), [`memberNames.${memberUid}`]: deleteField() });

const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));

export const watchDay = (code, date, cb, err) => {
  const u1 = onSnapshot(query(sub(code, 'bills'), where('date', '==', date)), { includeMetadataChanges: true },
    (s) => cb('bills', rows(s), s.metadata), err);
  const u2 = onSnapshot(query(sub(code, 'udhaarPayments'), where('date', '==', date)), (s) => cb('payments', rows(s)), err);
  const u3 = onSnapshot(doc(db, 'shops', code, 'days', date), (s) => cb('day', s.exists() ? s.data() : null), err);
  return () => { u1(); u2(); u3(); };
};

export const watchUdhaar = (code, cb, err) => {
  const u1 = onSnapshot(query(sub(code, 'bills'), where('pay.udhaar', '>', 0)), (s) => cb('bills', rows(s)), err);
  const u2 = onSnapshot(sub(code, 'udhaarPayments'), (s) => cb('payments', rows(s)), err);
  return () => { u1(); u2(); };
};

export const watchDays = (code, cb, err) => onSnapshot(sub(code, 'days'), (s) => cb(rows(s)), err);

export async function billsBetween(code, from, to) {
  const s = await getDocs(query(sub(code, 'bills'), where('date', '>=', from), where('date', '<=', to)));
  return rows(s);
}

// Writes are not awaited by the UI: Firestore keeps them on the phone and
// sends them when internet comes back.
export function saveBill(code, bill, id) {
  if (id) {
    return { id, done: updateDoc(doc(db, 'shops', code, 'bills', id), { ...bill, editedBy: uid, editedAt: serverTimestamp() }) };
  }
  const ref = doc(sub(code, 'bills'));
  return { id: ref.id, done: setDoc(ref, { ...bill, createdBy: uid, createdAt: serverTimestamp() }) };
}

export const cancelBill = (code, id, cancelled = true) =>
  updateDoc(doc(db, 'shops', code, 'bills', id), { cancelled, editedBy: uid, editedAt: serverTimestamp() });

export const addUdhaarPayment = (code, p) =>
  addDoc(sub(code, 'udhaarPayments'), { ...p, createdBy: uid, createdAt: serverTimestamp() });

export const cancelUdhaarPayment = (code, id) =>
  updateDoc(doc(db, 'shops', code, 'udhaarPayments', id), { cancelled: true, editedBy: uid });

export const closeDay = (code, date, data) =>
  setDoc(doc(db, 'shops', code, 'days', date), { ...data, closed: true, closedBy: uid, closedAt: serverTimestamp() });
