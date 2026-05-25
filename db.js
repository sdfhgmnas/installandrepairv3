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
  supabaseClient = window.supabase.createClient(
    url,
    anonKey
  );
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
    imeiHistory: row.imei_history || [],
    simHistory: row.sim_history || [],
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
    imei_history: inst.imeiHistory,
    sim_history: inst.simHistory,
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
    oldSimNo: row.old_sim_no,
    oldImei: row.old_imei,
    simDeactivationPending: row.sim_deactivation_pending,
    simDeactivated: row.sim_deactivated,
    simDeactivatedAt: row.sim_deactivated_at,
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
    old_sim_no: record.oldSimNo,
    old_imei: record.oldImei,
    sim_deactivation_pending: record.simDeactivationPending,
    sim_deactivated: record.simDeactivated,
    sim_deactivated_at: record.simDeactivatedAt,
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

async function updateInstallation(inst) {
  const { data, error } = await getDb()
    .from("installations")
    .update({
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
    })
    .eq("id", record.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToMaintenance(data);
}
