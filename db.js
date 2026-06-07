let supabaseClient = null;

const BUILT_IN_SUPABASE_URL = "https://jzclmcjurfehpfybxryh.supabase.co";
const BUILT_IN_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6Y2xtY2p1cmZlaHBmeWJ4cnloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2NDI2NDcsImV4cCI6MjA5NTIxODY0N30.pdB45v7uBRzsh6M_Vrb43-SV_kLMwjGHpi9-uBuqHmw";

function getSupabaseSettings() {
  return {
    url: window.SUPABASE_URL || BUILT_IN_SUPABASE_URL,
    anonKey: window.SUPABASE_ANON_KEY || BUILT_IN_SUPABASE_ANON_KEY,
  };
}

function isSupabaseConfigured() {
  const { url, anonKey } = getSupabaseSettings();
  return Boolean(
    url &&
      anonKey &&
      !url.includes("YOUR_PROJECT") &&
      !anonKey.includes("YOUR_ANON")
  );
}

function initDb() {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured.");
  }
  const { url, anonKey } = getSupabaseSettings();
  supabaseClient = window.supabase.createClient(url, anonKey, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return supabaseClient;
}

function getDb() {
  if (!supabaseClient) initDb();
  return supabaseClient;
}

function rowToInstallation(row) {
  return {
    id: row.id,
    vehicleNo: row.vehicle_no,
    gpsModel: row.gps_model,
    macId: row.mac_id,
    sensorNo: row.sensor_no,
    secondarySim: row.secondary_sim || null,
    imeiHistory: row.imei_history || [],
    simHistory: row.sim_history || [],
    tasks: row.tasks && typeof row.tasks === "object" ? row.tasks : {},
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function installationToRow(inst) {
  return {
    id: inst.id,
    vehicle_no: inst.vehicleNo,
    gps_model: inst.gpsModel,
    mac_id: inst.macId,
    sensor_no: inst.sensorNo,
    secondary_sim: inst.secondarySim || null,
    imei_history: inst.imeiHistory,
    sim_history: inst.simHistory,
    tasks: inst.tasks && typeof inst.tasks === "object" ? inst.tasks : {},
    created_at: inst.createdAt,
    created_by: inst.createdBy,
  };
}

function rowToMaintenance(row) {
  return {
    id: row.id,
    installationId: row.installation_id,
    imei: row.imei,
    vehicleNo: row.vehicle_no,
    wiringConnection: row.wiring_connection,
    simChange: row.sim_change,
    newSimNo: row.new_sim_no,
    deviceChange: row.device_change,
    newImei: row.new_imei,
    sensorOutForRepair: row.sensor_out_for_repair || false,
    sensorChanged: row.sensor_changed || false,
    deviceOutForRepair: row.device_out_for_repair || false,
    otherWorkText: row.other_work_text || null,
    oldSimNo: row.old_sim_no,
    oldImei: row.old_imei,
    simDeactivationPending: row.sim_deactivation_pending,
    simDeactivated: row.sim_deactivated,
    simDeactivatedAt: row.sim_deactivated_at,
    tasks: row.tasks || [],
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function maintenanceToRow(record) {
  return {
    id: record.id,
    installation_id: record.installationId,
    imei: record.imei,
    vehicle_no: record.vehicleNo,
    wiring_connection: record.wiringConnection,
    sim_change: record.simChange,
    new_sim_no: record.newSimNo,
    device_change: record.deviceChange,
    new_imei: record.newImei,
    sensor_out_for_repair: record.sensorOutForRepair,
    sensor_changed: record.sensorChanged,
    device_out_for_repair: record.deviceOutForRepair,
    other_work_text: record.otherWorkText,
    old_sim_no: record.oldSimNo,
    old_imei: record.oldImei,
    sim_deactivation_pending: record.simDeactivationPending,
    sim_deactivated: record.simDeactivated,
    sim_deactivated_at: record.simDeactivatedAt,
    tasks: record.tasks || [],
    created_at: record.createdAt,
    created_by: record.createdBy,
  };
}

async function fetchInstallations() {
  const { data, error } = await getDb()
    .from("installations")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToInstallation);
}

async function fetchMaintenanceRecords() {
  const { data, error } = await getDb()
    .from("maintenance_records")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToMaintenance);
}

async function insertInstallation(inst) {
  const { data, error } = await getDb()
    .from("installations")
    .insert(installationToRow(inst))
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToInstallation(data);
}

// Updates all editable fields including the admin-managed secondary SIM.
async function updateInstallation(inst) {
  const { data, error } = await getDb()
    .from("installations")
    .update({
      vehicle_no: inst.vehicleNo,
      gps_model: inst.gpsModel,
      mac_id: inst.macId,
      sensor_no: inst.sensorNo,
      secondary_sim: inst.secondarySim || null,
      imei_history: inst.imeiHistory,
      sim_history: inst.simHistory,
    })
    .eq("id", inst.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToInstallation(data);
}

async function insertMaintenanceRecord(record) {
  const { data, error } = await getDb()
    .from("maintenance_records")
    .insert(maintenanceToRow(record))
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToMaintenance(data);
}

async function updateMaintenanceRecord(record) {
  const { data, error } = await getDb()
    .from("maintenance_records")
    .update({
      sim_deactivation_pending: record.simDeactivationPending,
      sim_deactivated: record.simDeactivated,
      sim_deactivated_at: record.simDeactivatedAt,
      tasks: record.tasks || [],
    })
    .eq("id", record.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToMaintenance(data);
}

/* ============================================================
   SIMS TABLE
   A SIM is one physical card with two numbers:
     primaryNumber   - typically 13-digit, the "phone number" of the SIM
     secondaryNumber - typically 19-20 digit ICCID printed on the card
   The secondary is the unique permanent identifier of the card.
   ============================================================ */

function rowToSim(row) {
  return {
    id: row.id,
    primaryNumber: row.primary_number || null,
    secondaryNumber: row.secondary_number,
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function simToRow(sim) {
  return {
    primary_number: sim.primaryNumber ? String(sim.primaryNumber).trim() || null : null,
    secondary_number: String(sim.secondaryNumber).trim(),
    notes: sim.notes || null,
  };
}

// Sentinel error so callers can detect "migration not yet run".
const SIMS_TABLE_MISSING = "SIMS_TABLE_MISSING";

function isMissingSimsTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    msg.includes('relation "public.sims" does not exist') ||
    msg.includes('relation "sims" does not exist') ||
    // PostgREST returns this when the table isn't in the schema cache yet
    // (typically because the migration hasn't been run):
    //   "Could not find the table 'public.sims' in the schema cache"
    (msg.includes("could not find") && msg.includes("sims") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("sims"))
  );
}

async function fetchSims() {
  const { data, error } = await getDb()
    .from("sims")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingSimsTableError(error)) {
      const e = new Error("sims table missing — please run sims-table-migration.sql in Supabase");
      e.code = SIMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToSim);
}

async function insertSim(sim) {
  const { data, error } = await getDb()
    .from("sims")
    .insert(simToRow(sim))
    .select()
    .single();

  if (error) {
    if (isMissingSimsTableError(error)) {
      const e = new Error("sims table missing — please run sims-table-migration.sql in Supabase");
      e.code = SIMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToSim(data);
}

async function updateSim(sim) {
  const { data, error } = await getDb()
    .from("sims")
    .update({
      primary_number: sim.primaryNumber ? String(sim.primaryNumber).trim() || null : null,
      secondary_number: String(sim.secondaryNumber).trim(),
      notes: sim.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sim.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToSim(data);
}

async function deleteSim(simId) {
  const { error } = await getDb().from("sims").delete().eq("id", simId);
  if (error) throw new Error(error.message);
  return true;
}

// Upsert a SIM by secondary_number (the unique permanent identifier).
// If the SIM exists, primary_number is updated (and notes if provided).
// If not, a new row is inserted.
async function upsertSim({ primaryNumber, secondaryNumber, notes }) {
  const payload = {
    primary_number: primaryNumber ? String(primaryNumber).trim() || null : null,
    secondary_number: String(secondaryNumber).trim(),
  };
  if (notes !== undefined) payload.notes = notes || null;
  payload.updated_at = new Date().toISOString();

  const { data, error } = await getDb()
    .from("sims")
    .upsert(payload, { onConflict: "secondary_number" })
    .select()
    .single();

  if (error) {
    if (isMissingSimsTableError(error)) {
      const e = new Error("sims table missing — please run sims-table-migration.sql in Supabase");
      e.code = SIMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToSim(data);
}

/* ============================================================
   STOCK ITEMS TABLE
   Inventory: GPS devices, brackets, cables, sensors, antennas,
   batteries, tools, etc. Each item has quantity, unit, optional
   cost-per-unit, and optional low-stock threshold.
   ============================================================ */

function rowToStockItem(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category || null,
    quantity: Number(row.quantity || 0),
    unit: row.unit || "pcs",
    costPerUnit: row.cost_per_unit != null ? Number(row.cost_per_unit) : null,
    lowStockThreshold: row.low_stock_threshold != null ? Number(row.low_stock_threshold) : null,
    notes: row.notes || null,
    supplier: row.supplier || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stockItemToRow(item) {
  const num = (v) => (v === "" || v == null ? null : Number(v));
  return {
    name: String(item.name).trim(),
    category: item.category ? String(item.category).trim() || null : null,
    quantity: Number(item.quantity || 0),
    unit: (item.unit || "pcs").trim(),
    cost_per_unit: num(item.costPerUnit),
    low_stock_threshold: num(item.lowStockThreshold),
    notes: item.notes || null,
    supplier: item.supplier ? String(item.supplier).trim() || null : null,
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
  };
}

const STOCK_ITEMS_TABLE_MISSING = "STOCK_ITEMS_TABLE_MISSING";

function isMissingStockItemsTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("stock_items") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("stock_items") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("stock_items"))
  );
}

async function fetchStockItems() {
  const { data, error } = await getDb()
    .from("stock_items")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    if (isMissingStockItemsTableError(error)) {
      const e = new Error("stock_items table missing — please run stock-items-migration.sql in Supabase");
      e.code = STOCK_ITEMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToStockItem);
}

async function insertStockItem(item) {
  const { data, error } = await getDb()
    .from("stock_items")
    .insert(stockItemToRow(item))
    .select()
    .single();

  if (error) {
    if (isMissingStockItemsTableError(error)) {
      const e = new Error("stock_items table missing — please run stock-items-migration.sql in Supabase");
      e.code = STOCK_ITEMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToStockItem(data);
}

async function updateStockItem(item) {
  const payload = stockItemToRow(item);
  payload.updated_at = new Date().toISOString();
  const { data, error } = await getDb()
    .from("stock_items")
    .update(payload)
    .eq("id", item.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToStockItem(data);
}

async function deleteStockItem(itemId) {
  const { error } = await getDb().from("stock_items").delete().eq("id", itemId);
  if (error) throw new Error(error.message);
  return true;
}

/* ============================================================
   STOCK TRANSACTIONS TABLE
   Each stock adjustment is recorded here, optionally linked to
   an installation/vehicle so the Stock page can show "Used in
   VEHICLE-X" and a full per-item history.
   ============================================================ */

function rowToStockTx(row) {
  return {
    id: row.id,
    stockItemId: row.stock_item_id || null,
    installationId: row.installation_id || null,
    maintenanceRecordId: row.maintenance_record_id || null,
    vehicleNo: row.vehicle_no || null,
    delta: Number(row.delta || 0),
    resultingQuantity: row.resulting_quantity != null ? Number(row.resulting_quantity) : null,
    note: row.note || null,
    createdBy: row.created_by || null,
    itemNameSnapshot: row.item_name_snapshot || null,
    createdAt: row.created_at,
  };
}

const STOCK_TX_TABLE_MISSING = "STOCK_TX_TABLE_MISSING";

function isMissingStockTxTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("stock_transactions") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("stock_transactions") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("stock_transactions"))
  );
}

async function fetchStockTransactions() {
  const { data, error } = await getDb()
    .from("stock_transactions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) {
    if (isMissingStockTxTableError(error)) {
      const e = new Error("stock_transactions table missing — please run stock-transactions-migration.sql in Supabase");
      e.code = STOCK_TX_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToStockTx);
}

async function insertStockTransaction(tx) {
  const { data, error } = await getDb()
    .from("stock_transactions")
    .insert({
      stock_item_id: tx.stockItemId || null,
      installation_id: tx.installationId || null,
      maintenance_record_id: tx.maintenanceRecordId || null,
      vehicle_no: tx.vehicleNo || null,
      delta: Number(tx.delta),
      resulting_quantity: tx.resultingQuantity != null ? Number(tx.resultingQuantity) : null,
      note: tx.note || null,
      created_by: tx.createdBy || null,
      item_name_snapshot: tx.itemNameSnapshot || null,
    })
    .select()
    .single();

  if (error) {
    if (isMissingStockTxTableError(error)) {
      const e = new Error("stock_transactions table missing — please run stock-transactions-migration.sql in Supabase");
      e.code = STOCK_TX_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToStockTx(data);
}

/* ============================================================
   DELETION AUDIT LOG
   Immutable record of every destructive action (with reason).
   ============================================================ */

function rowToDeletionLog(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id || null,
    entityLabel: row.entity_label || null,
    reason: row.reason || null,
    deletedBy: row.deleted_by || null,
    snapshot: row.snapshot || null,
    deletedAt: row.deleted_at,
  };
}

const DELETION_LOG_TABLE_MISSING = "DELETION_LOG_TABLE_MISSING";

function isMissingDeletionLogError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("deletion_log") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("deletion_log") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("deletion_log"))
  );
}

async function fetchDeletionLog(limit = 200) {
  const { data, error } = await getDb()
    .from("deletion_log")
    .select("*")
    .order("deleted_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingDeletionLogError(error)) {
      const e = new Error("deletion_log table missing — please run deletion-log-migration.sql in Supabase");
      e.code = DELETION_LOG_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToDeletionLog);
}

async function insertDeletionLog(entry) {
  const { error } = await getDb()
    .from("deletion_log")
    .insert({
      entity_type: entry.entityType,
      entity_id: entry.entityId || null,
      entity_label: entry.entityLabel || null,
      reason: entry.reason || null,
      deleted_by: entry.deletedBy || null,
      snapshot: entry.snapshot || null,
    });
  if (error) {
    if (isMissingDeletionLogError(error)) {
      // Don't throw — deletion still proceeds. Just warn.
      console.warn("deletion_log table missing — deletion was not audited.");
      return false;
    }
    console.warn("Deletion log write failed:", error.message);
    return false;
  }
  return true;
}

/* ============================================================
   SUPPLIERS TABLE
   Admin-managed list of suppliers used in the Stock page.
   ============================================================ */

function rowToSupplier(row) {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

const SUPPLIERS_TABLE_MISSING = "SUPPLIERS_TABLE_MISSING";

function isMissingSuppliersTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("suppliers") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("suppliers") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("suppliers"))
  );
}

async function fetchSuppliers() {
  const { data, error } = await getDb()
    .from("suppliers")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    if (isMissingSuppliersTableError(error)) {
      const e = new Error("suppliers table missing — please run suppliers-and-extras-migration.sql in Supabase");
      e.code = SUPPLIERS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToSupplier);
}

async function insertSupplier(name) {
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error("Supplier name cannot be empty.");
  const { data, error } = await getDb()
    .from("suppliers")
    .insert({ name: trimmed })
    .select()
    .single();
  if (error) {
    if ((error.message || "").toLowerCase().includes("duplicate")) {
      throw new Error(`Supplier "${trimmed}" already exists.`);
    }
    throw new Error(error.message);
  }
  return rowToSupplier(data);
}

async function deleteSupplier(id) {
  const { error } = await getDb().from("suppliers").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return true;
}

/* ============================================================
   INSTALLATION & MAINTENANCE DELETE
   Hard-delete an installation or repair entry. Auto-consume
   reversal is handled in app.js (consumeStockReverse).
   ============================================================ */

async function deleteInstallation(installationId) {
  const { error } = await getDb()
    .from("installations")
    .delete()
    .eq("id", installationId);
  if (error) throw new Error(error.message);
  return true;
}

async function deleteMaintenanceRecord(recordId) {
  const { error } = await getDb()
    .from("maintenance_records")
    .delete()
    .eq("id", recordId);
  if (error) throw new Error(error.message);
  return true;
}

/* ============================================================
   STOCK CATEGORIES TABLE
   Admin-managed list of categories used in the Stock page.
   ============================================================ */

function rowToCategory(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}

const STOCK_CATEGORIES_TABLE_MISSING = "STOCK_CATEGORIES_TABLE_MISSING";

function isMissingCategoriesTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("stock_categories") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("stock_categories") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("stock_categories"))
  );
}

async function fetchStockCategories() {
  const { data, error } = await getDb()
    .from("stock_categories")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    if (isMissingCategoriesTableError(error)) {
      const e = new Error("stock_categories table missing — please run stock-categories-migration.sql in Supabase");
      e.code = STOCK_CATEGORIES_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToCategory);
}

async function insertStockCategory(name) {
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error("Category name cannot be empty.");
  const { data, error } = await getDb()
    .from("stock_categories")
    .insert({ name: trimmed })
    .select()
    .single();
  if (error) {
    // Unique violation -> friendlier message
    if ((error.message || "").toLowerCase().includes("duplicate")) {
      throw new Error(`Category "${trimmed}" already exists.`);
    }
    throw new Error(error.message);
  }
  return rowToCategory(data);
}

async function deleteStockCategory(id) {
  const { error } = await getDb().from("stock_categories").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return true;
}

// Realtime subscription. onChange(eventType, payload):
//   eventType = 'status' : connection status changes
//   eventType = 'data'   : a row changed in any subscribed table
function subscribeRealtime(onChange) {
  const client = getDb();
  const channel = client
    .channel("gps-tracker-stream")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "installations" },
      (payload) => onChange("data", { table: "installations", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "maintenance_records" },
      (payload) => onChange("data", { table: "maintenance_records", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "sims" },
      (payload) => onChange("data", { table: "sims", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "stock_items" },
      (payload) => onChange("data", { table: "stock_items", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "stock_transactions" },
      (payload) => onChange("data", { table: "stock_transactions", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "stock_categories" },
      (payload) => onChange("data", { table: "stock_categories", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "suppliers" },
      (payload) => onChange("data", { table: "suppliers", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "deletion_log" },
      (payload) => onChange("data", { table: "deletion_log", payload })
    )
    .subscribe((status) => onChange("status", { status }));
  return channel;
}

async function unsubscribeRealtime(channel) {
  if (!channel) return;
  try {
    await getDb().removeChannel(channel);
  } catch (_) {
    // ignore
  }
}
