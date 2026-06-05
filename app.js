const app = document.getElementById("app");
const modalOverlay = document.getElementById("modalOverlay");
const modal = document.getElementById("modal");
const toast = document.getElementById("toast");

const USERS = {
  akash: { password: "akash", role: "akash" },
  admin: { password: "password1", role: "admin" },
};

function validateLogin(username, password) {
  const user = USERS[username.toLowerCase().trim()];
  if (!user || user.password !== password) return null;
  return user.role;
}

let currentUser = null;
let view = "login";
let searchQuery = "";
let pendingFilter = "all";
let showCompleted = false;
let timelineQuery = "";
let simDbQuery = "";
let stockQuery = "";
let stockCategoryFilter = "all";
let installations = [];
let maintenanceRecords = [];
let sims = [];
let stockItems = [];
let stockTransactions = [];
let stockCategories = [];
let suppliers = [];
let simsTableReady = true;
let stockItemsTableReady = true;
let stockTxTableReady = true;
let stockCategoriesTableReady = true;
let suppliersTableReady = true;
let isLoadingData = false;
let lastSyncedAt = null;

// Realtime state
let realtimeChannel = null;
let realtimeStatus = "idle";
let refreshTimer = null;

/* ============================================================
   STOCK AUTO-CONSUME
   When an installation / repair uses an identifier (IMEI, SIM
   secondary, sensor number, MAC), decrement the matching
   stock_items row by 1 and log a transaction linked to the
   installation so the Stock page shows "Used in VEHICLE-X" with
   no manual ± Adjust needed.
   ============================================================ */

async function consumeStockFor(identifiers, link) {
  if (!stockItemsTableReady) return;
  const seen = new Set();
  const candidates = [];

  function matchBy(predicate) {
    for (const it of loadStockItems()) {
      if (seen.has(it.id)) continue;
      if (it.quantity <= 0) continue;
      if (predicate(it)) {
        candidates.push(it);
        seen.add(it.id);
      }
    }
  }

  if (identifiers.imei) {
    const v = String(identifiers.imei).trim().toLowerCase();
    matchBy((it) => (it.metadata?.imei || "").toLowerCase() === v);
  }
  if (identifiers.simSecondary) {
    const v = String(identifiers.simSecondary).trim().toLowerCase();
    matchBy((it) => (it.metadata?.secondary || "").toLowerCase() === v);
  }
  if (identifiers.sensorNo) {
    const v = String(identifiers.sensorNo).trim().toLowerCase();
    matchBy((it) => (it.metadata?.sensorNo || "").toLowerCase() === v);
  }
  if (identifiers.macId) {
    const v = String(identifiers.macId).trim().toLowerCase();
    matchBy((it) => (it.metadata?.macId || "").toLowerCase() === v);
  }

  for (const it of candidates) {
    const next = it.quantity - 1;
    try {
      await updateStockItem({ ...it, quantity: next });
      if (stockTxTableReady) {
        try {
          await insertStockTransaction({
            stockItemId: it.id,
            installationId: link.installationId || null,
            maintenanceRecordId: link.maintenanceRecordId || null,
            vehicleNo: link.vehicleNo || null,
            delta: -1,
            resultingQuantity: next,
            note: link.note || "Auto-consumed on installation",
            createdBy: currentUser || "akash",
            itemNameSnapshot: it.name + (it.category ? ` (${it.category})` : ""),
          });
        } catch (txErr) {
          console.warn("Auto-consume transaction record failed:", txErr);
        }
      }
    } catch (err) {
      console.warn("Auto-consume failed for stock item", it.name, err);
    }
  }
}

/**
 * Reverse all consumption recorded against an installation or maintenance
 * record. For each negative-delta transaction whose stock_item still exists,
 * increment that item's quantity back and log a positive "restored" tx.
 */
async function restoreStockFor({ installationId, maintenanceRecordId, reason }) {
  if (!stockItemsTableReady || !stockTxTableReady) return;
  const txs = loadStockTransactions().filter((t) => {
    if (maintenanceRecordId) return t.maintenanceRecordId === maintenanceRecordId && t.delta < 0;
    if (installationId) return t.installationId === installationId && t.delta < 0;
    return false;
  });
  for (const tx of txs) {
    if (!tx.stockItemId) continue; // item was deleted; no row to restore on
    const item = loadStockItems().find((i) => i.id === tx.stockItemId);
    if (!item) continue;
    const restoreQty = Math.abs(tx.delta);
    const next = item.quantity + restoreQty;
    try {
      await updateStockItem({ ...item, quantity: next });
      await insertStockTransaction({
        stockItemId: item.id,
        installationId: installationId || null,
        maintenanceRecordId: maintenanceRecordId || null,
        vehicleNo: tx.vehicleNo,
        delta: +restoreQty,
        resultingQuantity: next,
        note: reason || "Restored after deletion",
        createdBy: currentUser || "system",
        itemNameSnapshot: item.name + (item.category ? ` (${item.category})` : ""),
      });
    } catch (err) {
      console.warn("Stock restore failed for", item.name, err);
    }
  }
}

/* ============================================================
   TASK ENGINE
   Each repair entry generates one or more follow-up tasks based
   on what work was done. Each task is a simple to-do with a single
   Complete button (done / not done).
   ============================================================ */

const TASK_TYPES = {
  update_portal: { label: "Update on GPS Portal", icon: "🖥️", category: "Portal" },
  deactivate_sim: { label: "Deactivate the SIM", icon: "📵", category: "SIM" },
  repair_device: { label: "Repair the Device", icon: "🔧", category: "Device" },
  repair_sensor: { label: "Repair the Sensor", icon: "🛰️", category: "Sensor" },
  update_sim_primary: { label: "Update primary number for SIM", icon: "📞", category: "SIM" },
};

const TASK_ORDER = [
  "update_portal",
  "deactivate_sim",
  "update_sim_primary",
  "repair_device",
  "repair_sensor",
];

function taskFlow(type) {
  return TASK_TYPES[type];
}

function isTaskDone(task) {
  return Boolean(task.done);
}

function makeTask(type, meta = {}) {
  return {
    id: generateId(),
    type,
    done: false,
    completedAt: null,
    completedBy: null,
    ...meta,
  };
}

// Decide which follow-up tasks an entry generates.
function taskTypesForRepair({ simChange, deviceChange, deviceOutForRepair, sensorOutForRepair }) {
  const types = new Set();
  if (simChange) {
    types.add("update_portal");
    types.add("deactivate_sim");
  }
  if (deviceChange) {
    types.add("update_portal");
    types.add("repair_device");
  }
  if (deviceOutForRepair) types.add("repair_device");
  if (sensorOutForRepair) types.add("repair_sensor");
  return TASK_ORDER.filter((t) => types.has(t));
}

// Build tasks. If `unknownSimSecondary` is provided, also append an
// `update_sim_primary` task carrying the ICCID that needs a primary.
function buildTasksForRepair(opts) {
  const tasks = taskTypesForRepair(opts).map((type) => makeTask(type));
  if (opts.unknownSimSecondary) {
    tasks.push(
      makeTask("update_sim_primary", {
        simSecondary: String(opts.unknownSimSecondary).trim(),
      })
    );
  }
  return tasks;
}

// Old records (created before the task engine) derive their tasks from
// legacy boolean flags so they appear in Pending Actions correctly.
function getTasks(record) {
  if (Array.isArray(record.tasks) && record.tasks.length) return record.tasks;
  const types = taskTypesForRepair({
    simChange: record.simChange,
    deviceChange: record.deviceChange,
    deviceOutForRepair: record.deviceOutForRepair,
    sensorOutForRepair: record.sensorOutForRepair,
  });
  return types.map((type) => ({
    id: `legacy-${record.id}-${type}`,
    type,
    done: type === "deactivate_sim" ? Boolean(record.simDeactivated) : false,
    completedAt: type === "deactivate_sim" && record.simDeactivated ? record.simDeactivatedAt : null,
    completedBy: null,
  }));
}

function getPendingActionRows() {
  const rows = [];
  for (const record of loadMaintenance()) {
    for (const task of getTasks(record)) {
      if (!isTaskDone(task)) rows.push({ record, task });
    }
  }
  rows.sort((a, b) => new Date(b.record.createdAt) - new Date(a.record.createdAt));
  return rows;
}

function taskDetail(record, task) {
  const inst = loadInstallations().find((i) => i.id === record.installationId);
  const mono = (v) => `<span class="mono">${escapeHtml(v || "—")}</span>`;
  switch (task.type) {
    case "update_portal": {
      const bits = [];
      if (record.simChange && record.newSimNo) bits.push(`SIM → ${mono(record.newSimNo)}`);
      if (record.deviceChange && record.newImei) bits.push(`IMEI → ${mono(record.newImei)}`);
      return bits.length ? bits.join(" · ") : "—";
    }
    case "deactivate_sim":
      return `Old SIM ${mono(record.oldSimNo)}`;
    case "repair_device":
      return `Device ${mono(record.oldImei || record.imei || (inst ? getCurrentImei(inst) : ""))}`;
    case "repair_sensor":
      return `Sensor ${mono(inst ? inst.sensorNo : "")}`;
    case "update_sim_primary":
      return `ICCID ${mono(task.simSecondary)} — primary not yet known`;
    default:
      return "—";
  }
}

function taskDetailText(record, task) {
  const inst = loadInstallations().find((i) => i.id === record.installationId);
  switch (task.type) {
    case "update_portal": {
      const bits = [];
      if (record.simChange && record.newSimNo) bits.push(`SIM -> ${record.newSimNo}`);
      if (record.deviceChange && record.newImei) bits.push(`IMEI -> ${record.newImei}`);
      return bits.join(" | ") || "-";
    }
    case "deactivate_sim":
      return `Old SIM ${record.oldSimNo || "-"}`;
    case "repair_device":
      return `Device ${record.oldImei || record.imei || (inst ? getCurrentImei(inst) : "") || "-"}`;
    case "repair_sensor":
      return `Sensor ${inst ? inst.sensorNo : "-"}`;
    case "update_sim_primary":
      return `ICCID ${task.simSecondary || "-"} | primary not yet known`;
    default:
      return "-";
  }
}

// Export the actions currently in view (respects category filter and the
// Show-completed toggle) to an Excel report.
function exportPendingActions() {
  const rows = [["Vehicle", "Task", "Detail", "Status", "Remark", "Remark By", "Entry Date", "Completed At", "Completed By"]];
  for (const record of loadMaintenance()) {
    for (const task of getTasks(record)) {
      const flow = taskFlow(task.type);
      if (!flow) continue;
      if (pendingFilter !== "all" && flow.category !== pendingFilter) continue;
      const done = isTaskDone(task);
      if (done && !showCompleted) continue;
      rows.push([
        record.vehicleNo,
        flow.label,
        taskDetailText(record, task),
        done ? "Completed" : "Pending",
        task.remark || "",
        task.remarkBy || "",
        formatDateTime(record.createdAt),
        task.completedAt ? formatDateTime(task.completedAt) : "",
        task.completedBy || "",
      ]);
    }
  }
  if (rows.length === 1) {
    showToast("Nothing to export for this filter.", true);
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  downloadXlsx(`pending-actions_${stamp}.xlsx`, rows, "Pending actions", ["Detail"]);
  showToast(`Exported ${rows.length - 1} action${rows.length - 1 === 1 ? "" : "s"}.`);
}

async function completeTask(recordId, taskId) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;

  // Materialize tasks onto the record (so legacy-derived records persist correctly).
  const tasks = getTasks(record).map((t) => ({ ...t }));
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.done) return;

  // Special path: update_sim_primary needs the admin to enter the primary
  // number before the task can be marked complete.
  if (task.type === "update_sim_primary") {
    await completeUpdateSimPrimary(record, task);
    return;
  }

  const flow = taskFlow(task.type);
  const now = new Date().toISOString();
  task.done = true;
  task.completedAt = now;
  task.completedBy = currentUser || "admin";
  record.tasks = tasks;

  // Side effect: completing "Deactivate the SIM" also closes the old SIM entry.
  const inst = loadInstallations().find((i) => i.id === record.installationId);
  let instTouched = false;
  if (task.type === "deactivate_sim") {
    record.simDeactivated = true;
    record.simDeactivatedAt = now;
    record.simDeactivationPending = false;
    if (inst && record.oldSimNo) {
      inst.simHistory.forEach((s) => {
        if (s.value === record.oldSimNo && s.pendingDeactivation) {
          s.active = false;
          s.pendingDeactivation = false;
          s.deactivatedAt = now;
        }
      });
      instTouched = true;
    }
  }

  // Optimistic: update the UI immediately so the row clears right away.
  render();

  try {
    await updateMaintenanceRecord(record);
    if (instTouched) await updateInstallation(inst);
    showToast(`Completed: ${flow.label}`);
    await refreshAllData();
    render();
  } catch (err) {
    // Roll back the optimistic change.
    task.done = false;
    task.completedAt = null;
    if (task.type === "deactivate_sim") {
      record.simDeactivated = false;
      record.simDeactivatedAt = null;
      record.simDeactivationPending = true;
    }
    render();
    const raw = err.message || "";
    const schemaIssue = /tasks|secondary_sim|column|schema cache|could not find/i.test(raw);
    showToast(
      schemaIssue
        ? "Save failed: run pending-actions-migration.sql in Supabase SQL Editor first (the 'tasks' column is missing)."
        : raw || "Failed to update task.",
      true
    );
  }
}

async function completeUpdateSimPrimary(record, task) {
  const secondary = task.simSecondary || "";

  // Open a small modal to capture the primary number from the admin.
  const primary = await promptForSimPrimary(secondary);
  if (primary == null) return; // cancelled

  const trimmedPrimary = String(primary).trim();
  if (!trimmedPrimary) {
    showToast("Primary number cannot be empty.", true);
    return;
  }

  renderLoading("Saving SIM primary number...");
  try {
    // 1. Update / insert the sim row.
    await upsertSim({ primaryNumber: trimmedPrimary, secondaryNumber: secondary });

    // 2. Patch any installation simHistory entries that were stored as the
    //    secondary placeholder — bump them to the now-known primary.
    const lowerSec = secondary.toLowerCase();
    const installsToFix = loadInstallations().filter((inst) =>
      inst.simHistory.some((s) => (s.value || "").toLowerCase() === lowerSec)
    );
    for (const inst of installsToFix) {
      const updated = {
        ...inst,
        simHistory: inst.simHistory.map((s) =>
          (s.value || "").toLowerCase() === lowerSec ? { ...s, value: trimmedPrimary } : s
        ),
      };
      try {
        await updateInstallation(updated);
      } catch (err) {
        console.warn("Failed to update simHistory for", inst.vehicleNo, err);
      }
    }

    // 3. Mark the task as done.
    const tasks = getTasks(record).map((t) => ({ ...t }));
    const me = tasks.find((t) => t.id === task.id);
    if (me) {
      me.done = true;
      me.completedAt = new Date().toISOString();
      me.completedBy = currentUser || "admin";
    }
    record.tasks = tasks;
    await updateMaintenanceRecord(record);

    await refreshAllData();
    render();
    showToast(`Primary number saved for SIM ${secondary}.`);
  } catch (err) {
    console.error(err);
    await refreshAllData();
    render();
    const msg = err.message || "";
    if (err.code === SIMS_TABLE_MISSING || /sims/i.test(msg)) {
      showToast("Run sims-table-migration.sql in Supabase first.", true);
    } else {
      showToast(msg || "Failed to save primary.", true);
    }
  }
}

function promptForSimPrimary(secondary) {
  return new Promise((resolve) => {
    modal.innerHTML = `
      <h3>📞 Update primary number</h3>
      <p class="modal-desc">Enter the 13-digit primary SIM number that pairs with this ICCID. The SIM database will be updated and the pending task closed.</p>
      <div class="field" style="margin-top:0.5rem;">
        <label>Secondary (ICCID)</label>
        <input type="text" value="${escapeHtml(secondary)}" readonly class="mono" />
      </div>
      <div class="field">
        <label for="simPrimaryInput">Primary number</label>
        <input type="text" id="simPrimaryInput" inputmode="numeric" autocomplete="off" placeholder="e.g. 5753200309565" class="mono" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="save">Save</button>
      </div>
    `;
    modalOverlay.classList.remove("hidden");

    const input = modal.querySelector("#simPrimaryInput");
    input?.focus();

    const done = (value) => {
      closeModal();
      resolve(value);
    };

    modal.querySelector('[data-act="cancel"]').onclick = () => done(null);
    modal.querySelector('[data-act="save"]').onclick = () => done(input.value);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value);
      if (e.key === "Escape") done(null);
    });
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) done(null);
    };
  });
}

async function undoTask(recordId, taskId) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;

  const tasks = getTasks(record).map((t) => ({ ...t }));
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !task.done) return;

  const flow = taskFlow(task.type);
  task.done = false;
  task.completedAt = null;
  task.completedBy = null;
  record.tasks = tasks;

  const inst = loadInstallations().find((i) => i.id === record.installationId);
  let instTouched = false;
  if (task.type === "deactivate_sim") {
    record.simDeactivated = false;
    record.simDeactivatedAt = null;
    record.simDeactivationPending = true;
    if (inst && record.oldSimNo) {
      inst.simHistory.forEach((s) => {
        if (s.value === record.oldSimNo && !s.active && s.deactivatedAt) {
          s.active = true;
          s.pendingDeactivation = true;
          delete s.deactivatedAt;
        }
      });
      instTouched = true;
    }
  }

  render();

  try {
    await updateMaintenanceRecord(record);
    if (instTouched) await updateInstallation(inst);
    showToast(`Reopened: ${flow.label}`);
    await refreshAllData();
    render();
  } catch (err) {
    task.done = true;
    render();
    showToast(err.message || "Failed to undo task.", true);
  }
}

async function setTaskRemark(recordId, taskId, remarkText) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;

  const tasks = getTasks(record).map((t) => ({ ...t }));
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;

  const prev = { remark: task.remark || null, remarkBy: task.remarkBy || null, remarkAt: task.remarkAt || null };
  const trimmed = (remarkText || "").trim();
  const now = new Date().toISOString();
  task.remark = trimmed || null;
  task.remarkBy = trimmed ? currentUser || "admin" : null;
  task.remarkAt = trimmed ? now : null;
  record.tasks = tasks;

  render();

  try {
    await updateMaintenanceRecord(record);
    showToast(trimmed ? "Remark saved." : "Remark cleared.");
    await refreshAllData();
    render();
  } catch (err) {
    task.remark = prev.remark;
    task.remarkBy = prev.remarkBy;
    task.remarkAt = prev.remarkAt;
    render();
    const raw = err.message || "";
    const schemaIssue = /tasks|column|schema cache|could not find/i.test(raw);
    showToast(
      schemaIssue
        ? "Save failed: run pending-actions-migration.sql in Supabase SQL Editor first."
        : raw || "Failed to save remark.",
      true
    );
  }
}

function openRemarkEditor(recordId, taskId) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;
  const task = getTasks(record).find((t) => t.id === taskId);
  if (!task) return;
  const flow = taskFlow(task.type);
  const current = task.remark || "";

  showModal(
    `
    <h3>Remark</h3>
    <p class="modal-desc">
      <strong>${escapeHtml(flow.label)}</strong> · ${escapeHtml(record.vehicleNo)}
    </p>
    <div class="field full-width">
      <label for="remarkText">Note</label>
      <textarea id="remarkText" rows="3" placeholder="e.g. SIM not received yet, vendor pickup on 02 Jun, etc.">${escapeHtml(current)}</textarea>
    </div>
    <div class="modal-actions">
      ${current ? `<button type="button" class="btn btn-outline modal-clear">Clear remark</button>` : ""}
      <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      <button type="button" class="btn btn-primary modal-confirm">Save</button>
    </div>
    `,
    async () => {
      const text = document.getElementById("remarkText").value;
      await setTaskRemark(recordId, taskId, text);
      return true;
    }
  );

  modal.querySelector(".modal-clear")?.addEventListener("click", async () => {
    closeModal();
    await setTaskRemark(recordId, taskId, "");
  });

  // Focus the textarea for quick entry.
  setTimeout(() => document.getElementById("remarkText")?.focus(), 30);
}

