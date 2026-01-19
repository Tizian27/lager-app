"use strict";

/*
  App.js Version: Minimal
  Nur Artikelname + Anzahl
  Offline, IndexedDB, PDF Export (Print), Backup/Restore
*/

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

const id = () => {
  return crypto?.randomUUID ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

/* ---------- IndexedDB ---------- */
const DB_NAME = "lagerbestand_db";
const DB_VER = 1; // Lass das auf 1, damit dein bestehendes DB Layout nicht kaputtgeht
const STORE_ITEMS = "items";

let DB = null;
let cacheItems = [];
let editingItemId = null;

/* ---------- DOM (tolerant) ---------- */
const statusText = $("#statusText");
const itemsTbody = $("#itemsTbody");
const emptyHint = $("#emptyHint");

const searchInput = $("#searchInput");
const btnNewItem = $("#btnNewItem");
const btnExportPdf = $("#btnExportPdf");
const btnBackup = $("#btnBackup");

const itemDialog = $("#itemDialog");
const itemDialogTitle = $("#itemDialogTitle");
const itemForm = $("#itemForm");
const itemName = $("#itemName");
const itemStock = $("#itemStock");

const backupDialog = $("#backupDialog");
const btnDoBackup = $("#btnDoBackup");
const btnDoRestore = $("#btnDoRestore");
const backupFile = $("#backupFile");

const printArea = $("#printArea");

/* ---------- DB functions ---------- */
function openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const s = db.createObjectStore(STORE_ITEMS, { keyPath: "id" });
        s.createIndex("name", "name", { unique: false });
        s.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeNames, mode="readonly"){
  return db.transaction(storeNames, mode);
}

