# दुकान का हिसाब · Shop Hisaab

A daily sales book for a small shop that runs on your phone instead of a notebook.

- **One shop, up to 5 phones.** The owner creates the shop and gets an 8-letter code (like `KMBL-7Q4X`). Other phones join with that code.
- **Bills with many items.** Each line has an item, quantity, unit (piece, kg, metre, feet, sq.ft, pair, set), and rate. Line totals and the bill total are worked out for you. For carpets you can type `4x6` as the quantity and it becomes 24 sq.ft.
- **Payment: UPI, Cash, Udhaar, or Mixed.** Udhaar needs the customer's name. The **Udhaar** tab shows who owes how much, records money when it comes back, and can send a reminder on WhatsApp.
- **Live sync.** Every phone sees new bills straight away. Without internet, bills are saved on the phone and sync when the internet comes back. Bills are never deleted, only marked "cancelled", so nothing is lost.
- **Close day → WhatsApp.** After the last customer, press **दिन बंद करें · Close day**. It shows the day's summary (total, UPI, cash, udhaar, cash in hand, items sold) and opens WhatsApp to the owner's number with the message already typed. Press **Send**.
- **History and backup.** You can open any past day, and download a whole month as a CSV file that opens in Excel.
- Labels are in Hindi and English. It works on any Android phone or iPhone browser, and you can "Add to Home screen" so it behaves like an app.

It uses **Firebase** (by Google) for the database. The free "Spark" plan is far more than one shop needs: 50,000 reads and 20,000 writes per day, and 1 GB of storage. Hosting is free too.

---

## Setup (one time, about 15 minutes, on a laptop or phone browser)

### 1. Create a Firebase project
1. Go to <https://console.firebase.google.com> and sign in with your Google account.
2. Click **Create a project**. Name it something like `shop-hisaab`. You can turn off Google Analytics.

### 2. Create the database
1. In the left menu, open **Build → Firestore Database → Create database**.
2. For the location, choose **asia-south1 (Mumbai)**.
3. Choose **Start in production mode**. The rules from this repo get uploaded in step 5.

### 3. Turn on sign-in
1. Open **Build → Authentication → Get started**.
2. On the **Sign-in method** tab, enable **Anonymous**. Each phone signs in silently, so nobody needs a password.

### 4. Get your web config
1. Open **Project settings** (the ⚙️ next to "Project Overview"), go to **Your apps**, and click the **Web** icon `</>`.
2. Register an app (any nickname) and skip "Firebase Hosting setup" for now.
3. Copy the `firebaseConfig` values into [`js/config.js`](js/config.js), replacing the `PASTE_…` text.

These values are not secret. They are meant to sit in the website, and the database rules are what keep the data safe.

### 5. Upload the rules and put the app online (Firebase Hosting)
On a computer with [Node.js](https://nodejs.org) installed:

```bash
git clone https://github.com/tecsmurf/Inv.git && cd Inv
npm install
npx firebase login
npx firebase use --add          # pick your project
npx firebase deploy --only hosting,firestore
```

When it finishes, it prints your app link, like `https://shop-hisaab.web.app`.

> **No computer?** You can host the files on **GitHub Pages** instead: in the repo, go to Settings → Pages → Deploy from branch `main` / root. Your link will be `https://tecsmurf.github.io/Inv/`. You still have to upload the rules: in the Firebase console, open Firestore → **Rules**, paste in the contents of [`firestore.rules`](firestore.rules), and click **Publish**.

### 6. Start using it
1. **Owner's phone:** open the link in Chrome. Under **नई दुकान बनाएं · Create new shop**, type your name, the shop name, and the owner's WhatsApp number, then press Create. You'll see the shop code.
2. In Chrome's menu (⋮), choose **Add to Home screen**.
3. **Other phones (up to 4 more):** in Settings, press **📤 Invite** to send the link and code on WhatsApp. On each phone, open the link, type your name and the code, and press **Join**.
4. **Lost or changed phone:** go to Settings → Phones, remove the old phone, and join the new one with the same code. The data stays safe.

---

## Daily use

1. **➕ नया बिल · New bill:** pick or type the item, then enter quantity, unit, and rate. Use **Add item** for more lines, choose UPI / Cash / Udhaar / Mixed, and press **Save**.
2. Tap a bill to see it, edit it, cancel it, or send a receipt to the customer on WhatsApp (if you entered their number).
3. **Udhaar tab:** tap a customer, then **पैसा मिला** when they pay back. Repayments are counted in that day's cash in hand.
4. **After the last customer:** press **🔒 Close day → WhatsApp**, then Send. If a bill is added after closing, the app tells you to close again.
5. Add your usual items and rates in **Settings → Item list** so they fill in automatically.

## About WhatsApp sending

The app uses a WhatsApp `wa.me` link. This is free and works with normal WhatsApp, but someone has to press **Send** once.

Sending **fully automatically** with no tap needs the **WhatsApp Business Platform (Cloud API)** from Meta. That needs:
- a separate phone number registered to the API,
- a message template approved by Meta,
- a small server (for example, a Firebase Cloud Function, which needs Firebase's pay-as-you-go "Blaze" plan),
- Meta's per-message charge.

That can be added later if the one tap becomes a problem.

## For developers

Plain HTML/CSS/JS with no build step. The Firebase JS SDK loads from the official CDN.

| File | What it does |
|---|---|
| `index.html`, `css/app.css` | Page and styles (mobile first) |
| `js/app.js` | Screens: setup, today, bill form, udhaar, history, settings |
| `js/db.js` | All Firebase calls (anonymous auth, Firestore with offline cache) |
| `js/calc.js` | Pure maths: quantities, totals, day summary, udhaar balances, WhatsApp text, CSV |
| `firestore.rules` | Security: the shop's document id is its join code, there is a 5-phone limit, only members read or write, and bills can't be deleted |
| `sw.js`, `manifest.webmanifest` | Lets the app install and open offline |

Data layout:

```
shops/{CODE}                 name, ownerPhone, ownerUid, memberUids[≤5], memberNames{}, items[]
shops/{CODE}/bills/{id}      date, time, lines[{name,qty,qtyText,unit,rate,amount}], subtotal, discount,
                             total, pay{upi,cash,udhaar}, customer{name,phone}, note, byName, cancelled
shops/{CODE}/udhaarPayments  customerName, amount, mode, date
shops/{CODE}/days/{date}     closed summary sent to WhatsApp
```

Tests:

```bash
npm test             # maths and WhatsApp text
npm run test:rules   # security rules, against the Firestore emulator (needs Java)
npm run serve        # local emulators; open http://127.0.0.1:5000/?emulator
```