/* ============================================================ */

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${Math.round(ms / 1000)}s — Supabase may be paused or unreachable.`
          )
        ),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function refreshAllData() {
  isLoadingData = true;
  updateLiveBadge();
  try {
    installations = await withTimeout(fetchInstallations(), 20000, "Fetch installations");
    maintenanceRecords = await withTimeout(fetchMaintenanceRecords(), 20000, "Fetch repair records");
    try {
      sims = await withTimeout(fetchSims(), 20000, "Fetch SIMs");
      simsTableReady = true;
    } catch (err) {
      if (err.code === SIMS_TABLE_MISSING) {
        console.warn("sims table missing — features that depend on it will be limited until migration runs.");
        sims = [];
        simsTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      stockItems = await withTimeout(fetchStockItems(), 20000, "Fetch stock items");
      stockItemsTableReady = true;
    } catch (err) {
      if (err.code === STOCK_ITEMS_TABLE_MISSING) {
        console.warn("stock_items table missing — Stock page will show migration prompt until migration runs.");
        stockItems = [];
        stockItemsTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      stockTransactions = await withTimeout(fetchStockTransactions(), 20000, "Fetch stock transactions");
      stockTxTableReady = true;
    } catch (err) {
      if (err.code === STOCK_TX_TABLE_MISSING) {
        console.warn("stock_transactions table missing — stock usage history features disabled until migration runs.");
        stockTransactions = [];
        stockTxTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      stockCategories = await withTimeout(fetchStockCategories(), 20000, "Fetch stock categories");
      stockCategoriesTableReady = true;
    } catch (err) {
      if (err.code === STOCK_CATEGORIES_TABLE_MISSING) {
        console.warn("stock_categories table missing — using preset list until migration runs.");
        stockCategories = [];
        stockCategoriesTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      suppliers = await withTimeout(fetchSuppliers(), 20000, "Fetch suppliers");
      suppliersTableReady = true;
    } catch (err) {
      if (err.code === SUPPLIERS_TABLE_MISSING) {
        console.warn("suppliers table missing — Supplier dropdown will be empty until migration runs.");
        suppliers = [];
        suppliersTableReady = false;
      } else {
        throw err;
      }
    }
    lastSyncedAt = new Date();
  } finally {
    isLoadingData = false;
    updateLiveBadge();
  }
}

function loadInstallations() {
  return installations;
}

function loadMaintenance() {
  return maintenanceRecords;
}

function loadSims() {
  return sims;
}

function loadStockItems() {
  return stockItems;
}

function loadStockTransactions() {
  return stockTransactions;
}

function loadSuppliers() {
  return suppliers;
}

function getSupplierOptions() {
  const fromDb = suppliers.map((s) => s.name);
  const fromItems = stockItems.map((i) => i.supplier).filter(Boolean);
  return Array.from(new Set([...fromDb, ...fromItems])).sort();
}

// Return recent transactions for one stock item, newest first.
function getStockItemTransactions(stockItemId) {
  return stockTransactions
    .filter((t) => t.stockItemId === stockItemId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Return up to N recent vehicles where this item was used (delta < 0),
// deduped, newest first.
function getRecentVehiclesForItem(stockItemId, n = 3) {
  const txs = getStockItemTransactions(stockItemId);
  const seen = new Set();
  const result = [];
  for (const t of txs) {
    if (t.delta >= 0) continue;
    if (!t.vehicleNo) continue;
    if (seen.has(t.vehicleNo)) continue;
    seen.add(t.vehicleNo);
    result.push({ vehicleNo: t.vehicleNo, delta: t.delta, at: t.createdAt });
    if (result.length >= n) break;
  }
  return result;
}

// Find installations currently using a stock item's identifier (live cross-ref).
// Useful so the Stock page shows "Used in VEHICLE-X" even if the item was
// added to stock AFTER the installation happened (no transaction record).
function getInstallationUsesForItem(item) {
  if (!item || !item.metadata) return [];
  const kind = categoryKind(item.category);
  const m = item.metadata;
  const out = [];

  for (const inst of loadInstallations()) {
    let matched = false;
    if (kind === "gps" && m.imei) {
      const v = String(m.imei).toLowerCase();
      const curImei = (getCurrentImei(inst) || "").toLowerCase();
      if (curImei === v) {
        matched = true;
      } else if (inst.imeiHistory.some((h) => (h.value || "").toLowerCase() === v)) {
        matched = true;
      }
    } else if (kind === "sim" && (m.secondary || m.primary)) {
      const sec = (m.secondary || "").toLowerCase();
      const pri = (m.primary || "").toLowerCase();
      for (const h of inst.simHistory) {
        const v = (h.value || "").toLowerCase();
        const sv = (h.secondaryValue || "").toLowerCase();
        if ((sec && (v === sec || sv === sec)) || (pri && v === pri)) {
          matched = true;
          break;
        }
      }
    } else if (kind === "sensor" && (m.sensorNo || m.macId)) {
      const sn = (m.sensorNo || "").toLowerCase();
      const mac = (m.macId || "").toLowerCase();
      if (
        (sn && (inst.sensorNo || "").toLowerCase() === sn) ||
        (mac && (inst.macId || "").toLowerCase() === mac)
      ) {
        matched = true;
      }
    }
    if (matched) out.push({ vehicleNo: inst.vehicleNo });
  }
  return out;
}

// Merge live installation uses + recent transaction uses, deduped.
function getStockUses(item, n = 3) {
  const seen = new Set();
  const result = [];
  for (const u of getInstallationUsesForItem(item)) {
    if (seen.has(u.vehicleNo)) continue;
    seen.add(u.vehicleNo);
    result.push({ vehicleNo: u.vehicleNo, source: "install" });
    if (result.length >= n) return result;
  }
  for (const u of getRecentVehiclesForItem(item.id, n)) {
    if (seen.has(u.vehicleNo)) continue;
    seen.add(u.vehicleNo);
    result.push({ vehicleNo: u.vehicleNo, source: "tx", delta: u.delta, at: u.at });
    if (result.length >= n) return result;
  }
  return result;
}

/* Find a SIM by either primary or secondary number. */
function findSimByValue(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  return (
    sims.find((s) => (s.secondaryNumber || "").toLowerCase() === v) ||
    sims.find((s) => (s.primaryNumber || "").toLowerCase() === v) ||
    null
  );
}

function findSimBySecondary(secondary) {
  if (!secondary) return null;
  const v = String(secondary).trim().toLowerCase();
  return sims.find((s) => (s.secondaryNumber || "").toLowerCase() === v) || null;
}

function findSimByPrimary(primary) {
  if (!primary) return null;
  const v = String(primary).trim().toLowerCase();
  return sims.find((s) => (s.primaryNumber || "").toLowerCase() === v) || null;
}

function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* ---------------- Realtime ---------------- */

function startRealtime() {
  if (realtimeChannel) return;
  realtimeStatus = "connecting";
  updateLiveBadge();
  realtimeChannel = subscribeRealtime((eventType, info) => {
    if (eventType === "status") {
      if (info.status === "SUBSCRIBED") realtimeStatus = "live";
      else if (info.status === "CHANNEL_ERROR" || info.status === "TIMED_OUT")
        realtimeStatus = "error";
      else realtimeStatus = "connecting";
      updateLiveBadge();
      return;
    }
    scheduleRefresh();
  });
}

async function stopRealtime() {
  if (!realtimeChannel) return;
  await unsubscribeRealtime(realtimeChannel);
  realtimeChannel = null;
  realtimeStatus = "idle";
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshAllData();
      render();
    } catch (err) {
      showToast(err.message || "Live sync failed.", true);
    }
  }, 450);
}

/* ---------------- Excel (xlsx) helpers ---------------- */
// Uses SheetJS (loaded via CDN as window.XLSX in index.html).

function downloadXlsx(filename, rows, sheetName = "Sheet1", textColumns = []) {
  if (typeof XLSX === "undefined") {
    showToast("Excel library not loaded. Refresh the page and try again.", true);
    return;
  }
  if (!rows.length) {
    showToast("Nothing to export.", true);
    return;
  }

  // Identify which column indexes need to be Text-formatted (so 18+ digit
  // numbers like SIM ICCIDs and IMEIs aren't truncated to scientific notation).
  const header = rows[0];
  const textColIdx = new Set();
  if (textColumns.length) {
    const lowerHeader = header.map((h) => String(h).toLowerCase().trim());
    textColumns.forEach((c) => {
      const idx = lowerHeader.indexOf(c.toLowerCase());
      if (idx >= 0) textColIdx.add(idx);
    });
  }

  // Force text-column values to strings (so SheetJS writes them as strings,
  // not numbers).
  const safeRows = rows.map((row, ri) =>
    row.map((cell, ci) => {
      if (ri === 0) return cell;
      if (textColIdx.has(ci)) return String(cell ?? "");
      return cell;
    })
  );

  // Pre-fill 200 blank rows so the user has plenty of pre-formatted cells to
  // paste into without Excel converting long numeric strings to scientific
  // notation.
  const BLANK_ROWS = 200;
  for (let i = 0; i < BLANK_ROWS; i += 1) {
    safeRows.push(header.map(() => ""));
  }

  const ws = XLSX.utils.aoa_to_sheet(safeRows);

  // Apply "@" (Text) number-format and string type to every cell in text
  // columns (data + blank rows).
  for (let r = 1; r < safeRows.length; r += 1) {
    for (const c of textColIdx) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const existing = ws[addr];
      const value = existing && existing.v != null ? String(existing.v) : "";
      ws[addr] = { t: "s", v: value, w: value, z: "@" };
    }
  }

  // Ensure the sheet range covers the blank rows so Excel keeps the format on
  // them.
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: safeRows.length - 1, c: header.length - 1 },
  });

  // Auto-size columns for readability (based on data rows only).
  const dataRows = rows;
  const colWidths = header.map((_, colIdx) => {
    let max = 10;
    for (const r of dataRows) {
      const v = r[colIdx] == null ? "" : String(r[colIdx]);
      if (v.length > max) max = v.length;
    }
    return { wch: Math.min(max + 2, 60) };
  });
  ws["!cols"] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

async function readXlsxFile(file) {
  if (!file) return [];
  if (typeof XLSX === "undefined") {
    throw new Error("Excel library not loaded. Refresh the page and try again.");
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  // Normalize header keys to lowercase trimmed.
  return json.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) {
      out[String(key).toLowerCase().trim()] = String(row[key] ?? "").trim();
    }
    return out;
  });
}

function normalizeBool(value) {
  return ["yes", "y", "true", "1"].includes(String(value).trim().toLowerCase());
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function activeImeiMatches(inst, imei) {
  return inst.imeiHistory.some((item) => item.value.toLowerCase() === imei.toLowerCase());
}

function escapeHtml(text) {
  const el = document.createElement("div");
  el.textContent = text ?? "";
  return el.innerHTML;
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add("hidden"), 3000);
}

/* ---------------- Modal helpers ---------------- */

function closeModal() {
  modalOverlay.classList.add("hidden");
  modal.innerHTML = "";
  modalOverlay.onclick = null;
}

function showModal(html, onConfirm) {
  modal.innerHTML = html;
  modalOverlay.classList.remove("hidden");

  modal.querySelector(".modal-close")?.addEventListener("click", closeModal);
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };

  modal.querySelector(".modal-confirm")?.addEventListener("click", async () => {
    try {
      const result = await onConfirm?.();
      if (result !== false) closeModal();
    } catch (err) {
      showToast(err.message || "Something went wrong.", true);
    }
  });

  return { modalEl: modal, close: closeModal };
}

function showConfirm({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    modal.innerHTML = `
      <div class="modal-icon ${danger ? "danger" : ""}">${danger ? "⚠️" : "❓"}</div>
      <h3>${escapeHtml(title)}</h3>
      <p class="modal-desc">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel">${escapeHtml(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    `;
    modalOverlay.classList.remove("hidden");

    const done = (value) => {
      closeModal();
      resolve(value);
    };

    modal.querySelector('[data-action="cancel"]').onclick = () => done(false);
    modal.querySelector('[data-action="confirm"]').onclick = () => done(true);
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) done(false);
    };
  });
}

/* ---------------- Domain helpers ---------------- */

function getCurrentImei(inst) {
  const active = [...inst.imeiHistory].reverse().find((i) => i.active);
  return active?.value || inst.imeiHistory.at(-1)?.value || "";
}

function getCurrentSim(inst) {
  const active = [...inst.simHistory].reverse().find((s) => s.active);
  return active?.value || inst.simHistory.at(-1)?.value || "";
}

function findInstallationByImei(imei) {
  const q = imei.trim().toLowerCase();
  if (!q) return null;
  return loadInstallations().find((inst) =>
    inst.imeiHistory.some((i) => i.value.toLowerCase() === q)
  );
}

function findInstallationByVehicle(vehicleNo) {
  const q = vehicleNo.trim().toLowerCase();
  if (!q) return null;
  return loadInstallations().find((inst) => inst.vehicleNo.toLowerCase() === q);
}

function historyList(items) {
  if (!items.length) return '<span class="muted">—</span>';
  return items
    .map((item) => {
      let badge = '<span class="badge badge-muted">Inactive</span>';
      if (item.active && item.pendingDeactivation) {
        badge = '<span class="badge badge-warn">Active · deactivate pending</span>';
      } else if (item.active) {
        badge = '<span class="badge badge-ok">Active</span>';
      }
      return '<div class="history-item"><span class="mono">' + escapeHtml(item.value) + "</span> " + badge + "</div>";
    })
    .join("");
}

function simHistoryCell(inst) {
  let html = historyList(inst.simHistory);
  if (inst.secondarySim) {
    html += `<div class="history-item secondary-sim"><span class="badge badge-secondary">2nd SIM</span> <span class="mono">${escapeHtml(inst.secondarySim)}</span></div>`;
  }
  return html;
}

function workLabels(record) {
  const parts = [];
  if (record.wiringConnection) parts.push("Wiring connection");
  if (record.simChange) parts.push(`SIM change → ${record.newSimNo}`);
  if (record.deviceChange) parts.push(`Device change → ${record.newImei}`);
  if (record.sensorOutForRepair) parts.push("Sensor out for repair");
  if (record.sensorChanged) parts.push("Sensor changed");
  if (record.deviceOutForRepair) parts.push("Device out for repair");
  if (record.otherWorkText) parts.push(`Other → ${record.otherWorkText}`);
  return parts.join(", ") || "—";
}

function getMaintenanceStatus(record) {
  const tasks = getTasks(record);
  if (!tasks.length) return '<span class="badge badge-ok">Done</span>';
  const pending = tasks.filter((t) => !isTaskDone(t));
  if (!pending.length) return '<span class="badge badge-ok">All actions done</span>';
  return `<span class="badge badge-warn">${pending.length} action${pending.length === 1 ? "" : "s"} pending</span>`;
}

function setView(next) {
  view = next;
  render();
}

async function logout() {
  await stopRealtime();
  currentUser = null;
  view = "login";
  searchQuery = "";
  lastSyncedAt = null;
  render();
}

/* ---------------- Live badge ---------------- */

