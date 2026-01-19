"use strict";

/* ---------- Helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const fmtDateTime = (d) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
const downloadBlob = (filename, blob) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
};

/* ---------- IndexedDB ---------- */
const DB_NAME = "lagerbestand_db";
const DB_VER = 1;
const STORE_ITEMS = "items";
const STORE_TX = "tx";

function openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const s = db.createObjectStore(STORE_ITEMS, { keyPath: "id" });
        s.createIndex("name", "name", { unique: false });
        s.createIndex("sku", "sku", { unique: false });
        s.createIndex("category", "category", { unique: false });
        s.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_TX)) {
        const s = db.createObjectStore(STORE_TX, { keyPath: "id" });
        s.createIndex("at", "at", { unique: false });
        s.createIndex("itemId", "itemId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeNames, mode="readonly"){
  return db.transaction(storeNames, mode);
}

function id(){
  return crypto?.randomUUID ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function dbGetAllItems(db){
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS]);
    const req = t.objectStore(STORE_ITEMS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAllTx(db, limit=30){
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_TX]);
    const store = t.objectStore(STORE_TX);
    const idx = store.index("at");

    const out = [];
    const req = idx.openCursor(null, "prev");
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbPutItem(db, item){
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS], "readwrite");
    const req = t.objectStore(STORE_ITEMS).put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteItem(db, itemId){
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS, STORE_TX], "readwrite");
    t.objectStore(STORE_ITEMS).delete(itemId);

    // dazu passende Buchungen entfernen
    const txStore = t.objectStore(STORE_TX);
    const idx = txStore.index("itemId");
    const req = idx.openCursor(IDBKeyRange.only(itemId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      txStore.delete(cur.primaryKey);
      cur.continue();
    };
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

async function dbGetItem(db, itemId){
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS]);
    const req = t.objectStore(STORE_ITEMS).get(itemId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbAddTxAndAdjustStock(db, itemId, delta, reason, note){
  const now = Date.now();
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS, STORE_TX], "readwrite");
    const items = t.objectStore(STORE_ITEMS);
    const txs = t.objectStore(STORE_TX);

    const getReq = items.get(itemId);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (!item) { reject(new Error("Artikel nicht gefunden")); return; }

      const newStock = (Number(item.stock) || 0) + Number(delta);
      item.stock = Number.isFinite(newStock) ? newStock : (Number(item.stock) || 0);
      item.updatedAt = now;

      items.put(item);

      const booking = {
        id: id(),
        itemId,
        itemNameSnapshot: item.name,
        delta: Number(delta),
        reason: String(reason || ""),
        note: String(note || ""),
        at: now
      };
      txs.put(booking);
    };

    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

async function dbExportAll(db){
  const [items, txs] = await Promise.all([
    new Promise((resolve, reject) => {
      const t = tx(db, [STORE_ITEMS]);
      const req = t.objectStore(STORE_ITEMS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }),
    new Promise((resolve, reject) => {
      const t = tx(db, [STORE_TX]);
      const req = t.objectStore(STORE_TX).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    })
  ]);

  return {
    version: 1,
    exportedAt: Date.now(),
    items,
    txs
  };
}

async function dbReplaceAll(db, payload){
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const txs = Array.isArray(payload?.txs) ? payload.txs : [];

  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS, STORE_TX], "readwrite");
    const sItems = t.objectStore(STORE_ITEMS);
    const sTx = t.objectStore(STORE_TX);

    sItems.clear();
    sTx.clear();

    for (const it of items) sItems.put(it);
    for (const x of txs) sTx.put(x);

    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

/* ---------- UI State ---------- */
let DB = null;
let cacheItems = [];
let cacheTx = [];
let editingItemId = null;
let adjustingItemId = null;

/* ---------- DOM ---------- */
const statusText = $("#statusText");
const itemsTbody = $("#itemsTbody");
const txTbody = $("#txTbody");
const emptyHint = $("#emptyHint");
const txEmptyHint = $("#txEmptyHint");

const searchInput = $("#searchInput");
const btnNewItem = $("#btnNewItem");
const btnExportPdf = $("#btnExportPdf");
const btnBackup = $("#btnBackup");

const itemDialog = $("#itemDialog");
const itemDialogTitle = $("#itemDialogTitle");
const itemForm = $("#itemForm");
const itemName = $("#itemName");
const itemSku = $("#itemSku");
const itemCategory = $("#itemCategory");
const itemUnit = $("#itemUnit");
const itemStock = $("#itemStock");

const adjustDialog = $("#adjustDialog");
const adjustTitle = $("#adjustTitle");
const adjustForm = $("#adjustForm");
const adjustDelta = $("#adjustDelta");
const adjustReason = $("#adjustReason");
const adjustNote = $("#adjustNote");

