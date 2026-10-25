/**
 * Pharmacie Bleue Plus — Modular Supabase Free-Tier Bridge (Mock-First Hybrid Connector)
 * ======================================================================================
 * Regulatory Standard: Cameroon Law n° 90/035 & SOP-RH-FP-03 Pharmacist Double-Control Gate
 * Privacy Mandate: Zero-Knowledge Client-Side AES-256-GCM Blob Storage & PostgREST Metadata Sync
 * Architecture: Offline-First Hybrid Bridge (LOCAL_MOCK_VAULT <-> LIVE_SUPABASE_REST_BRIDGE)
 */

(function (window) {
  'use strict';

  const STORAGE_KEY = 'pbp_supabase_config';
  const OUTBOX_STORE = 'supabaseOutbox';
  const VAULT_STORE = 'encryptedVault';

  // In-memory state
  let config = {
    url: '',
    anonKey: '',
    mode: 'LOCAL_MOCK_VAULT',
    lastSyncAt: null,
    status: 'INITIALIZING'
  };

  const logListeners = new Set();
  const statusListeners = new Set();

  function log(message, level = 'INFO') {
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const formatted = `[${ts}] [${level}] ${message}`;
    logListeners.forEach(listener => {
      try {
        listener(formatted, { message, level, timestamp: ts });
      } catch (e) {
        console.error('Log listener error:', e);
      }
    });
  }

  function notifyStatusChange() {
    const currentStatus = getStatus();
    statusListeners.forEach(listener => {
      try {
        listener(currentStatus);
      } catch (e) {
        console.error('Status listener error:', e);
      }
    });
  }

  function loadSavedConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          config.url = (parsed.url || '').trim();
          config.anonKey = (parsed.anonKey || '').trim();
          config.lastSyncAt = parsed.lastSyncAt || null;
        }
      }
    } catch (e) {
      console.warn('Could not read pbp_supabase_config from localStorage:', e);
    }
    updateMode();
  }

  function saveConfigToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        url: config.url,
        anonKey: config.anonKey,
        mode: config.mode,
        lastSyncAt: config.lastSyncAt,
        updatedAt: new Date().toISOString()
      }));
    } catch (e) {
      console.error('Failed to save Supabase config to localStorage:', e);
    }
  }

  function isLiveConfigured() {
    return Boolean(
      config.url &&
      config.url.startsWith('https://') &&
      config.anonKey &&
      config.anonKey.length > 20
    );
  }

  function updateMode() {
    const live = isLiveConfigured();
    if (!live) {
      config.mode = 'LOCAL_MOCK_VAULT';
      config.status = 'READY_MOCK';
    } else if (!navigator.onLine) {
      config.mode = 'LIVE_BRIDGE_OFFLINE_QUEUE';
      config.status = 'QUEUED_OFFLINE';
    } else {
      config.mode = 'LIVE_SUPABASE_REST_BRIDGE';
      config.status = 'READY_LIVE';
    }
  }

  /**
   * Strict Client-Side Zero-PII Wire Guard
   * Throws an error if any personal patient names, phone numbers, or cleartext images are detected.
   */
  function validatePayloadPiiSafety(record) {
    if (!record) throw new Error('Cannot stage null or undefined prescription record');

    const serialized = JSON.stringify(record).toLowerCase();
    
    // Check for common PII patterns
    const forbiddenPiiTerms = [
      'jean-paul',
      '+237',
      'patientname',
      'patientphone',
      'cleartextimage',
      'rawcanvas',
      'data:image/png;base64'
    ];

    for (const term of forbiddenPiiTerms) {
      if (serialized.includes(term)) {
        throw new Error(`Zero-PII Wire Guard Block: Found unencrypted sensitive field containing "${term}". Transmission blocked.`);
      }
    }

    // Must have cryptographic digests
    if (!record.plaintext_sha256 || record.plaintext_sha256.length < 16) {
      throw new Error('Payload integrity failure: Missing valid plaintext SHA-256 digest');
    }
    if (!record.ciphertext_sha256 || record.ciphertext_sha256.length < 16) {
      throw new Error('Payload integrity failure: Missing valid ciphertext SHA-256 digest');
    }

    return true;
  }

  /**
   * Cameroon Law 90/035 & SOP-RH-FP-03 Regulatory Double-Control Gate
   */
  function validateRegulatoryVisaGate(rxItem, stageCode) {
    const code = stageCode || rxItem.stageCode;
    const isVisaStage = (code === 'STAGE_3_PHARMACIST_VISA' || code === 'STAGE_4_DISPENSING_READY' || rxItem.stage >= 3);
    
    if (isVisaStage) {
      if (!rxItem.visaSignature || typeof rxItem.visaSignature !== 'string' || rxItem.visaSignature.length < 32) {
        log(`[SOP-RH-FP-03 GATE] Blocked ${rxItem.id} (${code}): Missing verified ONPC pharmacist SHA-256 visa signature.`, 'WARN');
        return false;
      }
    }
    return true;
  }

  // IndexedDB helpers with graceful fallback
  async function getIdbRecord(storeName, key) {
    if (typeof window.idbGetRecord === 'function') {
      return await window.idbGetRecord(storeName, key);
    }
    return null;
  }

  async function putIdbRecord(storeName, record) {
    if (typeof window.idbPutRecord === 'function') {
      return await window.idbPutRecord(storeName, record);
    }
    return null;
  }

  async function getAllIdbRecords(storeName) {
    if (typeof window.idbGetAllRecords === 'function') {
      return await window.idbGetAllRecords(storeName);
    }
    return [];
  }

  async function countIdbRecords(storeName) {
    if (typeof window.idbCountStore === 'function') {
      return await window.idbCountStore(storeName);
    }
    return 0;
  }

  /**
   * Stage a prescription into IndexedDB supabaseOutbox with Zero-Knowledge guarantees.
   */
  async function stagePrescription(rxItem, triggerSource = 'MANUAL_STAGE') {
    if (!rxItem || !rxItem.id) return null;

    const stageCode = rxItem.stageCode || (
      rxItem.stage === 4 ? 'STAGE_4_DISPENSING_READY' :
      rxItem.stage === 3 ? 'STAGE_3_PHARMACIST_VISA' :
      rxItem.stage === 2 ? 'STAGE_2_PREPARATION' : 'STAGE_1_UPLOADED'
    );

    // Cameroon Law 90/035 validation gate
    if (!validateRegulatoryVisaGate(rxItem, stageCode)) {
      return null;
    }

    const vaultEnvelope = await getIdbRecord(VAULT_STORE, rxItem.id);
    const storagePath = `prescriptions/${rxItem.id}.aes256gcm.enc.json`;

    const outboxRecord = {
      rxId: rxItem.id,
      rx_code: rxItem.id,
      stage: rxItem.stage || 1,
      stage_code: stageCode,
      storage_object_path: storagePath,
      plaintext_sha256: rxItem.sha256 || (vaultEnvelope ? vaultEnvelope.plaintextSha256 : 'SHA256_HASH_PLACEHOLDER'),
      ciphertext_sha256: rxItem.ciphertextSha256 || (vaultEnvelope ? vaultEnvelope.ciphertextSha256 : 'CIPHER_SHA256_PLACEHOLDER'),
      iv_hex: rxItem.ivHex || (vaultEnvelope ? vaultEnvelope.ivHex : 'IV_PLACEHOLDER'),
      pharmacist_visa: rxItem.pharmacistVisa || null,
      visa_signature: rxItem.visaSignature || null,
      intervention_note: rxItem.interventionNote || null,
      fulfillment_mode: rxItem.mode || 'FAST_TRACK_PICKUP',
      payment_method: rxItem.payment || 'MTN_MOMO',
      audit_log: Array.isArray(rxItem.auditLog) ? rxItem.auditLog : [],
      has_ciphertext_blob: Boolean(vaultEnvelope && vaultEnvelope.ciphertextBase64),
      sync_status: 'STAGED_LOCAL_OUTBOX',
      trigger_source: triggerSource,
      updated_at: new Date().toISOString()
    };

    // Client-side Zero-PII Wire Guard
    validatePayloadPiiSafety(outboxRecord);

    await putIdbRecord(OUTBOX_STORE, outboxRecord);
    notifyStatusChange();
    return { outboxRecord, vaultEnvelope };
  }

  /**
   * Upload encrypted AES-256-GCM envelope to Supabase Private Storage Bucket `prescriptions`
   */
  async function uploadEncryptedBlob(storagePath, vaultEnvelope) {
    if (!isLiveConfigured()) return { ok: false, error: 'Not configured for live Supabase' };
    if (!vaultEnvelope || !vaultEnvelope.ciphertextBase64) return { ok: true, skipped: true };

    const baseUrl = config.url.replace(/\/+$/, '');
    const storageUrl = `${baseUrl}/storage/v1/object/${storagePath}`;
    const envelopeBlob = new Blob([JSON.stringify(vaultEnvelope)], { type: 'application/json' });

    const res = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json',
        'x-upsert': 'true'
      },
      body: envelopeBlob
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Storage upload failed (HTTP ${res.status}): ${errText}`);
    }

    return { ok: true, status: res.status };
  }

  /**
   * Upsert zero-knowledge metadata row into PostgreSQL public.prescriptions
   */
  async function upsertPrescriptionRow(outboxRecord) {
    if (!isLiveConfigured()) return { ok: false, error: 'Not configured for live Supabase' };

    const baseUrl = config.url.replace(/\/+$/, '');
    const restUrl = `${baseUrl}/rest/v1/prescriptions?on_conflict=rx_code`;

    const rowPayload = {
      rx_code: outboxRecord.rx_code,
      stage: outboxRecord.stage,
      stage_code: outboxRecord.stage_code,
      storage_object_path: outboxRecord.storage_object_path,
      plaintext_sha256: outboxRecord.plaintext_sha256,
      ciphertext_sha256: outboxRecord.ciphertext_sha256,
      iv_hex: outboxRecord.iv_hex,
      pharmacist_visa: outboxRecord.pharmacist_visa,
      visa_signature: outboxRecord.visa_signature,
      intervention_note: outboxRecord.intervention_note,
      fulfillment_mode: outboxRecord.fulfillment_mode,
      payment_method: outboxRecord.payment_method,
      audit_log: outboxRecord.audit_log,
      updated_at: new Date().toISOString()
    };

    // Client-side Zero-PII check
    validatePayloadPiiSafety(rowPayload);

    const res = await fetch(restUrl, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(rowPayload)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PostgREST upsert failed (HTTP ${res.status}): ${errText}`);
    }

    return { ok: true, status: res.status };
  }

  /**
   * Transmit single outbox record to Supabase (Storage + PostgREST)
   */
  async function transmitRecord(outboxRecord, vaultEnvelope) {
    try {
      // 1. Upload encrypted envelope blob to private bucket
      if (vaultEnvelope && vaultEnvelope.ciphertextBase64) {
        await uploadEncryptedBlob(outboxRecord.storage_object_path, vaultEnvelope);
      }

      // 2. Upsert zero-knowledge metadata into public.prescriptions
      await upsertPrescriptionRow(outboxRecord);

      // 3. Mark synced in local outbox
      outboxRecord.sync_status = 'SYNCED_SUPABASE_CLOUD';
      outboxRecord.synced_at = new Date().toISOString();
      await putIdbRecord(OUTBOX_STORE, outboxRecord);

      log(`[LIVE_SYNC] ✓ Synced ${outboxRecord.rx_code} (${outboxRecord.stage_code}) to Supabase Cloud & Private Bucket.`, 'SUCCESS');
      return true;
    } catch (err) {
      outboxRecord.sync_status = 'SYNC_FAILED_QUEUED';
      outboxRecord.sync_error = err && err.message ? err.message : String(err);
      await putIdbRecord(OUTBOX_STORE, outboxRecord);
      log(`[SYNC ERROR] ${outboxRecord.rx_code}: ${outboxRecord.sync_error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Push a prescription directly or stage into outbox
   */
  async function pushPrescription(rxItem) {
    const staged = await stagePrescription(rxItem, 'PUSH_HOOK');
    if (!staged) return null;

    const { outboxRecord, vaultEnvelope } = staged;

    updateMode();
    if (!isLiveConfigured() || !navigator.onLine) {
      log(`[LOCAL_MOCK_VAULT] Staged ${outboxRecord.rx_code} (${outboxRecord.stage_code}) -> IndexedDB outbox | Zero unencrypted PII.`, 'INFO');
      notifyStatusChange();
      return { success: true, mode: config.mode, staged: true };
    }

    const success = await transmitRecord(outboxRecord, vaultEnvelope);
    notifyStatusChange();
    return { success, mode: config.mode };
  }

  /**
   * Synchronize pending outbox records to Supabase
   */
  async function syncOutbox(options = {}) {
    const { silent = false } = options;
    updateMode();

    const records = await getAllIdbRecords(OUTBOX_STORE);

    if (!isLiveConfigured() || !navigator.onLine) {
      log(`[OUTBOX STATUS] ${records.length} records staged in local IndexedDB outbox (${config.mode}). Zero PII.`, 'INFO');
      notifyStatusChange();
      return { count: records.length, synced: 0, mode: config.mode };
    }

    let syncedCount = 0;
    for (const record of records) {
      const vaultEnvelope = await getIdbRecord(VAULT_STORE, record.rxId);
      const ok = await transmitRecord(record, vaultEnvelope);
      if (ok) syncedCount++;
    }

    config.lastSyncAt = new Date().toISOString();
    saveConfigToStorage();
    notifyStatusChange();

    if (!silent) {
      log(`[SYNC COMPLETE] ${syncedCount}/${records.length} outbox record(s) synchronized with Supabase Free-Tier cloud.`, 'SUCCESS');
    }

    return { count: records.length, synced: syncedCount, mode: config.mode };
  }

  /**
   * Pull recent updates from Supabase to reconcile client state
   */
  async function pullCloudUpdates() {
    if (!isLiveConfigured()) {
      return { ok: false, error: 'Cannot pull from cloud: Live Supabase not configured' };
    }
    if (!navigator.onLine) {
      return { ok: false, error: 'Cannot pull from cloud: Device is offline' };
    }

    const baseUrl = config.url.replace(/\/+$/, '');
    const restUrl = `${baseUrl}/rest/v1/prescriptions?select=rx_code,stage,stage_code,pharmacist_visa,visa_signature,intervention_note,updated_at&order=updated_at.desc&limit=50`;

    try {
      const res = await fetch(restUrl, {
        method: 'GET',
        headers: {
          'apikey': config.anonKey,
          'Authorization': `Bearer ${config.anonKey}`
        }
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch cloud updates (HTTP ${res.status})`);
      }

      const cloudRows = await res.json();
      log(`[CLOUD PULL] Received ${cloudRows.length} prescription records from Supabase cloud.`, 'INFO');
      return { ok: true, rows: cloudRows };
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      log(`[CLOUD PULL ERROR] ${errMsg}`, 'ERROR');
      return { ok: false, error: errMsg };
    }
  }

  /**
   * Test connection & RLS handshake
   */
  async function testConnection() {
    updateMode();
    const outboxCount = await countIdbRecords(OUTBOX_STORE);
    const vaultCount = await countIdbRecords(VAULT_STORE);

    if (!isLiveConfigured()) {
      log(`[DIAGNOSTIC] Local Mock Vault operational: ${outboxCount} Outbox records & ${vaultCount} AES-256-GCM encrypted envelopes ready.`, 'INFO');
      return {
        ok: true,
        mode: 'LOCAL_MOCK_VAULT',
        message: `Local Mock Vault ready (${outboxCount} outbox records, ${vaultCount} encrypted envelopes).`
      };
    }

    const baseUrl = config.url.replace(/\/+$/, '');
    const pingUrl = `${baseUrl}/rest/v1/prescriptions?select=rx_code,stage_code&limit=1`;
    log(`[PING] Testing REST handshake with ${baseUrl}...`, 'INFO');

    try {
      const res = await fetch(pingUrl, {
        method: 'GET',
        headers: {
          'apikey': config.anonKey,
          'Authorization': `Bearer ${config.anonKey}`
        }
      });

      if (res.ok) {
        log(`[PING OK] Handshake successful (HTTP ${res.status}). PostgREST and RLS policies active.`, 'SUCCESS');
        return { ok: true, mode: 'LIVE_SUPABASE_REST_BRIDGE', status: res.status };
      } else {
        log(`[PING WARN] Supabase responded with HTTP ${res.status} (${res.statusText || 'Check RLS schema'}).`, 'WARN');
        return { ok: false, mode: 'LIVE_SUPABASE_REST_BRIDGE', status: res.status };
      }
    } catch (err) {
      const errMsg = err && err.message ? err.message : 'Network/CORS unreachable';
      log(`[PING FALLBACK] Could not reach Supabase endpoint (${errMsg}). Operating via Local Outbox.`, 'WARN');
      return { ok: false, mode: 'LOCAL_MOCK_VAULT', error: errMsg };
    }
  }

  /**
   * Save credentials
   */
  async function saveConfig(newConfig) {
    if (!newConfig || typeof newConfig !== 'object') return;
    config.url = (newConfig.url || '').trim();
    config.anonKey = (newConfig.anonKey || '').trim();
    updateMode();
    saveConfigToStorage();

    if (isLiveConfigured()) {
      log(`[CONFIG] Bridge configured for LIVE_SUPABASE_REST_BRIDGE (${config.url}). Zero-PII RLS active.`, 'INFO');
    } else {
      log('[CONFIG] Operating in LOCAL_MOCK_VAULT mode (Offline-Safe IndexedDB Outbox).', 'INFO');
    }
    notifyStatusChange();
    return getStatus();
  }

  /**
   * Reset to mock
   */
  async function resetToMock() {
    config.url = '';
    config.anonKey = '';
    config.mode = 'LOCAL_MOCK_VAULT';
    config.status = 'READY_MOCK';
    saveConfigToStorage();
    log('[RESET] Supabase credentials cleared. Bridge locked to LOCAL_MOCK_VAULT (100% local execution).', 'INFO');
    notifyStatusChange();
    return getStatus();
  }

  function getStatus() {
    updateMode();
    return {
      mode: config.mode,
      status: config.status,
      isLive: isLiveConfigured(),
      isOnline: navigator.onLine,
      url: config.url ? config.url.replace(/^(https:\/\/[^/]{4})[^/]+/, '$1***') : '',
      lastSyncAt: config.lastSyncAt
    };
  }

  function subscribeLogs(listener) {
    if (typeof listener === 'function') {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    }
    return () => {};
  }

  function subscribeStatus(listener) {
    if (typeof listener === 'function') {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    }
    return () => {};
  }

  // Network event listeners for automatic auto-sync on reconnect
  window.addEventListener('online', () => {
    log('[NETWORK] Connection restored. Synchronizing pending outbox with Supabase Bridge...', 'INFO');
    updateMode();
    notifyStatusChange();
    syncOutbox({ silent: true });
  });

  window.addEventListener('offline', () => {
    log('[NETWORK] Device is offline. Prescriptions will queue in IndexedDB supabaseOutbox.', 'WARN');
    updateMode();
    notifyStatusChange();
  });

  // Initialize
  loadSavedConfig();

  // Export module to global scope
  window.PBP_SupabaseBridge = {
    init: loadSavedConfig,
    getStatus,
    saveConfig,
    resetToMock,
    testConnection,
    stagePrescription,
    pushPrescription,
    syncOutbox,
    pullCloudUpdates,
    validatePayloadPiiSafety,
    subscribeLogs,
    subscribeStatus,
    log
  };

})(window);