function liveBadgeMarkup() {
  let cls = "synced";
  let label = "Live";
  let dotPulse = true;

  if (isLoadingData) {
    cls = "syncing";
    label = "Syncing";
  } else if (realtimeStatus === "live") {
    cls = "synced";
    label = lastSyncedAt
      ? `Live · ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Live";
  } else if (realtimeStatus === "connecting") {
    cls = "syncing";
    label = "Connecting";
  } else if (realtimeStatus === "error") {
    cls = "offline";
    label = "Reconnecting";
  } else {
    cls = "offline";
    label = "Offline";
    dotPulse = false;
  }

  return `<span class="live-badge ${cls}" id="liveBadge">
      <span class="live-dot ${dotPulse ? "" : "static"}"></span>
      ${escapeHtml(label)}
    </span>`;
}

function updateLiveBadge() {
  const existing = document.getElementById("liveBadge");
  if (!existing) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = liveBadgeMarkup();
  existing.replaceWith(wrap.firstElementChild);
}

function renderHeader(title, subtitle) {
  return `
    <header class="header">
      <div class="header-content">
        <div class="logo">
          <span class="logo-icon">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/>
              <circle cx="12" cy="11" r="2.4"/>
            </svg>
          </span>
          <div>
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(subtitle)}</p>
          </div>
        </div>
        ${
          currentUser
            ? `<div class="header-actions">
                ${liveBadgeMarkup()}
                <span class="user-badge">${currentUser === "akash" ? "👷 Akash" : "🛡️ Admin"}</span>
                <button type="button" class="btn btn-outline btn-sm" id="logoutBtn">Logout</button>
              </div>`
            : ""
        }
      </div>
    </header>
  `;
}

function renderConfigMissing() {
  app.innerHTML = `
    ${renderHeader("GPS Maintenance Tracker", "Setup required")}
    <main class="main centered">
      <section class="card login-card">
        <h2>Supabase not configured</h2>
        <p class="login-desc">Copy <code>config_example.js</code> to <code>config.js</code>, add your Supabase URL and anon key, then include it in <code>index.html</code>.</p>
      </section>
    </main>
  `;
}

function renderLoading(message = "Loading data...") {
  app.innerHTML = `
    ${renderHeader("GPS Maintenance Tracker", message)}
    <main class="main centered">
      <section class="card login-card loading-card">
        <div class="spinner"></div>
        <p class="login-desc">${escapeHtml(message)}</p>
      </section>
    </main>
  `;
}

function bindLogout() {
  document.getElementById("logoutBtn")?.addEventListener("click", logout);
}

function renderLogin() {
  app.innerHTML = `
    ${renderHeader("GPS Maintenance Tracker", "Login to continue")}
    <main class="main centered">
      <section class="card login-card">
        <h2>Login</h2>
        <p class="login-desc">Enter your username and password to continue.</p>
        <form id="loginForm" class="login-form">
          <div class="field">
            <label for="loginUser">Username</label>
            <input type="text" id="loginUser" required placeholder="akash or admin" autocomplete="username" />
          </div>
          <div class="field">
            <label for="loginPass">Password</label>
            <input type="password" id="loginPass" required placeholder="Password" autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary login-submit">Login</button>
        </form>
      </section>
    </main>
  `;

  document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("loginUser").value;
    const password = document.getElementById("loginPass").value;
    const role = validateLogin(username, password);

    if (!role) {
      showToast("Invalid username or password.", true);
      document.getElementById("loginPass").classList.add("invalid");
      return;
    }

    currentUser = role;
    view = role === "akash" ? "akash-home" : "dashboard";
    renderLoading("Loading data from Supabase...");
    try {
      await refreshAllData();
      startRealtime();
      render();
    } catch (err) {
      console.error("Supabase load failed:", err);
      renderConnectionError(err.message || "Failed to load data.");
    }
  });
}

function renderConnectionError(message) {
  app.innerHTML = `
    ${renderHeader("Connection error", "Could not reach Supabase")}
    <main class="main centered">
      <section class="card login-card">
        <h2>⚠️ Could not load data</h2>
        <p class="login-desc"><strong>${escapeHtml(message)}</strong></p>
        <p class="login-desc">Most common cause: the Supabase project is paused (free tier auto-pauses after a week of inactivity).</p>
        <ol class="setup-steps">
          <li>Open <a href="https://supabase.com/dashboard/project/jzclmcjurfehpfybxryh" target="_blank" rel="noopener">your Supabase dashboard</a></li>
          <li>If you see a "Restore project" or "Project paused" banner, click <strong>Restore</strong></li>
          <li>Wait 1–2 minutes for it to wake up, then retry</li>
        </ol>
        <div class="form-actions" style="margin-top: 1.25rem;">
          <button type="button" class="btn btn-primary" id="retryConnect">↻ Retry connection</button>
          <button type="button" class="btn btn-secondary" id="backToLogin">Back to login</button>
        </div>
      </section>
    </main>
  `;
  document.getElementById("retryConnect")?.addEventListener("click", async () => {
    renderLoading("Retrying connection...");
    try {
      await refreshAllData();
      startRealtime();
      render();
    } catch (err) {
      console.error("Retry failed:", err);
      renderConnectionError(err.message || "Still cannot reach Supabase.");
    }
  });
  document.getElementById("backToLogin")?.addEventListener("click", () => {
    currentUser = null;
    view = "login";
    render();
  });
}

function renderAkashHome() {
  const myInstallations = loadInstallations().filter((inst) => inst.createdBy === "akash");
  const myMaintenance = loadMaintenance().filter((record) => record.createdBy === "akash");
  app.innerHTML = `
    ${renderHeader("Akash Portal", "Select work type")}
    <main class="main">
      <section class="card">
        <h2>What work are you doing?</h2>
        <div class="choice-grid">
          <button type="button" class="choice-card" id="goInstall">
            <span class="choice-icon">🆕</span>
            <span class="choice-title">Installing New GPS</span>
            <span class="choice-desc">Register a new device installation</span>
          </button>
          <button type="button" class="choice-card" id="goRepair">
            <span class="choice-icon">🔧</span>
            <span class="choice-title">Repair Work</span>
            <span class="choice-desc">Maintenance on existing installation</span>
          </button>
        </div>
      </section>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>My Entries</h2>
            <p class="section-subtitle">Entries saved from Akash login.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="refreshMine">↻ Refresh</button>
        </div>
        <div class="summary-grid">
          <div class="summary-box">
            <strong>${myInstallations.length}</strong>
            <span>Installations</span>
          </div>
          <div class="summary-box">
            <strong>${myMaintenance.length}</strong>
            <span>Repair work</span>
          </div>
        </div>
        <div class="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Vehicle</th>
                <th>IMEI / Work</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${
                [...myInstallations.map((inst) => ({
                  id: inst.id,
                  kind: "install",
                  date: inst.createdAt,
                  type: "Installation",
                  vehicle: inst.vehicleNo,
                  detail: getCurrentImei(inst),
                })), ...myMaintenance.map((record) => ({
                  id: record.id,
                  kind: "repair",
                  date: record.createdAt,
                  type: "Repair",
                  vehicle: record.vehicleNo,
                  detail: workLabels(record),
                }))]
                  .sort((a, b) => new Date(b.date) - new Date(a.date))
                  .slice(0, 12)
                  .map((entry) => `
                    <tr>
                      <td class="date-cell">${escapeHtml(formatDateTime(entry.date))}</td>
                      <td><span class="badge ${entry.type === "Installation" ? "badge-ok" : "badge-repair"}">${escapeHtml(entry.type)}</span></td>
                      <td>${escapeHtml(entry.vehicle)}</td>
                      <td>${escapeHtml(entry.detail)}</td>
                      <td class="row-actions">
                        <button type="button" class="btn btn-outline btn-sm akash-edit" data-kind="${entry.kind}" data-id="${escapeHtml(entry.id)}">✎ Edit</button>
                        <button type="button" class="btn btn-danger btn-sm akash-delete" data-kind="${entry.kind}" data-id="${escapeHtml(entry.id)}">Delete</button>
                      </td>
                    </tr>
                  `)
                  .join("") || `<tr class="empty-row"><td colspan="5">No entries from Akash yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;

  bindLogout();
  document.getElementById("goInstall")?.addEventListener("click", () => setView("install"));
  document.getElementById("goRepair")?.addEventListener("click", () => setView("repair"));
  document.getElementById("refreshMine")?.addEventListener("click", async () => {
    renderLoading("Refreshing data from Supabase...");
    await refreshAllData();
    setView("akash-home");
  });
  app.querySelectorAll(".akash-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "install") openAkashEditInstallation(btn.dataset.id);
      else openAkashEditRepair(btn.dataset.id);
    });
  });
  app.querySelectorAll(".akash-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "install") deleteAkashInstallation(btn.dataset.id);
      else deleteAkashMaintenance(btn.dataset.id);
    });
  });
}

/* ---------------- Akash: edit + delete handlers ---------------- */

function openAkashEditInstallation(installId) {
  const inst = loadInstallations().find((i) => i.id === installId);
  if (!inst) return;
  modal.innerHTML = `
    <h3>✎ Edit installation</h3>
    <p class="modal-desc">You can fix typos in vehicle no, GPS model, MAC ID and sensor number. <strong>IMEI and SIM cannot be edited here</strong> — if you typed the wrong device or SIM, delete this entry and create a new one so stock is corrected automatically.</p>
    <div class="field">
      <label for="aiVehicle">Vehicle number</label>
      <input type="text" id="aiVehicle" value="${escapeHtml(inst.vehicleNo)}" autocomplete="off" />
    </div>
    <div class="field">
      <label for="aiModel">GPS model</label>
      <input type="text" id="aiModel" value="${escapeHtml(inst.gpsModel)}" autocomplete="off" />
    </div>
    <div class="field-row">
      <div class="field">
        <label for="aiMac">MAC ID</label>
        <input type="text" id="aiMac" value="${escapeHtml(inst.macId || "")}" autocomplete="off" class="mono" />
      </div>
      <div class="field">
        <label for="aiSensor">Sensor number</label>
        <input type="text" id="aiSensor" value="${escapeHtml(inst.sensorNo || "")}" autocomplete="off" class="mono" />
      </div>
    </div>
    <div class="field">
      <label>IMEI (read-only)</label>
      <input type="text" value="${escapeHtml(getCurrentImei(inst) || "")}" readonly class="mono" />
    </div>
    <div class="field">
      <label>SIM (read-only)</label>
      <input type="text" value="${escapeHtml(getCurrentSim(inst) || "")}" readonly class="mono" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Save changes</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const vehicleNo = modal.querySelector("#aiVehicle").value.trim();
    const gpsModel = modal.querySelector("#aiModel").value.trim();
    const macId = modal.querySelector("#aiMac").value.trim();
    const sensorNo = modal.querySelector("#aiSensor").value.trim();
    if (!vehicleNo) {
      showToast("Vehicle number cannot be empty.", true);
      return;
    }
    closeModal();
    renderLoading("Saving changes...");
    try {
      await updateInstallation({ ...inst, vehicleNo, gpsModel, macId, sensorNo });
      await refreshAllData();
      render();
      showToast("Installation updated.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

function openAkashEditRepair(recordId) {
  const record = loadMaintenance().find((r) => r.id === recordId);
  if (!record) return;
  modal.innerHTML = `
    <h3>✎ Edit repair entry</h3>
    <p class="modal-desc">You can update the "other work" comment only. Identifier changes (SIM / IMEI) require deleting this entry and creating a new repair so stock is corrected.</p>
    <div class="field">
      <label>Vehicle (read-only)</label>
      <input type="text" value="${escapeHtml(record.vehicleNo)}" readonly />
    </div>
    <div class="field">
      <label>Work done (read-only)</label>
      <input type="text" value="${escapeHtml(workLabels(record))}" readonly />
    </div>
    <div class="field">
      <label for="arOther">Other work / comment</label>
      <input type="text" id="arOther" value="${escapeHtml(record.otherWorkText || "")}" placeholder="e.g. bracket changed, wiring re-done..." />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Save changes</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const otherWorkText = modal.querySelector("#arOther").value.trim() || null;
    closeModal();
    renderLoading("Saving changes...");
    try {
      await updateMaintenanceRecord({ ...record, otherWorkText });
      await refreshAllData();
      render();
      showToast("Repair entry updated.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

async function deleteAkashInstallation(installId) {
  const inst = loadInstallations().find((i) => i.id === installId);
  if (!inst) return;
  const linkedRepairs = loadMaintenance().filter((r) => r.installationId === installId);
  const ok = await showConfirm({
    title: "Delete this installation?",
    message: `Remove the installation for ${inst.vehicleNo}? ${linkedRepairs.length ? `This will also remove ${linkedRepairs.length} repair record${linkedRepairs.length === 1 ? "" : "s"} linked to it. ` : ""}Any stock that was consumed (IMEI / SIM / sensor) will be automatically restored to inventory.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  renderLoading("Deleting installation & restoring stock...");
  try {
    // Restore stock for each linked maintenance first.
    for (const r of linkedRepairs) {
      await restoreStockFor({
        maintenanceRecordId: r.id,
        reason: `Restored — installation for ${inst.vehicleNo} deleted`,
      });
      await deleteMaintenanceRecord(r.id);
    }
    // Then restore stock for the installation itself.
    await restoreStockFor({
      installationId: installId,
      reason: `Restored — installation for ${inst.vehicleNo} deleted`,
    });
    await deleteInstallation(installId);
    await refreshAllData();
    render();
    showToast("Installation deleted, stock restored.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

async function deleteAkashMaintenance(recordId) {
  const record = loadMaintenance().find((r) => r.id === recordId);
  if (!record) return;
  const ok = await showConfirm({
    title: "Delete this repair entry?",
    message: `Remove repair on ${record.vehicleNo} (${workLabels(record)})? Stock that was consumed will be restored, and any SIM/device history added by this repair will be reverted.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  renderLoading("Deleting repair & restoring state...");
  try {
    // 1) Reverse stock consumption for this repair.
    await restoreStockFor({
      maintenanceRecordId: recordId,
      reason: `Restored — repair on ${record.vehicleNo} deleted`,
    });
    // 2) Revert simHistory / imeiHistory on the linked installation.
    const inst = loadInstallations().find((i) => i.id === record.installationId);
    if (inst) {
      let touched = false;
      if (record.simChange && record.newSimNo) {
        const idx = inst.simHistory.findIndex(
          (h) => h.value === record.newSimNo && h.active
        );
        if (idx >= 0) {
          inst.simHistory.splice(idx, 1);
          // Restore the previous active sim (the one this repair marked pendingDeactivation).
          for (let i = inst.simHistory.length - 1; i >= 0; i -= 1) {
            if (inst.simHistory[i].pendingDeactivation) {
              inst.simHistory[i].pendingDeactivation = false;
              inst.simHistory[i].active = true;
              break;
            }
            if (inst.simHistory[i].value === record.oldSimNo) {
              inst.simHistory[i].active = true;
              inst.simHistory[i].pendingDeactivation = false;
              break;
            }
          }
          touched = true;
        }
      }
      if (record.deviceChange && record.newImei) {
        const idx = inst.imeiHistory.findIndex(
          (h) => h.value === record.newImei && h.active
        );
        if (idx >= 0) {
          inst.imeiHistory.splice(idx, 1);
          // Re-activate the previous IMEI.
          for (let i = inst.imeiHistory.length - 1; i >= 0; i -= 1) {
            inst.imeiHistory[i].active = true;
            break;
          }
          touched = true;
        }
      }
      if (touched) {
        await updateInstallation(inst);
      }
    }
    // 3) Delete the maintenance record.
    await deleteMaintenanceRecord(recordId);
    await refreshAllData();
    render();
    showToast("Repair deleted, state restored.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

function renderInstallForm() {
  app.innerHTML = `
    ${renderHeader("Installing New GPS", "All 6 fields are mandatory")}
    <main class="main">
      <section class="card">
        <div class="form-nav">
          <button type="button" class="btn btn-secondary btn-sm" id="backBtn">← Back</button>
        </div>
        <h2>New GPS Installation</h2>
        <form id="installForm" class="form-grid">
          <div class="field">
            <label for="instImei">IMEI No <span class="required">*</span></label>
            <input type="text" id="instImei" required placeholder="e.g. 867530012345678" autocomplete="off" inputmode="numeric" />
          </div>
          <div class="field">
            <label for="instVehicle">Vehicle No <span class="required">*</span></label>
            <input type="text" id="instVehicle" required placeholder="e.g. MH12AB1234" autocomplete="off" />
          </div>
          <div class="field">
            <label for="instModel">GPS Model <span class="required">*</span></label>
            <input type="text" id="instModel" required placeholder="e.g. GT06N" autocomplete="off" />
          </div>
          <div class="field">
            <label for="instSim">Primary SIM No <span class="required">*</span></label>
            <input type="text" id="instSim" required placeholder="e.g. 9876543210" autocomplete="off" inputmode="numeric" />
          </div>
          <div class="field">
            <label for="instMac">MAC ID <span class="required">*</span></label>
            <input type="text" id="instMac" required placeholder="e.g. AA:BB:CC:DD:EE:FF" autocomplete="off" />
          </div>
          <div class="field">
            <label for="instSensor">Sensor No <span class="required">*</span></label>
            <input type="text" id="instSensor" required placeholder="e.g. SN-12345" autocomplete="off" />
          </div>
          <div class="form-actions full-width">
            <button type="submit" class="btn btn-primary">Continue to Confirm</button>
          </div>
        </form>
      </section>
    </main>
  `;

  bindLogout();
  document.getElementById("backBtn")?.addEventListener("click", () => setView("akash-home"));
  document.getElementById("installForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    handleInstallSubmit();
  });
}

function handleInstallSubmit() {
  const fields = {
    imei: document.getElementById("instImei"),
    vehicle: document.getElementById("instVehicle"),
    model: document.getElementById("instModel"),
    sim: document.getElementById("instSim"),
    mac: document.getElementById("instMac"),
    sensor: document.getElementById("instSensor"),
  };

  let valid = true;
  Object.values(fields).forEach((el) => {
    el.classList.toggle("invalid", !el.value.trim());
    if (!el.value.trim()) valid = false;
  });
  if (!valid) {
    showToast("Please fill all 6 fields.", true);
    return;
  }

  const data = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()]));

  showModal(
    `
    <h3>Confirm Before Submit</h3>
    <p class="modal-desc">Both answers must be <strong>Yes</strong> to submit.</p>
    <div class="confirm-questions">
      <div class="confirm-q">
        <span>Vehicle live hai?</span>
        <div class="yes-no-group">
          <label class="yn-option"><input type="radio" name="vehicleLive" value="yes" /><span>Yes</span></label>
          <label class="yn-option"><input type="radio" name="vehicleLive" value="no" /><span>No</span></label>
        </div>
      </div>
      <div class="confirm-q">
        <span>MAC ID daal diya?</span>
        <div class="yes-no-group">
          <label class="yn-option"><input type="radio" name="macEntered" value="yes" /><span>Yes</span></label>
          <label class="yn-option"><input type="radio" name="macEntered" value="no" /><span>No</span></label>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      <button type="button" class="btn btn-primary modal-confirm">Submit</button>
    </div>
    `,
    async () => {
      const vehicleLive = modal.querySelector('input[name="vehicleLive"]:checked')?.value;
      const macEntered = modal.querySelector('input[name="macEntered"]:checked')?.value;

      if (vehicleLive !== "yes" || macEntered !== "yes") {
        showToast("Both answers must be Yes to submit.", true);
        return false;
      }

      const allInstalls = loadInstallations();
      if (allInstalls.some((i) => i.vehicleNo.toLowerCase() === data.vehicle.toLowerCase())) {
        showToast("Vehicle already exists in installation database.", true);
        return false;
      }
      if (allInstalls.some((i) => i.imeiHistory.some((h) => h.value.toLowerCase() === data.imei.toLowerCase()))) {
        showToast("IMEI already exists in installation database.", true);
        return false;
      }

      const now = new Date().toISOString();
      const newInstall = {
        id: generateId(),
        vehicleNo: data.vehicle,
        gpsModel: data.model,
        macId: data.mac,
        sensorNo: data.sensor,
        secondarySim: null,
        imeiHistory: [{ value: data.imei, addedAt: now, active: true }],
        simHistory: [{ value: data.sim, addedAt: now, active: true, pendingDeactivation: false }],
        createdAt: now,
        createdBy: "akash",
      };

      const saved = await insertInstallation(newInstall);
      // Auto-consume matching stock entries (GPS by IMEI, SIM by secondary,
      // sensor by sensor no / MAC).
      await consumeStockFor(
        {
          imei: data.imei,
          simSecondary: data.sim, // may be a primary 13-digit; harmless if no match
          sensorNo: data.sensor,
          macId: data.mac,
        },
        {
          installationId: saved?.id || newInstall.id,
          vehicleNo: data.vehicle,
          note: "Used on new installation",
        }
      );
      await refreshAllData();
      showToast("Installation saved successfully!");
      setView("akash-home");
      return true;
    }
  );
}

function renderRepairForm() {
  app.innerHTML = `
    ${renderHeader("Repair Work", "Maintenance on existing GPS installation")}
    <main class="main">
      <section class="card">
        <div class="form-nav">
          <button type="button" class="btn btn-secondary btn-sm" id="backBtn">← Back</button>
        </div>
        <h2>Repair / Maintenance</h2>
        <form id="repairForm">
          <div class="form-grid">
            <div class="field">
              <label for="repairImei">IMEI No</label>
              <input type="text" id="repairImei" placeholder="Enter IMEI to lookup" autocomplete="off" inputmode="numeric" />
              <p class="field-hint" id="imeiHint">Enter IMEI or select vehicle from database</p>
            </div>
            <div class="field">
              <label for="repairVehicle">Vehicle No / Name</label>
              <input type="text" id="repairVehicle" list="installedVehicles" placeholder="Search installed vehicle" autocomplete="off" />
              <datalist id="installedVehicles">
                ${loadInstallations()
                  .map((inst) => `<option value="${escapeHtml(inst.vehicleNo)}">${escapeHtml(getCurrentImei(inst))}</option>`)
                  .join("")}
              </datalist>
            </div>
          </div>

          <div class="work-section">
            <h3>What work is required?</h3>
            <label class="check-option"><input type="checkbox" id="workWiring" /><span>Wiring connection</span></label>
            <label class="check-option"><input type="checkbox" id="workSimChange" /><span>SIM change</span></label>
            <div class="conditional-field hidden" id="newSimBox">
              <label for="newSimNo">New SIM ICCID (Secondary number — 20-digit printed on card) <span class="required">*</span></label>
              <input type="text" id="newSimNo" placeholder="e.g. 89918720507069156677" autocomplete="off" inputmode="numeric" />
              <p class="hint" id="newSimHint">Enter the 20-digit ICCID. The system will look up the primary number from the SIM database automatically.</p>
            </div>
            <label class="check-option"><input type="checkbox" id="workDeviceChange" /><span>Device change</span></label>
            <div class="conditional-field hidden" id="newImeiBox">
              <label for="newImeiNo">New IMEI No <span class="required">*</span></label>
              <input type="text" id="newImeiNo" placeholder="Enter new IMEI number" autocomplete="off" inputmode="numeric" />
            </div>
            <label class="check-option"><input type="checkbox" id="workSensorOut" /><span>Sensor out for repair in office</span></label>
            <label class="check-option"><input type="checkbox" id="workSensorChanged" /><span>Sensor changed</span></label>
            <label class="check-option"><input type="checkbox" id="workDeviceOut" /><span>Device out for repair in office</span></label>
            <label class="check-option"><input type="checkbox" id="workOther" /><span>Other</span></label>
            <div class="conditional-field hidden" id="otherWorkBox">
              <label for="otherWorkText">Other repair detail <span class="required">*</span></label>
              <input type="text" id="otherWorkText" placeholder="Enter repair detail" autocomplete="off" />
            </div>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Submit Repair Work</button>
          </div>
        </form>
      </section>
    </main>
  `;

  bindLogout();
  document.getElementById("backBtn")?.addEventListener("click", () => setView("akash-home"));

  const imeiInput = document.getElementById("repairImei");
  const vehicleInput = document.getElementById("repairVehicle");
  const hint = document.getElementById("imeiHint");
  const simCheck = document.getElementById("workSimChange");
  const deviceCheck = document.getElementById("workDeviceChange");
  const otherCheck = document.getElementById("workOther");
  const newSimBox = document.getElementById("newSimBox");
  const newImeiBox = document.getElementById("newImeiBox");
  const otherWorkBox = document.getElementById("otherWorkBox");

  const applyInstallation = (inst) => {
    if (inst) {
      imeiInput.value = getCurrentImei(inst);
      vehicleInput.value = inst.vehicleNo;
      hint.textContent = `Found: ${inst.gpsModel} | Current SIM: ${getCurrentSim(inst)}`;
      hint.classList.add("hint-ok");
      imeiInput.classList.remove("invalid");
      vehicleInput.classList.remove("invalid");
    } else {
      hint.classList.remove("hint-ok");
    }
  };

  imeiInput.addEventListener("input", () => {
    const inst = findInstallationByImei(imeiInput.value);
    if (inst) {
      applyInstallation(inst);
    } else if (imeiInput.value.trim()) {
      vehicleInput.value = "";
      hint.textContent = "IMEI not found in installation database";
      hint.classList.remove("hint-ok");
    } else {
      vehicleInput.value = "";
      hint.textContent = "Enter IMEI from installation database";
      hint.classList.remove("hint-ok");
    }
  });

  vehicleInput.addEventListener("input", () => {
    const inst = findInstallationByVehicle(vehicleInput.value);
    if (inst) {
      applyInstallation(inst);
    } else if (vehicleInput.value.trim()) {
      imeiInput.value = "";
      hint.textContent = "Vehicle not found in installation database";
      hint.classList.remove("hint-ok");
    } else {
      imeiInput.value = "";
      hint.textContent = "Enter IMEI or select vehicle from database";
      hint.classList.remove("hint-ok");
    }
  });

  simCheck.addEventListener("change", () => {
    newSimBox.classList.toggle("hidden", !simCheck.checked);
    if (!simCheck.checked) {
      document.getElementById("newSimNo").value = "";
      const h = document.getElementById("newSimHint");
      if (h) {
        h.textContent = "Enter the 20-digit ICCID. The system will look up the primary number from the SIM database automatically.";
        h.className = "hint";
      }
    }
  });

  // Live SIM lookup as Akash types the ICCID.
  document.getElementById("newSimNo")?.addEventListener("input", (e) => {
    const v = e.target.value.trim();
    const h = document.getElementById("newSimHint");
    if (!h) return;
    if (!v) {
      h.textContent = "Enter the 20-digit ICCID. The system will look up the primary number from the SIM database automatically.";
      h.className = "hint";
      return;
    }
    const sim = findSimBySecondary(v);
    if (sim && sim.primaryNumber) {
      h.textContent = `✓ Found in SIM database — primary number: ${sim.primaryNumber}`;
      h.className = "hint hint-ok";
    } else if (sim && !sim.primaryNumber) {
      h.textContent = "⚠️ ICCID known to the SIM database but primary number is still pending. Admin will be asked to update it.";
      h.className = "hint hint-warn";
    } else {
      h.textContent = "⚠️ ICCID not in SIM database yet. Admin will be asked to add the primary number after submission.";
      h.className = "hint hint-warn";
    }
  });
  deviceCheck.addEventListener("change", () => {
    newImeiBox.classList.toggle("hidden", !deviceCheck.checked);
    if (!deviceCheck.checked) document.getElementById("newImeiNo").value = "";
  });
  otherCheck.addEventListener("change", () => {
    otherWorkBox.classList.toggle("hidden", !otherCheck.checked);
    if (!otherCheck.checked) document.getElementById("otherWorkText").value = "";
  });

  document.getElementById("repairForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const imei = imeiInput.value.trim();
    const inst = findInstallationByImei(imei) || findInstallationByVehicle(vehicleInput.value);
    const wiring = document.getElementById("workWiring").checked;
    const simChange = simCheck.checked;
    const deviceChange = deviceCheck.checked;
    const sensorOutForRepair = document.getElementById("workSensorOut").checked;
    const sensorChanged = document.getElementById("workSensorChanged").checked;
    const deviceOutForRepair = document.getElementById("workDeviceOut").checked;
    const otherWork = otherCheck.checked;
    const newSim = document.getElementById("newSimNo").value.trim();
    const newImei = document.getElementById("newImeiNo").value.trim();
    const otherWorkText = document.getElementById("otherWorkText").value.trim();

    if (!inst) {
      imeiInput.classList.add("invalid");
      vehicleInput.classList.add("invalid");
      showToast("IMEI or vehicle not found in installation database.", true);
      return;
    }
    if (!wiring && !simChange && !deviceChange && !sensorOutForRepair && !sensorChanged && !deviceOutForRepair && !otherWork) {
      showToast("Select at least one work type.", true);
      return;
    }
    if (simChange && !newSim) {
      document.getElementById("newSimNo").classList.add("invalid");
      showToast("Enter new SIM number for SIM change.", true);
      return;
    }
    if (deviceChange && !newImei) {
      document.getElementById("newImeiNo").classList.add("invalid");
      showToast("Enter new IMEI for device change.", true);
      return;
    }
    if (otherWork && !otherWorkText) {
      document.getElementById("otherWorkText").classList.add("invalid");
      showToast("Enter details for Other repair work.", true);
      return;
    }

    const updatedInst = {
      ...inst,
      imeiHistory: inst.imeiHistory.map((item) => ({ ...item })),
      simHistory: inst.simHistory.map((item) => ({ ...item })),
    };
    const now = new Date().toISOString();
    const currentSim = getCurrentSim(updatedInst);
    const currentImei = getCurrentImei(updatedInst);
    let simDeactivationPending = false;
    let oldSimNo = null;
    let oldImei = null;
    let unknownSimSecondary = null;
    let newSimStored = newSim; // What we actually store in simHistory.value

    if (simChange) {
      oldSimNo = currentSim;
      // Akash entered the secondary (ICCID). Look up the primary from the SIM
      // database. If found, store the primary as the active SIM value. If
      // not, store the secondary as a placeholder and queue a pending task
      // for the admin to update the primary number.
      const sim = findSimBySecondary(newSim);
      if (sim && sim.primaryNumber) {
        newSimStored = sim.primaryNumber;
      } else {
        newSimStored = newSim; // placeholder = secondary
        unknownSimSecondary = newSim;
        // Pre-register the SIM in the inventory so admin can find it later.
        try {
          await upsertSim({ primaryNumber: null, secondaryNumber: newSim });
        } catch (err) {
          // Non-fatal: continue even if the sims table isn't ready.
          console.warn("Could not pre-register SIM in sims table:", err);
        }
      }
      updatedInst.simHistory.forEach((s) => {
        if (s.active) s.pendingDeactivation = true;
      });
      updatedInst.simHistory.push({
        value: newSimStored,
        secondaryValue: newSim,
        addedAt: now,
        active: true,
        pendingDeactivation: false,
      });
      simDeactivationPending = true;
    }
    if (deviceChange) {
      oldImei = currentImei;
      updatedInst.imeiHistory.forEach((i) => {
        i.active = false;
      });
      updatedInst.imeiHistory.push({ value: newImei, addedAt: now, active: true });
    }

    const newRecord = {
      id: generateId(),
      installationId: inst.id,
      imei: currentImei,
      vehicleNo: inst.vehicleNo,
      wiringConnection: wiring,
      simChange,
      newSimNo: simChange ? newSimStored : null,
      deviceChange,
      newImei: deviceChange ? newImei : null,
      sensorOutForRepair,
      sensorChanged,
      deviceOutForRepair,
      otherWorkText: otherWork ? otherWorkText : null,
      oldSimNo,
      oldImei,
      simDeactivationPending,
      simDeactivated: false,
      simDeactivatedAt: null,
      tasks: buildTasksForRepair({
        simChange,
        deviceChange,
        deviceOutForRepair,
        sensorOutForRepair,
        unknownSimSecondary,
      }),
      createdAt: now,
      createdBy: "akash",
    };

    try {
      await updateInstallation(updatedInst);
      const savedRecord = await insertMaintenanceRecord(newRecord);
      // Auto-consume newly-used stock entries.
      await consumeStockFor(
        {
          imei: deviceChange ? newImei : null,
          simSecondary: simChange ? newSim : null,
        },
        {
          installationId: inst.id,
          maintenanceRecordId: savedRecord?.id || newRecord.id,
          vehicleNo: inst.vehicleNo,
          note: "Used during repair",
        }
      );
      await refreshAllData();
      showToast("Repair work saved successfully!");
      setView("akash-home");
    } catch (err) {
      showToast(err.message || "Failed to save repair work.", true);
    }
  });
}

function downloadInstallationSample() {
  downloadXlsx(
    "installation-upload-sample.xlsx",
    [
      ["imei", "vehicle_no", "gps_model", "sim_no", "mac_id", "sensor_no", "created_at", "created_by"],
      ["867530012345678", "MH12AB1234", "GT06N", "9876543210", "AA:BB:CC:DD:EE:FF", "SN-12345", "2026-05-25 10:30", "akash"],
    ],
    "Sheet1",
    ["imei", "sim_no", "mac_id", "sensor_no"]
  );
}

function downloadRepairSample() {
  downloadXlsx(
    "repair-upload-sample.xlsx",
    [
      ["imei", "wiring_connection", "sim_change", "new_sim_no", "device_change", "new_imei", "sensor_out_for_repair", "sensor_changed", "device_out_for_repair", "other_work_text", "created_at", "created_by"],
      ["867530012345678", "yes", "yes", "9876500000", "no", "", "no", "no", "no", "", "2026-05-25 11:00", "akash"],
      ["867530012345678", "no", "no", "", "yes", "867530012345679", "yes", "no", "yes", "Bracket broken", "2026-05-25 12:00", "akash"],
    ],
    "Sheet1",
    ["imei", "new_sim_no", "new_imei"]
  );
}

function downloadSimSample() {
  downloadXlsx(
    "sim-database-sample.xlsx",
    [
      ["primary_number", "secondary_number", "notes"],
      ["5753200309565", "89918720507069157022", ""],
      ["5753200309623", "89918720507069156917", ""],
      ["", "89918720507069158640", "Primary not yet known"],
    ],
    "Sheet1",
    ["primary_number", "secondary_number"]
  );
}

async function importSimsFromExcel(file) {
  const rows = await readXlsxFile(file);
  if (!rows.length) {
    showToast("Upload file is empty.", true);
    return;
  }
  let saved = 0;
  const errors = [];
  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const secondary = String(
      row.secondary_number || row.secondary || row.iccid || row.secondary_sim || ""
    ).trim();
    const primary = String(
      row.primary_number || row.primary || row.primary_sim || ""
    ).trim();
    const notes = String(row.notes || "").trim() || null;
    if (!secondary) {
      errors.push(`Row ${rowNo}: secondary_number is required`);
      continue;
    }
    try {
      await upsertSim({
        primaryNumber: primary || null,
        secondaryNumber: secondary,
        notes,
      });
      saved += 1;
    } catch (err) {
      if (err.code === SIMS_TABLE_MISSING) {
        errors.push(`Row ${rowNo}: sims table missing — run sims-table-migration.sql first`);
      } else {
        errors.push(`Row ${rowNo}: ${err.message}`);
      }
    }
  }
  await refreshAllData();
  render();
  showToast(
    `${saved} SIM${saved === 1 ? "" : "s"} saved.${errors.length ? ` ${errors.length} skipped.` : ""}`,
    saved === 0
  );
  if (errors.length) showImportReport(errors);
}

async function importInstallations(file) {
  const rows = await readXlsxFile(file);
  if (!rows.length) {
    showToast("Upload file is empty.", true);
    return;
  }

  let imported = 0;
  const errors = [];
  const allInstalls = [...loadInstallations()];

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const imei = row.imei;
    const vehicleNo = row.vehicle_no || row.vehicle;
    const gpsModel = row.gps_model || row.model;
    const simNo = row.sim_no || row.sim;
    const macId = row.mac_id || row.mac;
    const sensorNo = row.sensor_no || row.sensor;

    if (!imei || !vehicleNo || !gpsModel || !simNo || !macId || !sensorNo) {
      errors.push(`Row ${rowNo}: missing required installation fields`);
      continue;
    }
    if (allInstalls.some((inst) => inst.vehicleNo.toLowerCase() === vehicleNo.toLowerCase())) {
      errors.push(`Row ${rowNo}: duplicate vehicle ${vehicleNo}`);
      continue;
    }
    if (allInstalls.some((inst) => activeImeiMatches(inst, imei))) {
      errors.push(`Row ${rowNo}: duplicate IMEI ${imei}`);
      continue;
    }

    const createdAt = normalizeDate(row.created_at);
    const newInstall = {
      id: generateId(),
      vehicleNo,
      gpsModel,
      macId,
      sensorNo,
      secondarySim: row.secondary_sim || null,
      imeiHistory: [{ value: imei, addedAt: createdAt, active: true }],
      simHistory: [{ value: simNo, addedAt: createdAt, active: true, pendingDeactivation: false }],
      createdAt,
      createdBy: row.created_by || "admin",
    };

    try {
      const saved = await insertInstallation(newInstall);
      allInstalls.push(saved);
      imported += 1;
    } catch (err) {
      errors.push(`Row ${rowNo}: ${err.message}`);
    }
  }

  await refreshAllData();
  render();
  showToast(`${imported} installation${imported === 1 ? "" : "s"} uploaded.${errors.length ? ` ${errors.length} skipped.` : ""}`, imported === 0);
  if (errors.length) showImportReport(errors);
}

async function importRepairs(file) {
  const rows = await readXlsxFile(file);
  if (!rows.length) {
    showToast("Upload file is empty.", true);
    return;
  }

  let imported = 0;
  const errors = [];
  const localInstalls = loadInstallations().map((inst) => ({
    ...inst,
    imeiHistory: inst.imeiHistory.map((item) => ({ ...item })),
    simHistory: inst.simHistory.map((item) => ({ ...item })),
  }));
  const findLocalByImei = (imei) => {
    const q = imei.trim().toLowerCase();
    return localInstalls.find((inst) => inst.imeiHistory.some((i) => i.value.toLowerCase() === q));
  };

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const imei = row.imei;
    const wiringConnection = normalizeBool(row.wiring_connection || row.wiring);
    const simChange = normalizeBool(row.sim_change);
    const deviceChange = normalizeBool(row.device_change);
    const sensorOutForRepair = normalizeBool(row.sensor_out_for_repair);
    const sensorChanged = normalizeBool(row.sensor_changed);
    const deviceOutForRepair = normalizeBool(row.device_out_for_repair);
    const otherWorkText = row.other_work_text || row.other || "";
    const newSimNo = row.new_sim_no || row.new_sim || "";
    const newImei = row.new_imei || "";

    if (!imei) {
      errors.push(`Row ${rowNo}: IMEI is required`);
      continue;
    }
    if (!wiringConnection && !simChange && !deviceChange && !sensorOutForRepair && !sensorChanged && !deviceOutForRepair && !otherWorkText) {
      errors.push(`Row ${rowNo}: select at least one repair work type`);
      continue;
    }
    if (simChange && !newSimNo) {
      errors.push(`Row ${rowNo}: new_sim_no is required for SIM change`);
      continue;
    }
    if (deviceChange && !newImei) {
      errors.push(`Row ${rowNo}: new_imei is required for device change`);
      continue;
    }

    const inst = findLocalByImei(imei);
    if (!inst) {
      errors.push(`Row ${rowNo}: IMEI ${imei} not found in installations`);
      continue;
    }

    const createdAt = normalizeDate(row.created_at);
    const currentSim = getCurrentSim(inst);
    const currentImei = getCurrentImei(inst);
    let oldSimNo = null;
    let oldImei = null;
    let simDeactivationPending = false;

    if (simChange) {
      oldSimNo = currentSim;
      inst.simHistory.forEach((item) => {
        if (item.active) item.pendingDeactivation = true;
      });
      inst.simHistory.push({ value: newSimNo, addedAt: createdAt, active: true, pendingDeactivation: false });
      simDeactivationPending = true;
    }
    if (deviceChange) {
      oldImei = currentImei;
      inst.imeiHistory.forEach((item) => {
        item.active = false;
      });
      inst.imeiHistory.push({ value: newImei, addedAt: createdAt, active: true });
    }

    const newRecord = {
      id: generateId(),
      installationId: inst.id,
      imei: currentImei,
      vehicleNo: inst.vehicleNo,
      wiringConnection,
      simChange,
      newSimNo: simChange ? newSimNo : null,
      deviceChange,
      newImei: deviceChange ? newImei : null,
      sensorOutForRepair,
      sensorChanged,
      deviceOutForRepair,
      otherWorkText: otherWorkText || null,
      oldSimNo,
      oldImei,
      simDeactivationPending,
      simDeactivated: false,
      simDeactivatedAt: null,
      tasks: buildTasksForRepair({ simChange, deviceChange, deviceOutForRepair, sensorOutForRepair }),
      createdAt,
      createdBy: row.created_by || "admin",
    };

    try {
      await updateInstallation(inst);
      await insertMaintenanceRecord(newRecord);
      imported += 1;
    } catch (err) {
      errors.push(`Row ${rowNo}: ${err.message}`);
    }
  }

  await refreshAllData();
  render();
  showToast(`${imported} repair record${imported === 1 ? "" : "s"} uploaded.${errors.length ? ` ${errors.length} skipped.` : ""}`, imported === 0);
  if (errors.length) showImportReport(errors);
}

function showImportReport(errors) {
  showModal(`
    <h3>Upload report</h3>
    <p class="modal-desc">Some rows were skipped. Please fix these rows and upload again.</p>
    <div class="import-errors">${errors.map((error) => `<div>${escapeHtml(error)}</div>`).join("")}</div>
    <div class="modal-actions"><button type="button" class="btn btn-primary modal-close">OK</button></div>
  `);
}

/* ---------------- Installation editing (admin) ---------------- */

function openEditInstallation(id) {
  const inst = loadInstallations().find((i) => i.id === id);
  if (!inst) return;

  showModal(
    `
    <h3>Edit Installation</h3>
    <p class="modal-desc">Fix details for <strong>${escapeHtml(inst.vehicleNo)}</strong>. IMEI / primary SIM history are managed through repair work.</p>
    <div class="edit-grid">
      <div class="field"><label for="editVehicle">Vehicle No</label><input type="text" id="editVehicle" value="${escapeHtml(inst.vehicleNo)}" autocomplete="off" /></div>
      <div class="field"><label for="editModel">GPS Model</label><input type="text" id="editModel" value="${escapeHtml(inst.gpsModel)}" autocomplete="off" /></div>
      <div class="field"><label for="editMac">MAC ID</label><input type="text" id="editMac" value="${escapeHtml(inst.macId)}" autocomplete="off" /></div>
      <div class="field"><label for="editSensor">Sensor No</label><input type="text" id="editSensor" value="${escapeHtml(inst.sensorNo)}" autocomplete="off" /></div>
      <div class="field full-width"><label for="editSecondarySim">Secondary SIM No <span class="field-tag">admin only</span></label><input type="text" id="editSecondarySim" value="${escapeHtml(inst.secondarySim || "")}" placeholder="Optional backup / 2nd SIM" autocomplete="off" inputmode="numeric" /></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      <button type="button" class="btn btn-primary modal-confirm">Save changes</button>
    </div>
    `,
    async () => {
      const vehicleNo = document.getElementById("editVehicle").value.trim();
      const gpsModel = document.getElementById("editModel").value.trim();
      const macId = document.getElementById("editMac").value.trim();
      const sensorNo = document.getElementById("editSensor").value.trim();
      const secondarySim = document.getElementById("editSecondarySim").value.trim();

      if (!vehicleNo || !gpsModel || !macId || !sensorNo) {
        showToast("Vehicle, model, MAC and sensor are required.", true);
        return false;
      }
      const clash = loadInstallations().some((i) => i.id !== inst.id && i.vehicleNo.toLowerCase() === vehicleNo.toLowerCase());
      if (clash) {
        showToast("Another installation already uses that vehicle number.", true);
        return false;
      }

      const updated = { ...inst, vehicleNo, gpsModel, macId, sensorNo, secondarySim: secondarySim || null };
      try {
        await updateInstallation(updated);
        await refreshAllData();
        showToast("Installation updated.");
        render();
        return true;
      } catch (err) {
        showToast(err.message || "Failed to update installation.", true);
        return false;
      }
    }
  );
}

/* ---------------- Pending actions card ---------------- */

function renderPendingActions() {
  const totalPending = getPendingActionRows().length;

  // Every task (pending + completed), grouped by vehicle.
  const groupsMap = new Map();
  let anyTask = false;
  for (const record of loadMaintenance()) {
    for (const task of getTasks(record)) {
      anyTask = true;
      const key = record.installationId || `veh:${record.vehicleNo}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          vehicleNo: record.vehicleNo,
          installationId: record.installationId,
          latest: record.createdAt,
          items: [],
        });
      }
      const g = groupsMap.get(key);
      g.items.push({ record, task });
      if (new Date(record.createdAt) > new Date(g.latest)) g.latest = record.createdAt;
    }
  }
  if (!anyTask) return "";

  const counts = { Portal: 0, SIM: 0, Device: 0, Sensor: 0 };
  getPendingActionRows().forEach((r) => {
    const cat = taskFlow(r.task.type)?.category;
    if (cat in counts) counts[cat] += 1;
  });

  const chip = (key, label) =>
    `<button type="button" class="filter-chip ${pendingFilter === key ? "active" : ""}" data-filter="${key}">${label}</button>`;

  let groups = [...groupsMap.values()];

  // Category filter applies to which tasks are shown.
  if (pendingFilter !== "all") {
    groups = groups
      .map((g) => ({ ...g, items: g.items.filter((it) => taskFlow(it.task.type)?.category === pendingFilter) }))
      .filter((g) => g.items.length);
  }

  // A group is "active" if it still has a pending task. By default only
  // active groups show (so completed tasks stay visible alongside their
  // still-pending siblings, but fully-done vehicles drop off). The toggle
  // reveals fully-completed vehicles too.
  let visibleGroups = groups.filter((g) => showCompleted || g.items.some((it) => !isTaskDone(it.task)));
  visibleGroups.sort((a, b) => new Date(b.latest) - new Date(a.latest));

  const taskRow = (record, task) => {
    const flow = taskFlow(task.type);
    const done = isTaskDone(task);
    const action = done
      ? `<div class="vg-task-done">
           <span class="badge badge-ok">✓ Completed${task.completedAt ? " · " + escapeHtml(formatDateTime(task.completedAt)) : ""}</span>
           <button type="button" class="btn btn-outline btn-sm task-undo" data-record="${record.id}" data-task="${escapeHtml(task.id)}">↩ Undo</button>
         </div>`
      : `<div class="vg-task-pending">
           <span class="badge badge-warn">Pending</span>
           <button type="button" class="btn btn-primary btn-sm task-complete" data-record="${record.id}" data-task="${escapeHtml(task.id)}">✓ Complete</button>
         </div>`;
    const remarkLine = task.remark
      ? `<div class="vg-task-remark has-remark">
           <span class="remark-icon">📝</span>
           <span class="remark-text">${escapeHtml(task.remark)}</span>
           ${task.remarkBy ? `<span class="remark-meta">— ${escapeHtml(task.remarkBy)}</span>` : ""}
           <button type="button" class="remark-btn task-remark" data-record="${record.id}" data-task="${escapeHtml(task.id)}">Edit</button>
         </div>`
      : `<div class="vg-task-remark">
           <button type="button" class="remark-btn task-remark" data-record="${record.id}" data-task="${escapeHtml(task.id)}">+ Add remark</button>
         </div>`;
    return `
      <div class="vg-task ${done ? "is-done" : ""}">
        <div class="vg-task-body">
          <div class="vg-task-main">
            <span class="action-icon">${flow.icon}</span>
            <span class="vg-task-label">${escapeHtml(flow.label)}</span>
            <span class="vg-task-detail">${taskDetail(record, task)}</span>
            <span class="vg-task-date">${escapeHtml(formatDateTime(record.createdAt))}</span>
          </div>
          ${remarkLine}
        </div>
        ${action}
      </div>`;
  };

  const groupsHtml = visibleGroups
    .map((g) => {
      const inst =
        loadInstallations().find((i) => i.id === g.installationId) ||
        loadInstallations().find((i) => i.vehicleNo.toLowerCase() === (g.vehicleNo || "").toLowerCase());
      const editBtn = inst
        ? `<button type="button" class="btn btn-outline btn-sm vg-edit" data-inst="${inst.id}">✎ Edit installation</button>`
        : "";
      const pendingItems = g.items.filter((it) => !isTaskDone(it.task));
      const doneItems = g.items.filter((it) => isTaskDone(it.task));
      const ordered = [...pendingItems, ...doneItems];
      const tasksHtml = ordered.map(({ record, task }) => taskRow(record, task)).join("");
      const doneBadge = doneItems.length ? `<span class="vg-count done">${doneItems.length} done</span>` : "";
      const pendBadge = pendingItems.length
        ? `<span class="vg-count">${pendingItems.length} pending</span>`
        : `<span class="vg-count all-done">All done</span>`;
      return `
        <div class="vehicle-group">
          <div class="vehicle-group-head">
            <div class="vg-head-left">
              <span class="vg-name">${escapeHtml(g.vehicleNo)}</span>
              ${pendBadge}
              ${doneBadge}
            </div>
            ${editBtn}
          </div>
          <div class="vg-tasks">${tasksHtml}</div>
        </div>`;
    })
    .join("");

  const emptyMsg = showCompleted
    ? "No actions match this filter."
    : totalPending === 0
    ? "🎉 All actions completed. Toggle “Show completed” to review history."
    : `No pending ${pendingFilter === "all" ? "" : pendingFilter + " "}actions.`;

  return `
    <section class="card alert-card">
      <div class="section-heading">
        <div>
          <h2>⚠️ Pending Actions (${totalPending})</h2>
          <p class="alert-desc">Grouped by vehicle. Tap <strong>Complete</strong> when a task is done — it stays here marked completed (use Undo to reopen).</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="exportPending">⬇ Export</button>
      </div>
      <div class="pending-filter">
        ${chip("all", `All ${totalPending}`)}
        ${chip("Portal", `GPS Portal ${counts.Portal}`)}
        ${chip("SIM", `SIM ${counts.SIM}`)}
        ${chip("Device", `Device ${counts.Device}`)}
        ${chip("Sensor", `Sensor ${counts.Sensor}`)}
        <button type="button" class="filter-chip toggle-chip ${showCompleted ? "active" : ""}" id="toggleCompleted">
          ${showCompleted ? "✓ " : ""}Show completed
        </button>
      </div>
      ${visibleGroups.length ? groupsHtml : `<p class="muted">${emptyMsg}</p>`}
    </section>
  `;
}

/* ---------------- Vehicle timeline page ---------------- */

function buildVehicleTimeline(inst) {
  const events = [{ type: "install", date: inst.createdAt, by: inst.createdBy, inst }];
  loadMaintenance()
    .filter(
      (m) =>
        m.installationId === inst.id ||
        m.vehicleNo.toLowerCase() === inst.vehicleNo.toLowerCase()
    )
    .forEach((m) => events.push({ type: "repair", date: m.createdAt, by: m.createdBy, record: m }));
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  return events;
}

function renderTimeline() {
  const q = timelineQuery.toLowerCase().trim();
  const allInstalls = loadInstallations();

  let matches = allInstalls.filter((inst) => {
    if (!q) return true;
    const hay = [
      inst.vehicleNo,
      inst.gpsModel,
      inst.secondarySim || "",
      ...inst.imeiHistory.map((h) => h.value),
      ...inst.simHistory.map((s) => s.value),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  // Most recently active vehicles first.
  const lastActivity = (inst) => {
    const ev = buildVehicleTimeline(inst);
    return ev.length ? ev[ev.length - 1].date : inst.createdAt;
  };
  matches.sort((a, b) => new Date(lastActivity(b)) - new Date(lastActivity(a)));

  const CAP = 40;
  const shown = matches.slice(0, CAP);
  const more = matches.length - shown.length;

  const cardsHtml = shown
    .map((inst) => {
      const events = buildVehicleTimeline(inst);
      const eventsHtml = events
        .map((ev) => {
          if (ev.type === "install") {
            const i = ev.inst;
            const detail = `IMEI ${i.imeiHistory[0]?.value || "—"} · SIM ${i.simHistory[0]?.value || "—"} · ${escapeHtml(i.gpsModel)} · MAC ${escapeHtml(i.macId)} · Sensor ${escapeHtml(i.sensorNo)}`;
            return `
              <li class="tl-event tl-install">
                <span class="tl-dot"></span>
                <div class="tl-body">
                  <div class="tl-title"><span class="badge badge-ok">Installed</span></div>
                  <div class="tl-detail">${detail}</div>
                  <div class="tl-date">${escapeHtml(formatDateTime(ev.date))}${ev.by ? " · by " + escapeHtml(ev.by) : ""}</div>
                </div>
              </li>`;
          }
          const m = ev.record;
          return `
            <li class="tl-event tl-repair">
              <span class="tl-dot"></span>
              <div class="tl-body">
                <div class="tl-title"><span class="badge badge-repair">Repair</span></div>
                <div class="tl-detail">${escapeHtml(workLabels(m))}</div>
                <div class="tl-date">${escapeHtml(formatDateTime(ev.date))}${m.createdBy ? " · by " + escapeHtml(m.createdBy) : ""}</div>
              </div>
            </li>`;
        })
        .join("");

      const curImei = getCurrentImei(inst);
      const curSim = getCurrentSim(inst);
      return `
        <div class="timeline-card">
          <div class="timeline-head">
            <div class="vg-head-left">
              <span class="vg-name">${escapeHtml(inst.vehicleNo)}</span>
              <span class="tl-count">${events.length} event${events.length === 1 ? "" : "s"}</span>
            </div>
            <div class="tl-meta">
              <span class="mono">${escapeHtml(curImei)}</span> · SIM <span class="mono">${escapeHtml(curSim)}</span>
            </div>
          </div>
          <ol class="timeline">${eventsHtml}</ol>
        </div>`;
    })
    .join("");

  app.innerHTML = `
    ${renderHeader("Vehicle Timeline", "Installation & repair history per vehicle")}
    <main class="main">
      ${renderAdminNav("timeline")}
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>Vehicle Timeline</h2>
            <p class="section-subtitle">Search or pick a vehicle to see when it was installed and every repair since.</p>
          </div>
        </div>
        <div class="timeline-search">
          <input type="search" id="timelineSearch" list="tlVehicles" placeholder="Search or select vehicle (name, IMEI, SIM)..." value="${escapeHtml(timelineQuery)}" autocomplete="off" />
          <datalist id="tlVehicles">
            ${allInstalls.map((i) => `<option value="${escapeHtml(i.vehicleNo)}">${escapeHtml(getCurrentImei(i))}</option>`).join("")}
          </datalist>
          ${timelineQuery ? `<button type="button" class="btn btn-secondary btn-sm" id="timelineClear">Clear</button>` : ""}
        </div>
        <p class="section-subtitle tl-resultcount">${matches.length} vehicle${matches.length === 1 ? "" : "s"}${more > 0 ? ` · showing first ${CAP}, narrow your search to see the rest` : ""}</p>
        ${shown.length ? cardsHtml : `<p class="muted">No vehicles match "${escapeHtml(timelineQuery)}".</p>`}
      </section>
    </main>
  `;

  bindLogout();
  bindAdminNav();

  const searchEl = document.getElementById("timelineSearch");
  searchEl?.addEventListener("input", (e) => {
    timelineQuery = e.target.value;
    // Re-render but keep focus + caret on the search box.
    render();
    const el = document.getElementById("timelineSearch");
    if (el) {
      el.focus();
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
    }
  });
  document.getElementById("timelineClear")?.addEventListener("click", () => {
    timelineQuery = "";
    setView("timeline");
  });
}

/* ============================================================
   ADMIN PAGE FRAMEWORK
   ============================================================ */

const ADMIN_NAV = [
  { key: "dashboard", label: "📋 Dashboard", view: "dashboard" },
  { key: "installations", label: "🔧 Installations", view: "installations" },
  { key: "repairs", label: "🛠️ Repair Work", view: "repairs" },
  { key: "pending", label: "⚠️ Pending Work", view: "pending" },
  { key: "sim-upload", label: "⬆️ SIM Upload", view: "sim-upload" },
  { key: "sim-db", label: "📶 SIM Database", view: "sim-db" },
  { key: "stock", label: "📦 Stock", view: "stock" },
  { key: "timeline", label: "📅 Timeline", view: "timeline" },
];

function renderAdminNav(activeKey) {
  return `<div class="admin-nav">${ADMIN_NAV.map(
    (n) =>
      `<button type="button" class="nav-pill ${n.key === activeKey ? "active" : ""}" data-nav="${n.view}">${n.label}</button>`
  ).join("")}</div>`;
}

function bindAdminNav() {
  app.querySelectorAll(".nav-pill[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.nav));
  });
}

/* ---------------- Page 1: Dashboard ---------------- */

function renderDashboard() {
  const allInstalls = loadInstallations();
  const allMaint = loadMaintenance();
  const pendingCount = getPendingActionRows().length;
  const allSims = loadSims();
  const pendingPrimary = allSims.filter((s) => !s.primaryNumber).length;
  const allStock = loadStockItems();
  const lowStock = allStock.filter(
    (i) => i.lowStockThreshold != null && i.quantity <= i.lowStockThreshold
  ).length;

  app.innerHTML = `
    ${renderHeader("Dashboard", "Fleet overview")}
    <main class="main">
      ${renderAdminNav("dashboard")}
      <div class="dash-grid">
        <button type="button" class="dash-card" data-go="installations">
          <span class="dash-num">${allInstalls.length}</span>
          <span class="dash-label">Installations</span>
          <span class="dash-go">View all →</span>
        </button>
        <button type="button" class="dash-card" data-go="repairs">
          <span class="dash-num">${allMaint.length}</span>
          <span class="dash-label">Repair Records</span>
          <span class="dash-go">View all →</span>
        </button>
        <button type="button" class="dash-card ${pendingCount ? "warn" : "ok"}" data-go="pending">
          <span class="dash-num">${pendingCount}</span>
          <span class="dash-label">Pending Actions</span>
          <span class="dash-go">${pendingCount ? "Resolve →" : "All clear ✓"}</span>
        </button>
        <button type="button" class="dash-card" data-go="sim-db">
          <span class="dash-num">${allSims.length}</span>
          <span class="dash-label">SIMs in database${pendingPrimary ? ` · ${pendingPrimary} pending primary` : ""}</span>
          <span class="dash-go">View SIM database →</span>
        </button>
        <button type="button" class="dash-card ${lowStock ? "warn" : ""}" data-go="stock">
          <span class="dash-num">${allStock.length}</span>
          <span class="dash-label">Stock items${lowStock ? ` · ${lowStock} low` : ""}</span>
          <span class="dash-go">View stock →</span>
        </button>
      </div>
    </main>
  `;
  bindLogout();
  bindAdminNav();
  app.querySelectorAll(".dash-card[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.go));
  });
}

/* ---------------- Page 2: Installations ---------------- */

function renderInstallationsPage() {
  const allInstalls = loadInstallations();
  const q = searchQuery.toLowerCase().trim();
  const filtered = allInstalls.filter((i) => {
    if (!q) return true;
    const hay = [
      i.vehicleNo,
      i.gpsModel,
      i.macId,
      i.sensorNo,
      i.secondarySim || "",
      ...i.imeiHistory.map((h) => h.value),
      ...i.simHistory.map((s) => s.value),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  app.innerHTML = `
    ${renderHeader("Installations", `${allInstalls.length} vehicles registered`)}
    <main class="main">
      ${renderAdminNav("installations")}
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All Installations (${allInstalls.length})</h2>
            <p class="section-subtitle">Every GPS device installed on the fleet. Use Edit to fix typos in vehicle / model / MAC / sensor.</p>
          </div>
        </div>
        <div class="list-tools admin-search">
          <input type="search" id="adminSearch" placeholder="Search vehicle, IMEI, SIM, MAC..." value="${escapeHtml(searchQuery)}" />
        </div>
        <div class="bulk-panel">
          <div>
            <h3>Bulk Installation Upload</h3>
            <p>Download the installation sample, fill old records, then upload the Excel file.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="downloadSample">↓ Download sample file</button>
            <label class="btn btn-primary btn-sm upload-label" for="bulkUpload">↑ Upload filled file</label>
            <input class="hidden" type="file" id="bulkUpload" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Vehicle</th><th>GPS Model</th><th>MAC ID</th><th>Sensor</th><th>IMEI History</th><th>SIM History</th><th></th></tr></thead>
            <tbody>
              ${
                filtered.length
                  ? filtered
                      .map(
                        (i) => `
                <tr>
                  <td class="date-cell">${escapeHtml(formatDateTime(i.createdAt))}</td>
                  <td>${escapeHtml(i.vehicleNo)}</td>
                  <td>${escapeHtml(i.gpsModel)}</td>
                  <td class="mono">${escapeHtml(i.macId)}</td>
                  <td class="mono">${escapeHtml(i.sensorNo)}</td>
                  <td class="history-cell">${historyList(i.imeiHistory)}</td>
                  <td class="history-cell">${simHistoryCell(i)}</td>
                  <td><button type="button" class="btn btn-outline btn-sm edit-btn" data-id="${i.id}">Edit</button></td>
                </tr>`
                      )
                      .join("")
                  : `<tr class="empty-row"><td colspan="8">No installations found.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();
  document.getElementById("adminSearch")?.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });
  document.getElementById("downloadSample")?.addEventListener("click", downloadInstallationSample);
  document.getElementById("bulkUpload")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ok = await showConfirm({
      title: "Confirm upload",
      message: "Upload installation records from this Excel file?",
      confirmLabel: "Upload",
    });
    if (!ok) return;
    renderLoading("Uploading data to Supabase...");
    try {
      await importInstallations(file);
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Upload failed.", true);
    }
  });
  app.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditInstallation(btn.dataset.id));
  });
}

/* ---------------- Page 3: Repair Work ---------------- */

function renderRepairsPage() {
  const allMaint = loadMaintenance();
  const q = searchQuery.toLowerCase().trim();
  const filtered = allMaint.filter((m) => {
    if (!q) return true;
    return [m.imei, m.vehicleNo, m.newSimNo, m.newImei, workLabels(m)]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  app.innerHTML = `
    ${renderHeader("Repair Work", `${allMaint.length} repair records`)}
    <main class="main">
      ${renderAdminNav("repairs")}
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All Repair Work (${allMaint.length})</h2>
            <p class="section-subtitle">Every repair / maintenance entry from the field, with pending follow-up status.</p>
          </div>
        </div>
        <div class="list-tools admin-search">
          <input type="search" id="adminSearch" placeholder="Search vehicle, IMEI, SIM, work..." value="${escapeHtml(searchQuery)}" />
        </div>
        <div class="bulk-panel">
          <div>
            <h3>Bulk Repair Upload</h3>
            <p>Download the repair sample, fill old repair work records, then upload the Excel file.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="downloadSample">↓ Download sample file</button>
            <label class="btn btn-primary btn-sm upload-label" for="bulkUpload">↑ Upload filled file</label>
            <input class="hidden" type="file" id="bulkUpload" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Vehicle</th><th>IMEI</th><th>Work Done</th><th>Status</th></tr></thead>
            <tbody>
              ${
                filtered.length
                  ? filtered
                      .map(
                        (m) => `
                <tr>
                  <td class="date-cell">${escapeHtml(formatDateTime(m.createdAt))}</td>
                  <td>${escapeHtml(m.vehicleNo)}</td>
                  <td class="mono">${escapeHtml(m.imei)}</td>
                  <td>${escapeHtml(workLabels(m))}</td>
                  <td class="status-cell">${getMaintenanceStatus(m)}</td>
                </tr>`
                      )
                      .join("")
                  : `<tr class="empty-row"><td colspan="5">No repair records found.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();
  document.getElementById("adminSearch")?.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });
  document.getElementById("downloadSample")?.addEventListener("click", downloadRepairSample);
  document.getElementById("bulkUpload")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ok = await showConfirm({
      title: "Confirm upload",
      message: "Upload repair work records from this Excel file?",
      confirmLabel: "Upload",
    });
    if (!ok) return;
    renderLoading("Uploading data to Supabase...");
    try {
      await importRepairs(file);
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Upload failed.", true);
    }
  });
}