async function dbGetAllItems(db){
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS]);
    const req = t.objectStore(STORE_ITEMS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
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
    const t = tx(db, [STORE_ITEMS], "readwrite");
    const req = t.objectStore(STORE_ITEMS).delete(itemId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function dbAdjustStock(db, itemId, delta){
  const now = Date.now();
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE_ITEMS], "readwrite");
    const store = t.objectStore(STORE_ITEMS);

    const getReq = store.get(itemId);
    getReq.onsuccess = () => {
      const it = getReq.result;
      if (!it) { reject(new Error("Artikel nicht gefunden")); return; }

      const cur = Number(it.stock) || 0;
      const d = Number(delta) || 0;
      it.stock = cur + d;
      it.updatedAt = now;

      store.put(it);
    };

    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

async function dbExportAll(db){
  const items = await dbGetAllItems(db);
  return {
    version: 1,
    exportedAt: Date.now(),
    items: items.map((it) => ({
      id: it.id,
      name: it.name ?? "",
      stock: Number(it.stock) || 0,
      createdAt: it.createdAt ?? null,
      updatedAt: it.updatedAt ?? null
    }))
  };
}

async function dbReplaceAll(db, payload){
  const items = Array.isArray(payload?.items) ? payload.items : [];

  return new Promise((resolve, reject) => {
    const t = tx(DB, [STORE_ITEMS], "readwrite");
    const s = t.objectStore(STORE_ITEMS);

    s.clear();
    for (const it of items) {
      const now = Date.now();
      s.put({
        id: it.id || id(),
        name: String(it.name || "").trim(),
        stock: Number(it.stock) || 0,
        createdAt: it.createdAt ?? now,
        updatedAt: it.updatedAt ?? now
      });
    }

    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

/* ---------- UI ---------- */
function filteredItems(){
  const q = (searchInput?.value || "").trim().toLowerCase();
  if (!q) return cacheItems.slice();
  return cacheItems.filter((it) => String(it.name || "").toLowerCase().includes(q));
}

function renderItems(){
  if (!itemsTbody) return;

  const items = filteredItems().sort((a,b) => (a.name || "").localeCompare(b.name || ""));
  itemsTbody.innerHTML = "";

  if (emptyHint) emptyHint.hidden = cacheItems.length !== 0;

  for (const it of items){
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.innerHTML = `<strong>${escapeHtml(it.name)}</strong>`;
    tr.appendChild(tdName);

    const tdStock = document.createElement("td");
    tdStock.className = "right stockBig";
    tdStock.textContent = String(Number(it.stock) || 0);
    tr.appendChild(tdStock);

    const tdAct = document.createElement("td");
    tdAct.className = "right";
    tdAct.innerHTML = `
      <div class="actions">
        <button class="btn btnSmall btnPrimary" data-act="plus" data-id="${it.id}">+</button>
        <button class="btn btnSmall btnSecondary" data-act="minus" data-id="${it.id}">-</button>
        <button class="btn btnSmall" data-act="edit" data-id="${it.id}">Bearbeiten</button>
        <button class="btn btnSmall btnDanger" data-act="del" data-id="${it.id}">Löschen</button>
      </div>
    `;
    tr.appendChild(tdAct);

    itemsTbody.appendChild(tr);
  }
}

async function refresh(){
  cacheItems = await dbGetAllItems(DB);

  // Falls alte Items noch sku, category etc haben: egal, wir nutzen nur name/stock
  cacheItems = cacheItems.map((it) => ({
    ...it,
    name: String(it.name || "").trim(),
    stock: Number(it.stock) || 0
  }));

  renderItems();
}

/* ---------- Dialog: Artikel anlegen/bearbeiten ---------- */
function openNewItem(){
  editingItemId = null;
  if (itemDialogTitle) itemDialogTitle.textContent = "Neuer Artikel";
  if (itemName) itemName.value = "";
  if (itemStock) itemStock.value = "0";
  itemDialog?.showModal();
  itemName?.focus();
}

async function openEditItem(itemId){
  const it = await dbGetItem(DB, itemId);
  if (!it) return;

  editingItemId = itemId;
  if (itemDialogTitle) itemDialogTitle.textContent = "Artikel bearbeiten";
  if (itemName) itemName.value = it.name || "";
  if (itemStock) itemStock.value = String(Number(it.stock) || 0);

  itemDialog?.showModal();
  itemName?.focus();
}

async function saveItemFromForm(){
  const name = String(itemName?.value || "").trim();
  if (!name) return;

  const stock = Number(itemStock?.value || 0);
  const now = Date.now();

  if (!editingItemId){
    const newItem = {
      id: id(),
      name,
      stock: Number.isFinite(stock) ? stock : 0,
      createdAt: now,
      updatedAt: now
    };
    await dbPutItem(DB, newItem);
  } else {
    const existing = await dbGetItem(DB, editingItemId);
    if (!existing) return;

    existing.name = name;
    existing.stock = Number.isFinite(stock) ? stock : (Number(existing.stock) || 0);
    existing.updatedAt = now;

    await dbPutItem(DB, existing);
  }

  await refresh();
}

/* ---------- Actions ---------- */
async function deleteItem(itemId){
  const it = await dbGetItem(DB, itemId);
  if (!it) return;

  const ok = confirm(`Wirklich löschen?\n\n${it.name}`);
  if (!ok) return;

  await dbDeleteItem(DB, itemId);
  await refresh();
}

async function adjust(itemId, delta){
  await dbAdjustStock(DB, itemId, delta);
  await refresh();
}

/* ---------- PDF Export ---------- */
function exportPdf(){
  const items = filteredItems().sort((a,b) => (a.name || "").localeCompare(b.name || ""));
  const now = new Date();
  const dateStr = fmtDateTime(now);

  const rows = items.map((it) => `
    <tr>
      <td>${escapeHtml(it.name)}</td>
      <td class="right">${escapeHtml(String(Number(it.stock) || 0))}</td>
    </tr>
  `).join("");

  if (printArea) {
    printArea.innerHTML = `
      <h1>Lagerbestand</h1>
      <div class="meta">Export: ${escapeHtml(dateStr)} | Artikel: ${items.length}</div>
      <table>
        <thead>
          <tr>
            <th>Artikel</th>
            <th class="right">Anzahl</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  window.print();
}

/* ---------- Backup / Restore ---------- */
async function doBackup(){
  const payload = await dbExportAll(DB);
  const stamp = new Date(payload.exportedAt);
  const file = `lagerbestand_backup_${stamp.getFullYear()}-${String(stamp.getMonth()+1).padStart(2,"0")}-${String(stamp.getDate()).padStart(2,"0")}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(file, blob);
}

async function doRestore(){
  const file = backupFile?.files?.[0];
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

  const ok = confirm("Achtung: Import ersetzt alles. Fortfahren?");
  if (!ok) return;

  await dbReplaceAll(DB, payload);

  if (backupFile) backupFile.value = "";
  await refresh();
}

/* ---------- PWA ---------- */
async function registerSW(){
  if (!("serviceWorker" in navigator)) return;
  try{
    await navigator.serviceWorker.register("./service-worker.js");
    if (statusText) statusText.textContent = "Offline App aktiv";
  } catch {
    if (statusText) statusText.textContent = "Offline Modus teilweise";
  }
}

/* ---------- Events ---------- */
if (itemsTbody){
  itemsTbody.addEventListener("click", async (e) => {
    const btn = e.target?.closest("button");
    if (!btn) return;

    const act = btn.getAttribute("data-act");
    const itemId = btn.getAttribute("data-id");
    if (!act || !itemId) return;

    if (act === "plus") await adjust(itemId, +1);
    if (act === "minus") await adjust(itemId, -1);
    if (act === "edit") await openEditItem(itemId);
    if (act === "del") await deleteItem(itemId);
  });
}

if (searchInput){
  searchInput.addEventListener("input", () => renderItems());
}

btnNewItem?.addEventListener("click", () => openNewItem());
btnExportPdf?.addEventListener("click", () => exportPdf());
btnBackup?.addEventListener("click", () => backupDialog?.showModal());

if (itemForm){
  itemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveItemFromForm();
    itemDialog?.close();
  });
}

btnDoBackup?.addEventListener("click", async (e) => {
  e.preventDefault();
  await doBackup();
});

btnDoRestore?.addEventListener("click", async (e) => {
  e.preventDefault();
  await doRestore();
});

/* ---------- Init ---------- */
(async function init(){
  if (statusText) statusText.textContent = "Startet...";
  DB = await openDb();
  await refresh();
  await registerSW();
  if (statusText) statusText.textContent = "Bereit";
})();