const backupDialog = $("#backupDialog");
const btnDoBackup = $("#btnDoBackup");
const btnDoRestore = $("#btnDoRestore");
const backupFile = $("#backupFile");

const printArea = $("#printArea");

/* ---------- Rendering ---------- */
function filteredItems(){
  const q = (searchInput.value || "").trim().toLowerCase();
  if (!q) return cacheItems.slice();

  return cacheItems.filter((it) => {
    const hay = `${it.name} ${it.sku || ""} ${it.category || ""}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderItems(){
  const items = filteredItems().sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  itemsTbody.innerHTML = "";

  emptyHint.hidden = cacheItems.length !== 0;

  for (const it of items){
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.innerHTML = `<div><strong>${escapeHtml(it.name)}</strong></div>
      <div class="muted">${escapeHtml(it.unit ? `Einheit: ${it.unit}` : "")}</div>`;
    tr.appendChild(tdName);

    const tdSku = document.createElement("td");
    tdSku.textContent = it.sku || "";
    tr.appendChild(tdSku);

    const tdCat = document.createElement("td");
    tdCat.textContent = it.category || "";
    tr.appendChild(tdCat);

    const tdStock = document.createElement("td");
    tdStock.className = "right";
    tdStock.textContent = String(it.stock ?? 0);
    tr.appendChild(tdStock);

    const tdAct = document.createElement("td");
    tdAct.className = "right";
    tdAct.innerHTML = `
      <div class="actions">
        <button class="btn btnSmall btnPrimary" data-act="adjust" data-id="${it.id}">Buchen</button>
        <button class="btn btnSmall" data-act="edit" data-id="${it.id}">Bearbeiten</button>
        <button class="btn btnSmall btnDanger" data-act="del" data-id="${it.id}">Löschen</button>
      </div>
    `;
    tr.appendChild(tdAct);

    itemsTbody.appendChild(tr);
  }
}

function renderTx(){
  txTbody.innerHTML = "";
  txEmptyHint.hidden = cacheTx.length !== 0;

  for (const x of cacheTx){
    const tr = document.createElement("tr");
    const d = new Date(x.at);

    const tdTime = document.createElement("td");
    tdTime.textContent = fmtDateTime(d);
    tr.appendChild(tdTime);

    const tdItem = document.createElement("td");
    tdItem.textContent = x.itemNameSnapshot || "";
    tr.appendChild(tdItem);

    const tdDelta = document.createElement("td");
    tdDelta.className = "right";
    const val = Number(x.delta) || 0;
    tdDelta.textContent = val > 0 ? `+${val}` : `${val}`;
    tr.appendChild(tdDelta);

    const tdReason = document.createElement("td");
    tdReason.textContent = x.reason || "";
    tr.appendChild(tdReason);

    const tdNote = document.createElement("td");
    tdNote.textContent = x.note || "";
    tr.appendChild(tdNote);

    txTbody.appendChild(tr);
  }
}

/* ---------- Data refresh ---------- */
async function refresh(){
  cacheItems = await dbGetAllItems(DB);
  cacheTx = await dbGetAllTx(DB, 30);
  renderItems();
  renderTx();
}

/* ---------- Dialogs ---------- */
function openNewItem(){
  editingItemId = null;
  itemDialogTitle.textContent = "Neuer Artikel";
  itemName.value = "";
  itemSku.value = "";
  itemCategory.value = "";
  itemUnit.value = "";
  itemStock.value = "0";
  itemDialog.showModal();
  itemName.focus();
}

async function openEditItem(itemId){
  const it = await dbGetItem(DB, itemId);
  if (!it) return;

  editingItemId = itemId;
  itemDialogTitle.textContent = "Artikel bearbeiten";
  itemName.value = it.name || "";
  itemSku.value = it.sku || "";
  itemCategory.value = it.category || "";
  itemUnit.value = it.unit || "";
  itemStock.value = String(it.stock ?? 0);
  itemDialog.showModal();
  itemName.focus();
}

async function saveItemFromForm(){
  const name = itemName.value.trim();
  if (!name) return;

  const sku = itemSku.value.trim();
  const category = itemCategory.value.trim();
  const unit = itemUnit.value.trim();
  const stock = Number(itemStock.value || 0);

  const now = Date.now();

  if (!editingItemId){
    const newItem = {
      id: id(),
      name,
      sku,
      category,
      unit,
      stock: Number.isFinite(stock) ? stock : 0,
      createdAt: now,
      updatedAt: now
    };
    await dbPutItem(DB, newItem);
  } else {
    const existing = await dbGetItem(DB, editingItemId);
    if (!existing) return;

    existing.name = name;
    existing.sku = sku;
    existing.category = category;
    existing.unit = unit;
    existing.stock = Number.isFinite(stock) ? stock : (existing.stock || 0);
    existing.updatedAt = now;

    await dbPutItem(DB, existing);
  }

  await refresh();
}

async function openAdjust(itemId){
  const it = await dbGetItem(DB, itemId);
  if (!it) return;

  adjustingItemId = itemId;
  adjustTitle.textContent = `Bestand ändern: ${it.name}`;
  adjustDelta.value = "";
  adjustReason.value = "";
  adjustNote.value = "";
  adjustDialog.showModal();
  adjustDelta.focus();
}

async function applyAdjustFromForm(){
  if (!adjustingItemId) return;

  const delta = Number(adjustDelta.value);
  if (!Number.isFinite(delta) || delta === 0) return;

  const reason = adjustReason.value.trim();
  const note = adjustNote.value.trim();

  await dbAddTxAndAdjustStock(DB, adjustingItemId, delta, reason, note);
  adjustingItemId = null;
  await refresh();
}

async function deleteItem(itemId){
  const it = await dbGetItem(DB, itemId);
  if (!it) return;

  const ok = confirm(`Wirklich löschen?\n\n${it.name}`);
  if (!ok) return;

  await dbDeleteItem(DB, itemId);
  await refresh();
}

/* ---------- PDF Export (Print) ---------- */
function exportPdf(){
  const items = filteredItems().sort((a,b) => (a.name || "").localeCompare(b.name || ""));

  const now = new Date();
  const dateStr = fmtDateTime(now);

  const rows = items.map((it) => `
    <tr>
      <td>${escapeHtml(it.name)}</td>
      <td>${escapeHtml(it.sku || "")}</td>
      <td>${escapeHtml(it.category || "")}</td>
      <td class="right">${escapeHtml(String(it.stock ?? 0))}</td>
      <td>${escapeHtml(it.unit || "")}</td>
    </tr>
  `).join("");

  printArea.innerHTML = `
    <h1>Lagerbestand</h1>
    <div class="meta">Export: ${escapeHtml(dateStr)} | Artikel: ${items.length}</div>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>SKU</th>
          <th>Kategorie</th>
          <th class="right">Bestand</th>
          <th>Einheit</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  window.print();
}

/* ---------- Backup and Restore ---------- */
async function doBackup(){
  const payload = await dbExportAll(DB);
  const stamp = new Date(payload.exportedAt);
  const file = `lagerbestand_backup_${stamp.getFullYear()}-${String(stamp.getMonth()+1).padStart(2,"0")}-${String(stamp.getDate()).padStart(2,"0")}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(file, blob);
}

async function doRestore(){
  const file = backupFile.files?.[0];
  if (!file) {
    alert("Bitte zuerst eine JSON Datei auswählen.");
    return;
  }

  const text = await file.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    alert("Die Datei ist keine gültige JSON Datei.");
    return;
  }

  const ok = confirm("Achtung: Import ersetzt den kompletten aktuellen Bestand. Fortfahren?");
  if (!ok) return;

  await dbReplaceAll(DB, payload);
  backupFile.value = "";
  await refresh();
}

/* ---------- Events ---------- */
itemsTbody.addEventListener("click", async (e) => {
  const btn = e.target?.closest("button");
  if (!btn) return;
  const act = btn.getAttribute("data-act");
  const idv = btn.getAttribute("data-id");
  if (!act || !idv) return;

  if (act === "adjust") await openAdjust(idv);
  if (act === "edit") await openEditItem(idv);
  if (act === "del") await deleteItem(idv);
});

searchInput.addEventListener("input", () => renderItems());
btnNewItem.addEventListener("click", () => openNewItem());
btnExportPdf.addEventListener("click", () => exportPdf());
btnBackup.addEventListener("click", () => backupDialog.showModal());

itemForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveItemFromForm();
  itemDialog.close();
});

adjustForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await applyAdjustFromForm();
  adjustDialog.close();
});

btnDoBackup.addEventListener("click", async (e) => {
  e.preventDefault();
  await doBackup();
});

btnDoRestore.addEventListener("click", async (e) => {
  e.preventDefault();
  await doRestore();
});

/* ---------- PWA setup ---------- */
async function registerSW(){
  if (!("serviceWorker" in navigator)) return;
  try{
    await navigator.serviceWorker.register("./service-worker.js");
    statusText.textContent = "Offline App aktiv";
  } catch {
    statusText.textContent = "Offline Modus teilweise";
  }
}

/* ---------- Init ---------- */
(async function init(){
  statusText.textContent = "Startet...";
  DB = await openDb();
  await refresh();
  await registerSW();
  statusText.textContent = "Bereit";
})();