/* ---------------- Page 4: Pending Work ---------------- */

function renderPendingPage() {
  const pendingCount = getPendingActionRows().length;
  const pendingHtml = renderPendingActions();

  app.innerHTML = `
    ${renderHeader("Pending Work", `${pendingCount} follow-up actions`)}
    <main class="main">
      ${renderAdminNav("pending")}
      ${pendingHtml || `<section class="card"><h2>🎉 All caught up</h2><p class="alert-desc">No pending actions right now. New repair entries will show up here automatically.</p></section>`}
    </main>
  `;
  bindLogout();
  bindAdminNav();

  // Wire all the existing pending-action handlers.
  app.querySelectorAll(".filter-chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      pendingFilter = chip.dataset.filter;
      render();
    });
  });
  app.querySelectorAll(".task-complete").forEach((btn) => {
    btn.addEventListener("click", () => completeTask(btn.dataset.record, btn.dataset.task));
  });
  app.querySelectorAll(".task-undo").forEach((btn) => {
    btn.addEventListener("click", () => undoTask(btn.dataset.record, btn.dataset.task));
  });
  app.querySelectorAll(".task-remark").forEach((btn) => {
    btn.addEventListener("click", () => openRemarkEditor(btn.dataset.record, btn.dataset.task));
  });
  document.getElementById("toggleCompleted")?.addEventListener("click", () => {
    showCompleted = !showCompleted;
    render();
  });
  document.getElementById("exportPending")?.addEventListener("click", exportPendingActions);
  app.querySelectorAll(".vg-edit").forEach((btn) => {
    btn.addEventListener("click", () => openEditInstallation(btn.dataset.inst));
  });
}

/* ---------------- Page 5: SIM Upload ---------------- */

function renderSimUpload() {
  const allInstalls = loadInstallations();
  const missingSec = allInstalls.filter((i) => !i.secondarySim).length;

  app.innerHTML = `
    ${renderHeader("SIM Upload", "Add secondary SIM numbers")}
    <main class="main">
      ${renderAdminNav("sim-upload")}
      <div class="summary-grid">
        <div class="summary-box"><strong>${allInstalls.length}</strong><span>Installations</span></div>
        <div class="summary-box ${missingSec ? "summary-warn" : ""}"><strong>${missingSec}</strong><span>Missing secondary</span></div>
      </div>

      <section class="card">
        <div class="section-heading">
          <div>
            <h2>📋 Quick Paste — Secondary SIMs</h2>
            <p class="section-subtitle">Excel skip karo. Primary SIMs ek box me paste karo, secondary SIMs doosre me — line-by-line pair ho jaayenge. 20-digit ICCIDs poore digits ke saath bachenge.</p>
          </div>
        </div>
        <div class="paste-grid">
          <div class="field">
            <label for="pastePrimary">Primary SIM numbers <span class="paste-count" id="primaryCount">0 lines</span></label>
            <textarea id="pastePrimary" rows="10" placeholder="5753200309565&#10;5753200309623&#10;5753200322950&#10;..." spellcheck="false"></textarea>
          </div>
          <div class="field">
            <label for="pasteSecondary">Secondary SIM numbers (ICCIDs) <span class="paste-count" id="secondaryCount">0 lines</span></label>
            <textarea id="pasteSecondary" rows="10" placeholder="89918720507069157022&#10;89918720507069156917&#10;89918720507069153161&#10;..." spellcheck="false"></textarea>
          </div>
        </div>
        <div class="paste-preview" id="pastePreview">Paste data to preview pairs.</div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="pasteClear">Clear</button>
          <button type="button" class="btn btn-primary" id="pasteUpload">↑ Upload pairs</button>
        </div>
      </section>

      <section class="card">
        <div class="section-heading">
          <div>
            <h2>📁 Excel Upload (alternative)</h2>
            <p class="section-subtitle">Prefer Excel? Download the sample (SIM columns pre-formatted as Text), fill <code>primary_sim, secondary_sim</code> columns, then upload.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="simSampleDl">↓ Sample file</button>
            <label class="btn btn-primary btn-sm upload-label" for="simBulkUpload">↑ Bulk upload</label>
            <input class="hidden" type="file" id="simBulkUpload" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
          </div>
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();

  // Quick paste wiring (same logic as the SIM database page used to have).
  const primaryEl = document.getElementById("pastePrimary");
  const secondaryEl = document.getElementById("pasteSecondary");
  const primaryCntEl = document.getElementById("primaryCount");
  const secondaryCntEl = document.getElementById("secondaryCount");
  const previewEl = document.getElementById("pastePreview");

  function splitPasteLines(text) {
    const lines = (text || "").split(/\r?\n/).map((s) => s.trim());
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  function refreshPastePreview() {
    if (!primaryEl || !secondaryEl) return;
    const primaries = splitPasteLines(primaryEl.value);
    const secondaries = splitPasteLines(secondaryEl.value);
    primaryCntEl.textContent = `${primaries.length} line${primaries.length === 1 ? "" : "s"}`;
    secondaryCntEl.textContent = `${secondaries.length} line${secondaries.length === 1 ? "" : "s"}`;
    if (!primaries.length && !secondaries.length) {
      previewEl.textContent = "Paste data to preview pairs.";
      previewEl.className = "paste-preview";
      return;
    }
    if (primaries.length !== secondaries.length) {
      previewEl.textContent = `⚠️ Line count mismatch — ${primaries.length} primary vs ${secondaries.length} secondary. Each row must align.`;
      previewEl.className = "paste-preview warn";
      return;
    }
    const first = primaries
      .slice(0, 3)
      .map((p, i) => `${p} → ${secondaries[i] || "(clear)"}`)
      .join("  ·  ");
    previewEl.textContent = `✓ ${primaries.length} pairs ready. Preview: ${first}${primaries.length > 3 ? "  ..." : ""}`;
    previewEl.className = "paste-preview ok";
  }
  primaryEl?.addEventListener("input", refreshPastePreview);
  secondaryEl?.addEventListener("input", refreshPastePreview);
  document.getElementById("pasteClear")?.addEventListener("click", () => {
    if (primaryEl) primaryEl.value = "";
    if (secondaryEl) secondaryEl.value = "";
    refreshPastePreview();
  });
  document.getElementById("pasteUpload")?.addEventListener("click", async () => {
    const primaries = splitPasteLines(primaryEl?.value || "");
    const secondaries = splitPasteLines(secondaryEl?.value || "");
    if (!primaries.length || !secondaries.length) {
      showToast("Paste data in both boxes first.", true);
      return;
    }
    if (primaries.length !== secondaries.length) {
      showToast(
        `Line count mismatch: ${primaries.length} primary vs ${secondaries.length} secondary.`,
        true
      );
      return;
    }
    const ok = await showConfirm({
      title: "Upload pairs?",
      message: `Save ${primaries.length} SIM pair${primaries.length === 1 ? "" : "s"} to the SIM database?`,
      confirmLabel: "Upload",
    });
    if (!ok) return;

    const total = primaries.length;
    renderLoading(`Saving SIMs to database... 0/${total}`);
    let saved = 0;
    const errors = [];

    // Helper to update the loading message in place without re-rendering.
    function updateProgress(done) {
      const el = document.querySelector(".loading-card p");
      if (el) el.textContent = `Saving SIMs to database... ${done}/${total}`;
      const sub = document.querySelector(".app-title-sub, .header-sub");
      if (sub) sub.textContent = `Saving SIMs to database... ${done}/${total}`;
    }

    try {
      for (let i = 0; i < total; i += 1) {
        const primary = primaries[i];
        const secondary = secondaries[i];
        const rowNo = i + 1;
        if (!secondary) {
          errors.push(`Row ${rowNo}: secondary (ICCID) blank — skipped`);
          updateProgress(i + 1);
          continue;
        }
        try {
          await withTimeout(
            upsertSim({
              primaryNumber: primary || null,
              secondaryNumber: secondary,
            }),
            10000,
            `Row ${rowNo} upsert`
          );
          saved += 1;
        } catch (err) {
          if (err.code === SIMS_TABLE_MISSING) {
            errors.push(`Row ${rowNo}: sims table missing — run sims-table-migration.sql in Supabase first`);
          } else {
            errors.push(`Row ${rowNo}: ${err.message}`);
          }
        }
        updateProgress(i + 1);
      }

      // Navigate first so the user sees the new SIM Database, then refresh
      // in the background. This avoids a long extra wait on the spinner.
      setView("sim-db");
      try {
        await refreshAllData();
        render();
      } catch (err) {
        console.warn("Post-upload refresh failed (will catch up on next realtime tick):", err);
      }
      showToast(
        `${saved} SIM${saved === 1 ? "" : "s"} saved.${errors.length ? ` ${errors.length} skipped.` : ""}`,
        saved === 0
      );
      if (errors.length) showImportReport(errors);
    } catch (err) {
      // Catch-all so the loading screen never sticks.
      console.error("SIM upload failed:", err);
      try {
        await refreshAllData();
      } catch (_) {
        /* ignore — we just need to exit the spinner */
      }
      setView("sim-db");
      showToast(err.message || "Upload failed — check console.", true);
    }
  });

  // Excel alternative wiring.
  document.getElementById("simSampleDl")?.addEventListener("click", downloadSimSample);
  document.getElementById("simBulkUpload")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ok = await showConfirm({
      title: "Bulk upload SIMs?",
      message: "Save SIM pairs from this Excel file to the SIM database?",
      confirmLabel: "Upload",
    });
    if (!ok) return;
    renderLoading("Uploading SIMs to database...");
    try {
      await importSimsFromExcel(file);
      setView("sim-db");
    } catch (err) {
      await refreshAllData();
      render();
      const msg = err.message || "Upload failed.";
      showToast(err.code === SIMS_TABLE_MISSING ? "Run sims-table-migration.sql in Supabase first." : msg, true);
    }
  });

  refreshPastePreview();
}

/* ---------------- Page 6: SIM Database (read-only view) ---------------- */

function renderSimDb() {
  if (!simsTableReady) {
    app.innerHTML = `
      ${renderHeader("SIM Database", "Standalone SIM inventory")}
      <main class="main">
        ${renderAdminNav("sim-db")}
        <section class="card">
          <h2>⚙️ Migration needed</h2>
          <p>The new SIM database needs a one-time setup. Open Supabase SQL Editor and run <code>sims-table-migration.sql</code>, then come back here.</p>
          <div class="form-actions" style="margin-top: 1rem;">
            <a class="btn btn-primary" href="https://supabase.com/dashboard/project/jzclmcjurfehpfybxryh/sql/new" target="_blank" rel="noopener">Open SQL Editor →</a>
            <button type="button" class="btn btn-secondary" id="retrySimDb">↻ Reload</button>
          </div>
        </section>
      </main>
    `;
    bindLogout();
    bindAdminNav();
    document.getElementById("retrySimDb")?.addEventListener("click", async () => {
      renderLoading("Checking SIM table...");
      try {
        await refreshAllData();
        render();
      } catch (err) {
        renderConnectionError(err.message);
      }
    });
    return;
  }

  const allSims = loadSims();
  const allInstalls = loadInstallations();

  // Pre-compute which installation is currently using a given SIM (by either
  // primary or secondary value).
  function findUsingInstallation(sim) {
    const primary = (sim.primaryNumber || "").toLowerCase();
    const secondary = (sim.secondaryNumber || "").toLowerCase();
    return allInstalls.find((inst) => {
      return inst.simHistory.some((s) => {
        const v = (s.value || "").toLowerCase();
        const sv = (s.secondaryValue || "").toLowerCase();
        const active = s.active && !s.pendingDeactivation;
        return (
          active &&
          ((v && (v === primary || v === secondary)) ||
            (sv && (sv === primary || sv === secondary)))
        );
      });
    });
  }

  function simStatus(sim) {
    if (!sim.primaryNumber) return { label: "Pending primary", className: "status-warn" };
    const inst = findUsingInstallation(sim);
    if (inst) return { label: `In use · ${inst.vehicleNo}`, className: "status-ok" };
    return { label: "Available", className: "status-muted" };
  }

  const q = simDbQuery.toLowerCase().trim();
  const matches = allSims.filter((s) => {
    if (!q) return true;
    const hay = [s.primaryNumber || "", s.secondaryNumber || "", s.notes || ""]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
  matches.sort((a, b) => {
    // Pending-primary rows first, then alphabetical by secondary.
    const ap = !a.primaryNumber ? 0 : 1;
    const bp = !b.primaryNumber ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.secondaryNumber || "").localeCompare(b.secondaryNumber || "");
  });

  const totalSims = allSims.length;
  const pendingPrimary = allSims.filter((s) => !s.primaryNumber).length;
  const inUseCount = allSims.filter((s) => findUsingInstallation(s)).length;
  const availableCount = totalSims - inUseCount - pendingPrimary;

  const tableHtml = matches.length
    ? matches
        .map((sim) => {
          const status = simStatus(sim);
          const primary = sim.primaryNumber || `<span class="muted">Not set</span>`;
          return `
            <tr>
              <td class="mono">${typeof primary === "string" && primary.startsWith("<") ? primary : escapeHtml(primary)}</td>
              <td class="mono">${escapeHtml(sim.secondaryNumber)}</td>
              <td><span class="sim-status ${status.className}">${escapeHtml(status.label)}</span></td>
              <td>${escapeHtml(sim.notes || "")}</td>
              <td class="date-cell">${escapeHtml(formatDateTime(sim.createdAt))}</td>
              <td class="row-actions">
                <button type="button" class="btn btn-outline btn-sm sim-row-edit" data-id="${sim.id}">✎ Edit</button>
                <button type="button" class="btn btn-danger btn-sm sim-row-delete" data-id="${sim.id}">Delete</button>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr class="empty-row"><td colspan="6">${q ? `No SIMs match "${escapeHtml(simDbQuery)}".` : "No SIMs in the database yet. Use SIM Upload to add some."}</td></tr>`;

  app.innerHTML = `
    ${renderHeader("SIM Database", "Independent inventory of SIM cards (primary + secondary)")}
    <main class="main">
      ${renderAdminNav("sim-db")}
      <div class="summary-grid">
        <div class="summary-box"><strong>${totalSims}</strong><span>Total SIMs</span></div>
        <div class="summary-box"><strong>${inUseCount}</strong><span>In use</span></div>
        <div class="summary-box"><strong>${availableCount}</strong><span>Available</span></div>
        <div class="summary-box ${pendingPrimary ? "summary-warn" : ""}"><strong>${pendingPrimary}</strong><span>Pending primary</span></div>
      </div>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All SIMs (${totalSims})</h2>
            <p class="section-subtitle">Each SIM card has a primary number (13-digit) and a secondary number (20-digit ICCID). Add SIMs to the database in advance — when Akash uses one in the field, the system auto-links it to a vehicle.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="addSimBtn">+ Add SIM</button>
            <button type="button" class="btn btn-primary btn-sm" data-nav="sim-upload">↑ Bulk upload</button>
          </div>
        </div>
        <div class="list-tools admin-search">
          <input type="search" id="simSearch" placeholder="Search primary, secondary, notes..." value="${escapeHtml(simDbQuery)}" />
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Primary</th><th>Secondary (ICCID)</th><th>Status</th><th>Notes</th><th>Added</th><th></th></tr>
            </thead>
            <tbody>${tableHtml}</tbody>
          </table>
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();

  app.querySelectorAll('[data-nav="sim-upload"]').forEach((btn) => {
    btn.addEventListener("click", () => setView("sim-upload"));
  });

  const searchEl = document.getElementById("simSearch");
  searchEl?.addEventListener("input", (e) => {
    simDbQuery = e.target.value;
    render();
    const el = document.getElementById("simSearch");
    if (el) {
      el.focus();
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
    }
  });

  document.getElementById("addSimBtn")?.addEventListener("click", () => openSimEditor(null));
  app.querySelectorAll(".sim-row-edit").forEach((btn) => {
    btn.addEventListener("click", () => openSimEditor(btn.dataset.id));
  });
  app.querySelectorAll(".sim-row-delete").forEach((btn) => {
    btn.addEventListener("click", () => onDeleteSim(btn.dataset.id));
  });
}

function openSimEditor(simId) {
  const sim = simId ? loadSims().find((s) => s.id === simId) : null;
  modal.innerHTML = `
    <h3>${sim ? "✎ Edit SIM" : "+ Add SIM"}</h3>
    <div class="field">
      <label for="simPrimary">Primary number (13-digit)</label>
      <input type="text" id="simPrimary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 5753200309565" value="${escapeHtml(sim?.primaryNumber || "")}" />
    </div>
    <div class="field">
      <label for="simSecondary">Secondary number / ICCID (20-digit) <span class="required">*</span></label>
      <input type="text" id="simSecondary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 89918720507069156677" value="${escapeHtml(sim?.secondaryNumber || "")}" />
    </div>
    <div class="field">
      <label for="simNotes">Notes (optional)</label>
      <input type="text" id="simNotes" autocomplete="off" placeholder="e.g. Spare batch March 2026" value="${escapeHtml(sim?.notes || "")}" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">${sim ? "Save changes" : "Add SIM"}</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");

  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  modal.querySelector('[data-act="save"]').onclick = async () => {
    const primary = modal.querySelector("#simPrimary").value.trim();
    const secondary = modal.querySelector("#simSecondary").value.trim();
    const notes = modal.querySelector("#simNotes").value.trim() || null;
    if (!secondary) {
      showToast("Secondary number (ICCID) is required.", true);
      return;
    }
    closeModal();
    renderLoading(sim ? "Saving changes..." : "Adding SIM...");
    try {
      if (sim) {
        await updateSim({ id: sim.id, primaryNumber: primary || null, secondaryNumber: secondary, notes });
      } else {
        await upsertSim({ primaryNumber: primary || null, secondaryNumber: secondary, notes });
      }
      await refreshAllData();
      render();
      showToast(sim ? "SIM updated." : "SIM added.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

async function onDeleteSim(simId) {
  const sim = loadSims().find((s) => s.id === simId);
  if (!sim) return;
  const ok = await showConfirm({
    title: "Delete this SIM?",
    message: `Remove SIM (primary: ${sim.primaryNumber || "—"}, secondary: ${sim.secondaryNumber}) from the database? This does not affect existing installation history.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  renderLoading("Deleting SIM...");
  try {
    await deleteSim(simId);
    await refreshAllData();
    render();
    showToast("SIM deleted.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

/* ---------------- Page 7: Timeline (preserved) ---------------- */

/* ---------------- Page 8: Stock Inventory ---------------- */

// Default category list used to seed the DB (also used as fallback if the
// stock_categories migration hasn't been run yet).
const STOCK_CATEGORIES_DEFAULT = [
  "GPS",
  "SIM-AIRTEL",
  "SIM-JIO",
  "Sensor",
  "Roll",
  "Tape",
  "Drill",
  "Drill beat",
];

// Live category options used in dropdowns: admin-managed list from the DB,
// merged with any categories already used by existing items (so categories
// added before the table migration don't disappear).
function getCategoryOptions() {
  const fromDb = stockCategories.map((c) => c.name);
  const fromItems = stockItems.map((i) => i.category).filter(Boolean);
  const merged = stockCategoriesTableReady
    ? Array.from(new Set([...fromDb, ...fromItems]))
    : Array.from(new Set([...STOCK_CATEGORIES_DEFAULT, ...fromItems]));
  return merged.sort();
}

const STOCK_UNITS = ["pcs", "set", "box", "meters", "kg", "liters", "pack"];

// Detect what kind of identifiers this category needs.
function categoryKind(category) {
  if (!category) return "generic";
  const c = String(category).toUpperCase();
  if (c.includes("GPS")) return "gps";
  if (c.includes("SIM")) return "sim";
  if (c.includes("SENSOR")) return "sensor";
  return "generic";
}

// --- Name normalization & fuzzy matching for duplicate prevention ---

// Strip all non-alphanumeric, lowercase. "FMB-02" / "fmb 02" -> "fmb02"
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Lowercase + sort tokens. "02 FMB" / "FMB-02" both -> "02 fmb"
function tokenSorted(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Classic Levenshtein distance — bounded so we exit early for cheap.
function levenshtein(a, b, max = 3) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Find the closest existing item to a typed name. Returns { item, reason } or null.
//   reason = "exact"   -> normalized strings identical
//   reason = "tokens"  -> same words, different order/separator
//   reason = "typo"    -> Levenshtein <= 2 (after normalization)
function findClosestItem(query, excludeId = null) {
  const items = loadStockItems().filter((i) => i.id !== excludeId);
  if (!items.length) return null;
  const qNorm = normalizeName(query);
  if (qNorm.length < 2) return null;
  const qSort = tokenSorted(query);

  for (const it of items) {
    if (normalizeName(it.name) === qNorm) return { item: it, reason: "exact" };
  }
  if (qSort) {
    for (const it of items) {
      if (tokenSorted(it.name) === qSort) return { item: it, reason: "tokens" };
    }
  }
  if (qNorm.length >= 3) {
    let best = null;
    let bestDist = Infinity;
    for (const it of items) {
      const d = levenshtein(qNorm, normalizeName(it.name), 2);
      if (d <= 2 && d < bestDist) {
        bestDist = d;
        best = it;
      }
    }
    if (best) return { item: best, reason: "typo" };
  }
  return null;
}

// Rank items for the suggestion dropdown given a query.
function rankItemSuggestions(query, excludeId = null) {
  const items = loadStockItems().filter((i) => i.id !== excludeId);
  if (!items.length) return [];

  // Sort by createdAt desc so recent items naturally come first.
  const byRecent = [...items].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const q = (query || "").trim();
  if (!q) {
    return byRecent.slice(0, 8).map((it) => ({ item: it, reason: "recent" }));
  }

  const qNorm = normalizeName(q);
  const qSort = tokenSorted(q);

  const scored = byRecent
    .map((it) => {
      const nNorm = normalizeName(it.name);
      const nSort = tokenSorted(it.name);
      let score = 0;
      let reason = "";
      if (nNorm === qNorm) {
        score = 100;
        reason = "exact";
      } else if (nSort === qSort && qSort) {
        score = 90;
        reason = "tokens";
      } else if (nNorm.startsWith(qNorm)) {
        score = 70;
        reason = "starts";
      } else if (nNorm.includes(qNorm)) {
        score = 60;
        reason = "contains";
      } else if (qNorm.length >= 3 && levenshtein(qNorm, nNorm, 2) <= 2) {
        score = 40;
        reason = "typo";
      }
      return { item: it, score, reason };
    })
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

// Render a short summary line for an item's metadata (for the table row).
function stockMetadataSummary(item) {
  const kind = categoryKind(item.category);
  const m = item.metadata || {};
  if (kind === "gps" && m.imei) return `IMEI: ${m.imei}`;
  if (kind === "sim") {
    const p = m.primary || "";
    const s = m.secondary || "";
    if (p && s) return `${p} · ${s}`;
    if (s) return `ICCID: ${s}`;
    if (p) return `Primary: ${p}`;
  }
  if (kind === "sensor") {
    const sn = m.sensorNo || "";
    const mac = m.macId || "";
    if (sn && mac) return `${sn} · ${mac}`;
    if (sn) return `Sensor: ${sn}`;
    if (mac) return `MAC: ${mac}`;
  }
  return "";
}

function renderStockPage() {
  if (!stockItemsTableReady) {
    app.innerHTML = `
      ${renderHeader("Stock Inventory", "Equipment & spares")}
      <main class="main">
        ${renderAdminNav("stock")}
        <section class="card">
          <h2>⚙️ Migration needed</h2>
          <p>The Stock page needs a one-time setup. Open Supabase SQL Editor and run <code>stock-items-migration.sql</code>, then come back here.</p>
          <div class="form-actions" style="margin-top: 1rem;">
            <a class="btn btn-primary" href="https://supabase.com/dashboard/project/jzclmcjurfehpfybxryh/sql/new" target="_blank" rel="noopener">Open SQL Editor →</a>
            <button type="button" class="btn btn-secondary" id="retryStock">↻ Reload</button>
          </div>
        </section>
      </main>
    `;
    bindLogout();
    bindAdminNav();
    document.getElementById("retryStock")?.addEventListener("click", async () => {
      renderLoading("Checking stock table...");
      try {
        await refreshAllData();
        render();
      } catch (err) {
        renderConnectionError(err.message);
      }
    });
    return;
  }

  const items = loadStockItems();
  const q = stockQuery.toLowerCase().trim();

  // Build category list from existing items + presets (deduped, sorted).
  const liveCategories = Array.from(
    new Set(items.map((i) => i.category).filter(Boolean))
  );
  const allCategoryOptions = getCategoryOptions();

  let filtered = items;
  if (stockCategoryFilter !== "all") {
    filtered = filtered.filter((i) => (i.category || "Uncategorized") === stockCategoryFilter);
  }
  if (q) {
    filtered = filtered.filter((i) => {
      const hay = [i.name, i.category || "", i.unit || "", i.notes || ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  // Stats
  const totalItems = items.length;
  const totalUnits = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const totalValue = items.reduce(
    (sum, i) => sum + (i.costPerUnit != null ? i.quantity * i.costPerUnit : 0),
    0
  );
  const lowStockItems = items.filter(
    (i) => i.lowStockThreshold != null && i.quantity <= i.lowStockThreshold
  );

  function isLow(item) {
    return item.lowStockThreshold != null && item.quantity <= item.lowStockThreshold;
  }

  // Category filter chips
  const chipsHtml = `
    <div class="filter-chips" style="margin-bottom: 0.85rem;">
      <button type="button" class="filter-chip ${stockCategoryFilter === "all" ? "active" : ""}" data-cat="all">All (${items.length})</button>
      ${liveCategories
        .sort()
        .map((c) => {
          const count = items.filter((i) => i.category === c).length;
          return `<button type="button" class="filter-chip ${stockCategoryFilter === c ? "active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} (${count})</button>`;
        })
        .join("")}
    </div>
  `;

  // Sort: low-stock first, then by name
  filtered.sort((a, b) => {
    const la = isLow(a) ? 0 : 1;
    const lb = isLow(b) ? 0 : 1;
    if (la !== lb) return la - lb;
    return a.name.localeCompare(b.name);
  });

  const fmtMoney = (n) =>
    n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const fmtQty = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });

  const tableHtml = filtered.length
    ? filtered
        .map((item) => {
          const low = isLow(item);
          const value = item.costPerUnit != null ? item.quantity * item.costPerUnit : null;
          const uses = getStockUses(item, 3);
          const recentHtml = uses.length
            ? uses
                .map((u) => {
                  if (u.source === "install") {
                    return `<span class="use-pill" title="Currently in installation">${escapeHtml(u.vehicleNo)}<span class="use-qty in-use">in use</span></span>`;
                  }
                  return `<span class="use-pill" title="${escapeHtml(String(-u.delta) + " " + item.unit + " on " + formatDateTime(u.at))}">${escapeHtml(u.vehicleNo)}<span class="use-qty">${u.delta}</span></span>`;
                })
                .join(" ")
            : `<span class="muted">—</span>`;
          const metaSummary = stockMetadataSummary(item);
          return `
            <tr class="${low ? "stock-row-low" : ""}">
              <td>
                <div class="stock-name">${escapeHtml(item.name)}${low ? ` <span class="low-pill">Low stock</span>` : ""}</div>
                ${metaSummary ? `<div class="stock-meta mono">${escapeHtml(metaSummary)}</div>` : ""}
                ${item.notes ? `<div class="stock-notes">${escapeHtml(item.notes.split("\n")[0])}</div>` : ""}
              </td>
              <td>${item.category ? `<span class="cat-pill">${escapeHtml(item.category)}</span>` : `<span class="muted">—</span>`}</td>
              <td>${item.supplier ? `<span class="supplier-pill">${escapeHtml(item.supplier)}</span>` : `<span class="muted">—</span>`}</td>
              <td class="mono qty-cell">${fmtQty(item.quantity)}</td>
              <td class="mono">${escapeHtml(item.unit)}</td>
              <td class="recent-use">${recentHtml}</td>
              <td class="date-cell">${escapeHtml(formatDateTime(item.updatedAt))}</td>
              <td class="row-actions">
                <button type="button" class="btn btn-outline btn-sm stock-edit" data-id="${item.id}">✎ Edit</button>
                <button type="button" class="btn btn-danger btn-sm stock-delete" data-id="${item.id}">Delete</button>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr class="empty-row"><td colspan="8">${q || stockCategoryFilter !== "all" ? "No items match the filters." : "No items in stock yet. Click + Add Item to start."}</td></tr>`;

  app.innerHTML = `
    ${renderHeader("Stock Inventory", "Equipment, spares, and consumables")}
    <main class="main">
      ${renderAdminNav("stock")}
      <div class="summary-grid">
        <div class="summary-box"><strong>${totalItems}</strong><span>Items</span></div>
        <div class="summary-box"><strong>${fmtQty(totalUnits)}</strong><span>Total units</span></div>
        <div class="summary-box ${lowStockItems.length ? "summary-warn" : ""}"><strong>${lowStockItems.length}</strong><span>Low stock</span></div>
      </div>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All Items (${items.length})</h2>
            <p class="section-subtitle">Track equipment, spares, and consumables. Stock is auto-consumed when Akash uses an item in an installation or repair.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="manageCatsBtn">⚙️ Manage categories</button>
            <button type="button" class="btn btn-secondary btn-sm" id="manageSuppliersBtn">🏷️ Manage suppliers</button>
            <button type="button" class="btn btn-primary btn-sm" id="addStockBtn">+ Add Item</button>
          </div>
        </div>
        <div class="list-tools admin-search">
          <input type="search" id="stockSearch" placeholder="Search name, category, notes..." value="${escapeHtml(stockQuery)}" />
        </div>
        ${liveCategories.length ? chipsHtml : ""}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Supplier</th>
                <th class="num-th">Qty</th>
                <th>Unit</th>
                <th>Recent use</th>
                <th>Last updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${tableHtml}</tbody>
          </table>
        </div>
      </section>
    </main>
  `;

  bindLogout();
  bindAdminNav();

  document.getElementById("stockSearch")?.addEventListener("input", (e) => {
    stockQuery = e.target.value;
    render();
    const el = document.getElementById("stockSearch");
    if (el) {
      el.focus();
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
    }
  });

  app.querySelectorAll(".filter-chip[data-cat]").forEach((chip) => {
    chip.addEventListener("click", () => {
      stockCategoryFilter = chip.dataset.cat;
      render();
    });
  });

  document.getElementById("addStockBtn")?.addEventListener("click", () =>
    openStockEditor(null, allCategoryOptions)
  );
  document.getElementById("manageCatsBtn")?.addEventListener("click", openCategoryManager);
  document.getElementById("manageSuppliersBtn")?.addEventListener("click", openSupplierManager);
  app.querySelectorAll(".stock-edit").forEach((btn) => {
    btn.addEventListener("click", () => openStockEditor(btn.dataset.id, allCategoryOptions));
  });
  app.querySelectorAll(".stock-delete").forEach((btn) => {
    btn.addEventListener("click", () => onDeleteStockItem(btn.dataset.id));
  });
}

function openStockEditor(itemId, categoryOptions) {
  const item = itemId ? loadStockItems().find((i) => i.id === itemId) : null;
  const allItems = loadStockItems();

  // Build a name → most-recent-category map so picking a known name can
  // auto-fill the category.
  const nameToCategory = new Map();
  // Sort by createdAt desc so older items don't overwrite the latest mapping.
  const sortedItems = [...allItems].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  for (const i of sortedItems) {
    if (i.name && !nameToCategory.has(i.name.toLowerCase())) {
      nameToCategory.set(i.name.toLowerCase(), i.category || "");
    }
  }
  const knownNames = Array.from(new Set(sortedItems.map((i) => i.name).filter(Boolean))).sort();

  // Stash on window so the listener can look up without closure capture issues.
  window.__stockNameCategoryMap = nameToCategory;

  modal.innerHTML = `
    <h3>${item ? "✎ Edit item" : "+ Add item"}</h3>
    <div class="field smart-name-field">
      <label for="stkName">Item name <span class="required">*</span></label>
      <div class="combobox">
        <input type="text" id="stkName" autocomplete="off" placeholder="Click to see existing items, or type a new name..." value="${escapeHtml(item?.name || "")}" />
        <div class="combobox-panel hidden" id="namePanel"></div>
      </div>
      <p class="hint" id="nameHint">Pick an existing item from the list to avoid duplicate entries.</p>
      <div class="dup-warn hidden" id="dupWarn"></div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="stkCategory">Category <span class="required">*</span></label>
        <input type="text" id="stkCategory" autocomplete="off" list="stockCatList" placeholder="GPS, SIM-AIRTEL, SENSOR..." value="${escapeHtml(item?.category || "")}" />
        <datalist id="stockCatList">
          ${categoryOptions.map((c) => `<option value="${escapeHtml(c)}">`).join("")}
        </datalist>
      </div>
      <div class="field">
        <label for="stkQty">Quantity <span class="required">*</span></label>
        <input type="number" id="stkQty" inputmode="decimal" min="0" step="any" autocomplete="off" placeholder="1" value="${item ? item.quantity : 1}" class="mono" />
      </div>
    </div>
    <!-- Hidden unit field (always pcs unless edited) -->
    <input type="hidden" id="stkUnit" value="${escapeHtml(item?.unit || "pcs")}" />

    <!-- Conditional fields based on category -->
    <div id="metaGps" class="meta-block hidden">
      <div class="meta-title">📡 GPS device identifier</div>
      <div class="field">
        <label for="metaImei">IMEI number <span class="required">*</span></label>
        <input type="text" id="metaImei" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 867530012345678" value="${escapeHtml(item?.metadata?.imei || "")}" />
      </div>
    </div>

    <div id="metaSim" class="meta-block hidden">
      <div class="meta-title">📶 SIM card numbers</div>
      <div class="field-row">
        <div class="field">
          <label for="metaSimPrimary">Primary number (13-digit)</label>
          <input type="text" id="metaSimPrimary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 5753200309565" value="${escapeHtml(item?.metadata?.primary || "")}" />
        </div>
        <div class="field">
          <label for="metaSimSecondary">Secondary / ICCID (20-digit) <span class="required">*</span></label>
          <input type="text" id="metaSimSecondary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 89918720507069156677" value="${escapeHtml(item?.metadata?.secondary || "")}" />
        </div>
      </div>
      <p class="hint">This SIM will also be added to the <strong>SIM Database</strong> automatically so Akash can use it during repair.</p>
    </div>

    <div id="metaSensor" class="meta-block hidden">
      <div class="meta-title">🛰️ Sensor identifiers</div>
      <div class="field-row">
        <div class="field">
          <label for="metaSensorNo">Sensor number <span class="required">*</span></label>
          <input type="text" id="metaSensorNo" class="mono" autocomplete="off" placeholder="e.g. SN-12345" value="${escapeHtml(item?.metadata?.sensorNo || "")}" />
        </div>
        <div class="field">
          <label for="metaMacId">MAC ID <span class="required">*</span></label>
          <input type="text" id="metaMacId" class="mono" autocomplete="off" placeholder="e.g. AA:BB:CC:DD:EE:FF" value="${escapeHtml(item?.metadata?.macId || "")}" />
        </div>
      </div>
    </div>

    <div class="field-row">
      <div class="field">
        <label for="stkCost">Cost per unit (₹)</label>
        <input type="number" id="stkCost" inputmode="decimal" min="0" step="any" autocomplete="off" placeholder="optional" value="${item?.costPerUnit ?? ""}" class="mono" />
      </div>
      <div class="field">
        <label for="stkLow">Low-stock alert at</label>
        <input type="number" id="stkLow" inputmode="decimal" min="0" step="any" autocomplete="off" placeholder="5" value="${item?.lowStockThreshold ?? 5}" class="mono" />
      </div>
    </div>
    <div class="field">
      <label for="stkSupplier">Supplier</label>
      <input type="text" id="stkSupplier" autocomplete="off" list="stockSupplierList" placeholder="Pick from list or type a new supplier..." value="${escapeHtml(item?.supplier || "")}" />
      <datalist id="stockSupplierList">
        ${getSupplierOptions().map((s) => `<option value="${escapeHtml(s)}">`).join("")}
      </datalist>
    </div>
    <div class="field">
      <label for="stkNotes">Notes (optional)</label>
      <input type="text" id="stkNotes" autocomplete="off" placeholder="e.g. supplier, batch, location" value="${escapeHtml(item?.notes || "")}" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">${item ? "Save changes" : "Add item"}</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector("#stkName")?.focus();

  const nameEl = modal.querySelector("#stkName");
  const categoryEl = modal.querySelector("#stkCategory");
  const hintEl = modal.querySelector("#nameHint");

  // Toggle the meta blocks based on category.
  function refreshMetaVisibility() {
    const kind = categoryKind(categoryEl.value);
    modal.querySelector("#metaGps").classList.toggle("hidden", kind !== "gps");
    modal.querySelector("#metaSim").classList.toggle("hidden", kind !== "sim");
    modal.querySelector("#metaSensor").classList.toggle("hidden", kind !== "sensor");
  }
  refreshMetaVisibility();
  categoryEl.addEventListener("input", refreshMetaVisibility);
  categoryEl.addEventListener("change", refreshMetaVisibility);

  // When the name matches an existing item, auto-fill its category.
  function autofillCategoryIfKnown() {
    const typed = nameEl.value.trim();
    if (!typed) {
      if (hintEl) {
        hintEl.textContent = "Pick an existing item from the list to avoid duplicate entries.";
        hintEl.className = "hint";
      }
      return;
    }
    const cat = nameToCategory.get(typed.toLowerCase());
    if (cat && !categoryEl.value.trim()) {
      categoryEl.value = cat;
      refreshMetaVisibility();
      if (hintEl) {
        hintEl.textContent = `✓ Recognised — auto-filled category "${cat}".`;
        hintEl.className = "hint hint-ok";
      }
    } else if (cat) {
      if (hintEl) {
        hintEl.textContent = `Existing item. Category for this product is usually "${cat}".`;
        hintEl.className = "hint";
      }
    } else {
      if (hintEl) {
        hintEl.textContent = "New item — pick or type a category below.";
        hintEl.className = "hint";
      }
    }
  }
  nameEl.addEventListener("input", autofillCategoryIfKnown);
  nameEl.addEventListener("change", autofillCategoryIfKnown);
  nameEl.addEventListener("blur", autofillCategoryIfKnown);

  // ----- Smart combobox: suggestions dropdown + duplicate warning -----
  const panelEl = modal.querySelector("#namePanel");
  const dupWarnEl = modal.querySelector("#dupWarn");

  function pickExistingItem(existingItem) {
    nameEl.value = existingItem.name;
    if (existingItem.category) {
      categoryEl.value = existingItem.category;
      refreshMetaVisibility();
    }
    panelEl.classList.add("hidden");
    autofillCategoryIfKnown();
    refreshDupWarn();
  }

  function reasonBadge(reason) {
    switch (reason) {
      case "recent":
        return `<span class="cbi-tag tag-recent">recent</span>`;
      case "exact":
        return `<span class="cbi-tag tag-exact">exact match</span>`;
      case "tokens":
        return `<span class="cbi-tag tag-warn">same words</span>`;
      case "starts":
      case "contains":
        return `<span class="cbi-tag tag-match">match</span>`;
      case "typo":
        return `<span class="cbi-tag tag-warn">possible typo</span>`;
      default:
        return "";
    }
  }

  function renderSuggestions(query) {
    const ranked = rankItemSuggestions(query, item?.id);
    if (!ranked.length) {
      panelEl.classList.add("hidden");
      panelEl.innerHTML = "";
      return;
    }
    // Group: "Recently added" header if showing recent items (no query)
    const headerHtml = !query.trim() ? `<div class="cb-header">Recently added — click to reuse</div>` : "";
    const itemsHtml = ranked
      .map((s) => {
        const it = s.item;
        const metaSummary = stockMetadataSummary(it);
        return `
          <button type="button" class="combobox-item" data-id="${escapeHtml(it.id)}">
            <div class="cbi-main">
              <span class="cbi-name">${escapeHtml(it.name)}</span>
              ${reasonBadge(s.reason)}
            </div>
            <div class="cbi-sub">
              ${it.category ? `<span class="cat-pill">${escapeHtml(it.category)}</span>` : `<span class="muted">no category</span>`}
              <span class="muted">·</span>
              <span class="mono">${it.quantity} ${escapeHtml(it.unit)}</span>
              ${metaSummary ? `<span class="muted"> · </span><span class="mono cbi-meta">${escapeHtml(metaSummary)}</span>` : ""}
            </div>
          </button>`;
      })
      .join("");
    panelEl.innerHTML = headerHtml + itemsHtml;
    panelEl.classList.remove("hidden");

    panelEl.querySelectorAll(".combobox-item").forEach((btn) => {
      // mousedown fires BEFORE blur, so the click is registered even if
      // input loses focus on click.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        const found = loadStockItems().find((i) => i.id === id);
        if (found) pickExistingItem(found);
      });
    });
  }

  function refreshDupWarn() {
    const typed = nameEl.value.trim();
    if (!typed) {
      dupWarnEl.classList.add("hidden");
      dupWarnEl.innerHTML = "";
      return;
    }
    const match = findClosestItem(typed, item?.id);
    if (!match) {
      dupWarnEl.classList.add("hidden");
      dupWarnEl.innerHTML = "";
      return;
    }
    let icon = "⚠️";
    let label = "";
    let cls = "dup-warn dup-typo";
    if (match.reason === "exact") {
      icon = "ℹ️";
      label = `Already in stock as <strong>${escapeHtml(match.item.name)}</strong>${match.item.category ? ` (${escapeHtml(match.item.category)})` : ""}. Pick it instead of creating a new entry.`;
      cls = "dup-warn dup-exact";
    } else if (match.reason === "tokens") {
      label = `Looks like the same product, different order/spacing: <strong>${escapeHtml(match.item.name)}</strong>${match.item.category ? ` (${escapeHtml(match.item.category)})` : ""}. Reuse it to avoid duplicates.`;
      cls = "dup-warn dup-tokens";
    } else if (match.reason === "typo") {
      label = `Did you mean <strong>${escapeHtml(match.item.name)}</strong>${match.item.category ? ` (${escapeHtml(match.item.category)})` : ""}?`;
      cls = "dup-warn dup-typo";
    }
    dupWarnEl.className = cls;
    dupWarnEl.innerHTML = `${icon} ${label} <button type="button" class="dup-pick" data-id="${escapeHtml(match.item.id)}">Use existing →</button>`;
    dupWarnEl.classList.remove("hidden");
    dupWarnEl.querySelector(".dup-pick")?.addEventListener("click", () => {
      pickExistingItem(match.item);
    });
  }

  nameEl.addEventListener("focus", () => renderSuggestions(nameEl.value));
  nameEl.addEventListener("input", () => {
    renderSuggestions(nameEl.value);
    refreshDupWarn();
  });
  // Delay hide so the mousedown handler can fire on suggestion clicks.
  nameEl.addEventListener("blur", () => {
    setTimeout(() => panelEl.classList.add("hidden"), 120);
  });
  // Initial duplicate check if editing
  if (item) refreshDupWarn();

  modal.querySelector('[data-act="save"]').onclick = async () => {
    const name = nameEl.value.trim();
    const category = categoryEl.value.trim() || null;
    const unit = modal.querySelector("#stkUnit").value.trim() || "pcs";
    const qtyRaw = modal.querySelector("#stkQty").value;
    const costRaw = modal.querySelector("#stkCost").value;
    const lowRaw = modal.querySelector("#stkLow").value;
    const notes = modal.querySelector("#stkNotes").value.trim() || null;
    const supplier = modal.querySelector("#stkSupplier")?.value.trim() || null;

    if (!name) {
      showToast("Item name is required.", true);
      return;
    }
    if (!category) {
      showToast("Category is required.", true);
      return;
    }
    const quantity = qtyRaw === "" ? 0 : Number(qtyRaw);
    if (Number.isNaN(quantity) || quantity < 0) {
      showToast("Quantity must be a non-negative number.", true);
      return;
    }

    // Collect category-specific metadata.
    const kind = categoryKind(category);
    const metadata = {};
    let simPrimary = null;
    let simSecondary = null;
    if (kind === "gps") {
      const imei = modal.querySelector("#metaImei").value.trim();
      if (!imei) {
        showToast("IMEI number is required for GPS items.", true);
        return;
      }
      // Duplicate check
      const dup = loadStockItems().find(
        (i) => i.id !== item?.id && (i.metadata?.imei || "").toLowerCase() === imei.toLowerCase()
      );
      if (dup) {
        showToast(`IMEI ${imei} already exists in stock (${dup.name}). Edit that item instead.`, true);
        return;
      }
      metadata.imei = imei;
    } else if (kind === "sim") {
      simPrimary = modal.querySelector("#metaSimPrimary").value.trim();
      simSecondary = modal.querySelector("#metaSimSecondary").value.trim();
      if (!simSecondary) {
        showToast("Secondary / ICCID is required for SIM items.", true);
        return;
      }
      // Duplicate check by secondary (the unique permanent ID)
      const dupSec = loadStockItems().find(
        (i) =>
          i.id !== item?.id &&
          (i.metadata?.secondary || "").toLowerCase() === simSecondary.toLowerCase()
      );
      if (dupSec) {
        showToast(
          `ICCID ${simSecondary} already exists in stock (${dupSec.name}). Edit that item instead.`,
          true
        );
        return;
      }
      // Also reject if the entered primary number is already used by another stock SIM
      if (simPrimary) {
        const dupPri = loadStockItems().find(
          (i) =>
            i.id !== item?.id &&
            (i.metadata?.primary || "").toLowerCase() === simPrimary.toLowerCase()
        );
        if (dupPri) {
          showToast(
            `Primary number ${simPrimary} already exists in stock (${dupPri.name}). Each primary must be unique.`,
            true
          );
          return;
        }
      }
      metadata.primary = simPrimary || null;
      metadata.secondary = simSecondary;
    } else if (kind === "sensor") {
      const sensorNo = modal.querySelector("#metaSensorNo").value.trim();
      const macId = modal.querySelector("#metaMacId").value.trim();
      if (!sensorNo) {
        showToast("Sensor number is required.", true);
        return;
      }
      if (!macId) {
        showToast("MAC ID is required.", true);
        return;
      }
      // Duplicate check (sensor no OR mac id matches another item)
      const dup = loadStockItems().find(
        (i) =>
          i.id !== item?.id &&
          ((sensorNo && (i.metadata?.sensorNo || "").toLowerCase() === sensorNo.toLowerCase()) ||
            (macId && (i.metadata?.macId || "").toLowerCase() === macId.toLowerCase()))
      );
      if (dup) {
        showToast(`Sensor with this number/MAC already exists in stock (${dup.name}).`, true);
        return;
      }
      metadata.sensorNo = sensorNo;
      metadata.macId = macId;
    }

    closeModal();
    renderLoading(item ? "Saving changes..." : "Adding item...");
    try {
      const payload = {
        id: item?.id,
        name,
        category,
        unit,
        quantity,
        costPerUnit: costRaw === "" ? null : Number(costRaw),
        lowStockThreshold: lowRaw === "" ? null : Number(lowRaw),
        notes,
        supplier,
        metadata,
      };
      if (item) {
        await updateStockItem(payload);
      } else {
        await insertStockItem(payload);
      }
      // SIM integration: also upsert into the sims table so it shows up in
      // the SIM Database and is auto-found during Akash's repair flow.
      if (kind === "sim" && simSecondary && simsTableReady) {
        try {
          await upsertSim({
            primaryNumber: simPrimary || null,
            secondaryNumber: simSecondary,
            notes: `Stock: ${name}`,
          });
        } catch (simErr) {
          console.warn("Stock SIM also-write to sims table failed:", simErr);
        }
      }
      await refreshAllData();
      render();
      showToast(item ? "Item updated." : "Item added.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

function openStockAdjust(itemId) {
  const item = loadStockItems().find((i) => i.id === itemId);
  if (!item) return;

  const installs = loadInstallations();
  // Sort vehicles alphabetically for the dropdown.
  const sortedInstalls = [...installs].sort((a, b) => a.vehicleNo.localeCompare(b.vehicleNo));

  modal.innerHTML = `
    <h3>± Adjust stock — ${escapeHtml(item.name)}</h3>
    <p class="modal-desc">Current quantity: <strong>${item.quantity} ${escapeHtml(item.unit)}</strong>${item.category ? ` · ${escapeHtml(item.category)}` : ""}</p>
    <div class="field">
      <label for="adjAmount">Adjustment amount</label>
      <input type="number" id="adjAmount" inputmode="decimal" step="any" autocomplete="off" placeholder="e.g. 5 or -2" class="mono" />
      <p class="hint">Use a positive number to <strong>add</strong> stock (received) or a negative number to <strong>remove</strong> (used).</p>
    </div>
    <div class="adj-preview" id="adjPreview">New total: <strong>${item.quantity} ${escapeHtml(item.unit)}</strong></div>
    <div class="field hidden" id="vehicleField">
      <label for="adjVehicle">Used on vehicle (optional)</label>
      <select id="adjVehicle">
        <option value="">— not linked to a vehicle —</option>
        ${sortedInstalls
          .map(
            (i) =>
              `<option value="${escapeHtml(i.id)}" data-vno="${escapeHtml(i.vehicleNo)}">${escapeHtml(i.vehicleNo)}</option>`
          )
          .join("")}
      </select>
      <p class="hint">Picking a vehicle lets the Stock page show "Used in VEHICLE-X" and keep a per-vehicle usage history.</p>
    </div>
    <div class="field">
      <label for="adjNote">Note (optional)</label>
      <input type="text" id="adjNote" autocomplete="off" placeholder="e.g. supplier batch, reason for use" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Apply</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  const input = modal.querySelector("#adjAmount");
  const preview = modal.querySelector("#adjPreview");
  const vehicleField = modal.querySelector("#vehicleField");
  input.focus();

  function refreshPreview() {
    const raw = input.value;
    const delta = raw === "" ? 0 : Number(raw);
    // Show vehicle dropdown only when removing stock.
    if (delta < 0) {
      vehicleField.classList.remove("hidden");
    } else {
      vehicleField.classList.add("hidden");
    }
    if (Number.isNaN(delta)) {
      preview.innerHTML = `<span class="warn">Enter a number.</span>`;
      preview.className = "adj-preview warn";
      return;
    }
    const next = item.quantity + delta;
    if (next < 0) {
      preview.innerHTML = `Would go below zero (${next}). Adjust must not exceed current stock.`;
      preview.className = "adj-preview warn";
    } else {
      preview.innerHTML = `New total: <strong>${next} ${escapeHtml(item.unit)}</strong> ${delta > 0 ? `<span class="ok">(+${delta})</span>` : delta < 0 ? `<span class="warn">(${delta})</span>` : ""}`;
      preview.className = "adj-preview ok";
    }
  }
  input.addEventListener("input", refreshPreview);

  modal.querySelector('[data-act="save"]').onclick = async () => {
    const raw = input.value;
    if (raw === "" || raw === "-" || raw === "+") {
      showToast("Enter an adjustment amount.", true);
      return;
    }
    const delta = Number(raw);
    if (Number.isNaN(delta) || delta === 0) {
      showToast("Adjustment must be a non-zero number.", true);
      return;
    }
    const next = item.quantity + delta;
    if (next < 0) {
      showToast(`Cannot go below 0 (current ${item.quantity}, delta ${delta}).`, true);
      return;
    }
    const note = modal.querySelector("#adjNote").value.trim();
    const vehicleSelect = modal.querySelector("#adjVehicle");
    const installationId = delta < 0 ? vehicleSelect?.value || null : null;
    const vehicleNo =
      installationId && vehicleSelect
        ? vehicleSelect.options[vehicleSelect.selectedIndex]?.dataset.vno || null
        : null;

    closeModal();
    renderLoading("Adjusting stock...");
    try {
      // 1) Update the stock_items quantity.
      await updateStockItem({
        ...item,
        quantity: next,
      });
      // 2) Record the transaction (if the migration has been run).
      if (stockTxTableReady) {
        try {
          await insertStockTransaction({
            stockItemId: item.id,
            installationId,
            vehicleNo,
            delta,
            resultingQuantity: next,
            note: note || null,
            createdBy: currentUser || "admin",
          });
        } catch (txErr) {
          // Stock quantity was updated; transaction record failed. Surface a
          // soft warning but don't roll back the quantity change.
          console.warn("Stock transaction record failed:", txErr);
          showToast("Quantity updated but transaction log failed. Run stock-transactions-migration.sql.", true);
        }
      }
      await refreshAllData();
      render();
      const vehicleSuffix = vehicleNo ? ` (linked to ${vehicleNo})` : "";
      showToast(`Stock adjusted to ${next} ${item.unit}${vehicleSuffix}.`);
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Adjustment failed.", true);
    }
  };
}

function openStockHistory(itemId) {
  const item = loadStockItems().find((i) => i.id === itemId);
  if (!item) return;
  const txs = getStockItemTransactions(itemId);

  const fmtMoney = (n) =>
    n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  const rowsHtml = txs.length
    ? txs
        .map((t) => {
          const isPositive = t.delta > 0;
          return `
            <tr>
              <td class="date-cell">${escapeHtml(formatDateTime(t.createdAt))}</td>
              <td class="mono"><span class="${isPositive ? "tx-plus" : "tx-minus"}">${isPositive ? "+" : ""}${t.delta}</span></td>
              <td class="mono">${t.resultingQuantity != null ? t.resultingQuantity : "—"}</td>
              <td>${t.vehicleNo ? `<span class="use-pill">${escapeHtml(t.vehicleNo)}</span>` : `<span class="muted">—</span>`}</td>
              <td>${escapeHtml(t.note || "")}</td>
              <td class="mono muted">${escapeHtml(t.createdBy || "—")}</td>
            </tr>
          `;
        })
        .join("")
    : `<tr class="empty-row"><td colspan="6">No transactions recorded for this item yet.</td></tr>`;

  // Summary: total received, total used, # of vehicles served
  const received = txs.filter((t) => t.delta > 0).reduce((s, t) => s + t.delta, 0);
  const used = txs.filter((t) => t.delta < 0).reduce((s, t) => s + Math.abs(t.delta), 0);
  const vehicleSet = new Set(txs.filter((t) => t.vehicleNo).map((t) => t.vehicleNo));

  modal.innerHTML = `
    <h3>🕐 History — ${escapeHtml(item.name)}</h3>
    <p class="modal-desc">Current stock: <strong>${item.quantity} ${escapeHtml(item.unit)}</strong>${item.costPerUnit != null ? ` · ${fmtMoney(item.costPerUnit)}/unit` : ""}</p>
    <div class="history-summary">
      <div class="hs-box"><strong class="tx-plus">+${received}</strong><span>Received</span></div>
      <div class="hs-box"><strong class="tx-minus">−${used}</strong><span>Used</span></div>
      <div class="hs-box"><strong>${vehicleSet.size}</strong><span>Vehicles served</span></div>
      <div class="hs-box"><strong>${txs.length}</strong><span>Total entries</span></div>
    </div>
    <div class="table-wrap history-table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Δ</th>
            <th>After</th>
            <th>Vehicle</th>
            <th>Note</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Close</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
}

async function onDeleteStockItem(itemId) {
  const item = loadStockItems().find((i) => i.id === itemId);
  if (!item) return;

  const reason = await promptForDeleteReason(item);
  if (reason == null) return; // cancelled

  renderLoading("Deleting item...");
  try {
    // 1) Record the deletion as a transaction so audit history persists.
    if (stockTxTableReady) {
      try {
        await insertStockTransaction({
          stockItemId: item.id, // FK will be set to NULL after delete
          installationId: null,
          vehicleNo: null,
          delta: -item.quantity,
          resultingQuantity: 0,
          note: `DELETED — reason: ${reason}`,
          createdBy: currentUser || "admin",
          itemNameSnapshot: item.name + (item.category ? ` (${item.category})` : ""),
        });
      } catch (txErr) {
        console.warn("Deletion transaction record failed:", txErr);
      }
    }
    // 2) Delete the row.
    await deleteStockItem(itemId);
    await refreshAllData();
    render();
    showToast("Item deleted.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

function promptForDeleteReason(item) {
  return new Promise((resolve) => {
    modal.innerHTML = `
      <h3>🗑️ Delete this item?</h3>
      <p class="modal-desc">You're about to remove <strong>${escapeHtml(item.name)}</strong>${item.category ? ` (${escapeHtml(item.category)})` : ""} — current stock <strong>${item.quantity} ${escapeHtml(item.unit)}</strong>. This cannot be undone.</p>
      <div class="field">
        <label for="delReason">Reason for deletion <span class="required">*</span></label>
        <input type="text" id="delReason" autocomplete="off" placeholder="e.g. wrong entry, damaged, returned to supplier" />
        <p class="hint">The reason will be recorded in the stock audit history for accountability.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-danger" data-act="confirm">Delete</button>
      </div>
    `;
    modalOverlay.classList.remove("hidden");
    const input = modal.querySelector("#delReason");
    input?.focus();

    const done = (val) => {
      closeModal();
      resolve(val);
    };
    modal.querySelector('[data-act="cancel"]').onclick = () => done(null);
    modal.querySelector('[data-act="confirm"]').onclick = () => {
      const v = (input.value || "").trim();
      if (!v) {
        showToast("Please enter a reason for deletion.", true);
        return;
      }
      done(v);
    };
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
    });
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) done(null);
    };
  });
}

function openCategoryManager() {
  const cats = loadStockCategories ? loadStockCategories() : stockCategories;
  const itemsByCat = new Map();
  for (const it of loadStockItems()) {
    if (!it.category) continue;
    itemsByCat.set(it.category, (itemsByCat.get(it.category) || 0) + 1);
  }

  function rowHtml(cat) {
    const inUse = itemsByCat.get(cat.name) || 0;
    return `
      <div class="cat-row">
        <span class="cat-pill">${escapeHtml(cat.name)}</span>
        <span class="cat-usage">${inUse > 0 ? `${inUse} item${inUse === 1 ? "" : "s"} use this` : "not in use"}</span>
        <button type="button" class="btn btn-danger btn-sm cat-delete" data-id="${escapeHtml(cat.id)}" ${inUse > 0 ? "disabled" : ""} title="${inUse > 0 ? "Cannot delete — items use this category" : "Delete this category"}">Delete</button>
      </div>
    `;
  }

  modal.innerHTML = `
    <h3>⚙️ Manage categories</h3>
    <p class="modal-desc">Add new categories or remove ones you don't need. Categories that have items can't be deleted until those items are moved or removed.</p>

    <div class="cat-add-row">
      <input type="text" id="newCatName" autocomplete="off" placeholder="New category name (e.g. SIM-VI)" />
      <button type="button" class="btn btn-primary btn-sm" id="addCatBtn">+ Add</button>
    </div>

    <div class="cat-list" id="catList">
      ${cats.length ? cats.map(rowHtml).join("") : `<p class="muted">No categories yet. Add one above.</p>`}
    </div>

    <div class="modal-actions" style="margin-top: 1rem;">
      <button type="button" class="btn btn-secondary" data-act="cancel">Close</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  function wireListButtons() {
    modal.querySelectorAll(".cat-delete").forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const cat = stockCategories.find((c) => c.id === id);
        if (!cat) return;
        const ok = await showConfirm({
          title: "Delete category?",
          message: `Remove "${cat.name}" from the category list? This cannot be undone.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteStockCategory(id);
          await refreshAllData();
          // Re-render the modal to reflect the updated list
          closeModal();
          openCategoryManager();
        } catch (err) {
          showToast(err.message || "Delete failed.", true);
        }
      });
    });
  }
  wireListButtons();

  async function addNewCategory() {
    const name = modal.querySelector("#newCatName").value.trim();
    if (!name) {
      showToast("Type a category name first.", true);
      return;
    }
    try {
      await insertStockCategory(name);
      await refreshAllData();
      closeModal();
      openCategoryManager();
    } catch (err) {
      showToast(err.message || "Add failed.", true);
    }
  }
  modal.querySelector("#addCatBtn").onclick = addNewCategory;
  modal.querySelector("#newCatName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNewCategory();
    }
  });
}

function openSupplierManager() {
  const sups = loadSuppliers();
  const itemsBySupplier = new Map();
  for (const it of loadStockItems()) {
    if (!it.supplier) continue;
    itemsBySupplier.set(it.supplier, (itemsBySupplier.get(it.supplier) || 0) + 1);
  }
  function rowHtml(sup) {
    const inUse = itemsBySupplier.get(sup.name) || 0;
    return `
      <div class="cat-row">
        <span class="supplier-pill">${escapeHtml(sup.name)}</span>
        <span class="cat-usage">${inUse > 0 ? `${inUse} item${inUse === 1 ? "" : "s"}` : "not in use"}</span>
        <button type="button" class="btn btn-danger btn-sm sup-delete" data-id="${escapeHtml(sup.id)}" ${inUse > 0 ? "disabled" : ""} title="${inUse > 0 ? "Items use this supplier — clear them first" : "Delete this supplier"}">Delete</button>
      </div>`;
  }
  modal.innerHTML = `
    <h3>🏷️ Manage suppliers</h3>
    <p class="modal-desc">Add suppliers or remove ones you don't use. Suppliers that have items can't be deleted until those items are reassigned.</p>
    <div class="cat-add-row">
      <input type="text" id="newSupName" autocomplete="off" placeholder="Supplier name (e.g. ABC Telecom)" />
      <button type="button" class="btn btn-primary btn-sm" id="addSupBtn">+ Add</button>
    </div>
    <div class="cat-list">
      ${sups.length ? sups.map(rowHtml).join("") : `<p class="muted">No suppliers yet. Add one above.</p>`}
    </div>
    <div class="modal-actions" style="margin-top: 1rem;">
      <button type="button" class="btn btn-secondary" data-act="cancel">Close</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  modal.querySelectorAll(".sup-delete").forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const sup = suppliers.find((s) => s.id === id);
      if (!sup) return;
      const ok = await showConfirm({
        title: "Delete supplier?",
        message: `Remove "${sup.name}" from the supplier list?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteSupplier(id);
        await refreshAllData();
        closeModal();
        openSupplierManager();
      } catch (err) {
        showToast(err.message || "Delete failed.", true);
      }
    });
  });

  async function addNewSupplier() {
    const name = modal.querySelector("#newSupName").value.trim();
    if (!name) {
      showToast("Type a supplier name first.", true);
      return;
    }
    try {
      await insertSupplier(name);
      await refreshAllData();
      closeModal();
      openSupplierManager();
    } catch (err) {
      showToast(err.message || "Add failed.", true);
    }
  }
  modal.querySelector("#addSupBtn").onclick = addNewSupplier;
  modal.querySelector("#newSupName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNewSupplier();
    }
  });
}

function render() {
  switch (view) {
    case "login":
      renderLogin();
      break;
    case "akash-home":
      renderAkashHome();
      break;
    case "install":
      renderInstallForm();
      break;
    case "repair":
      renderRepairForm();
      break;
    case "dashboard":
      renderDashboard();
      break;
    case "installations":
      renderInstallationsPage();
      break;
    case "repairs":
      renderRepairsPage();
      break;
    case "pending":
      renderPendingPage();
      break;
    case "sim-upload":
      renderSimUpload();
      break;
    case "sim-db":
      renderSimDb();
      break;
    case "stock":
      renderStockPage();
      break;
    case "timeline":
      renderTimeline();
      break;
    // Legacy aliases
    case "admin":
      renderDashboard();
      break;
    default:
      renderLogin();
  }
}


async function initApp() {
  if (!isSupabaseConfigured()) {
    renderConfigMissing();
    return;
  }
  try {
    initDb();
    render();
  } catch (err) {
    app.innerHTML = `
      ${renderHeader("GPS Maintenance Tracker", "Error")}
      <main class="main centered">
        <section class="card login-card"><h2>Could not start app</h2><p class="login-desc">${escapeHtml(err.message)}</p></section>
      </main>
    `;
  }
}

initApp();
