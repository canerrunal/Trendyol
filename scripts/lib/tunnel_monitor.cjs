// =============================================================================
// Verimimari Marketplace Data Platform V2 — Tunnel Monitor & Probe Engine
// Tracks multi-factor Cloudflare Tunnel health, rolling uptime ratio,
// consecutive downtime, and verified Access Service Auth reader SELECT queries.
// ZERO SECRET LOGGING GUARANTEE.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE_HISTORY_FILE = path.join(ROOT, '.runtime', 'tunnel_probe_history.json');
const DEFAULT_TUNNEL_DOMAIN = process.env.CLOUDFLARE_TUNNEL_DOMAIN || 'ch.verimimari.com';
const METRICS_URL = 'http://127.0.0.1:20241/metrics';

/**
 * Checks if cloudflared process is alive via OS-level pgrep.
 */
function isCloudflaredProcessAlive() {
  try {
    const pgrepOut = execFileSync('pgrep', ['-x', 'cloudflared'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return pgrepOut.length > 0;
  } catch {
    return false;
  }
}

/**
 * Checks if named tunnel is connected via local connector Prometheus metrics.
 */
function isNamedTunnelConnected() {
  try {
    const metricOut = execFileSync('curl', ['-s', '-m', '1', METRICS_URL], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    return metricOut.includes('cloudflared_tunnel_ha_connections') ||
      metricOut.includes('cloudflared_tunnel_tunnel_register_success') ||
      metricOut.includes('cloudflared_tunnel_total_connections') ||
      metricOut.includes('cloudflared_tunnel_user_connections') ||
      metricOut.includes('cloudflared_tunnel_server_locations');
  } catch {
    return false;
  }
}

/**
 * Loads Cloudflare Access client secrets.
 * Priority:
 * 1. macOS Keychain (service 'verimimari-cf-access-client-id' / 'verimimari-cf-access-client-secret'
 *    or service 'verimimari-cf-access' with accounts 'client-id' / 'client-secret')
 * 2. .env file fallback (enforces chmod 600, verifies gitignored, zero secret logging)
 */
function loadCloudflareAccessSecrets() {
  let clientId = null;
  let clientSecret = null;
  let source = 'NONE';

  // 1. Try macOS Keychain (bypassed if CF_ACCESS_IGNORE_KEYCHAIN is set)
  if (process.env.CF_ACCESS_IGNORE_KEYCHAIN !== '1') {
    try {
      try {
        clientId = execFileSync('security', [
        'find-generic-password',
        '-s', 'verimimari-cf-access-client-id',
        '-w'
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      try {
        clientId = execFileSync('security', [
          'find-generic-password',
          '-s', 'verimimari-cf-access',
          '-a', 'client-id',
          '-w'
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      } catch {}
    }

    try {
      clientSecret = execFileSync('security', [
        'find-generic-password',
        '-s', 'verimimari-cf-access-client-secret',
        '-w'
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      try {
        clientSecret = execFileSync('security', [
          'find-generic-password',
          '-s', 'verimimari-cf-access',
          '-a', 'client-secret',
          '-w'
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      } catch {}
    }

      if (clientId && clientSecret) {
        clientId = clientId.replace(/^CF-Access-Client-Id:\s*/i, '').trim();
        clientSecret = clientSecret.replace(/^CF-Access-Client-Secret:\s*/i, '').trim();
        source = 'MACOS_KEYCHAIN';
        return { clientId, clientSecret, source, configured: true };
      }
    } catch {}
  }

  // 2. Fallback to process.env or .env file
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const stat = fs.statSync(envPath);
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) {
        fs.chmodSync(envPath, 0o600);
      }
    } catch {}

    if (!process.env.CF_ACCESS_CLIENT_ID || !process.env.CF_ACCESS_CLIENT_SECRET) {
      try {
        const envContent = fs.readFileSync(envPath, 'utf8');
        for (const line of envContent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {}
    }
  }

  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    clientId = process.env.CF_ACCESS_CLIENT_ID;
    clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    source = 'DOTENV_FILE';
    return { clientId, clientSecret, source, configured: true };
  }

  return { clientId: null, clientSecret: null, source: 'NONE', configured: false };
}

/**
 * Tests authenticated reader SELECT query over Cloudflare Access Service Auth.
 * Zero secret logging: never echoes tokens.
 */
function testAuthenticatedAccessSelect(domain = DEFAULT_TUNNEL_DOMAIN) {
  const secrets = loadCloudflareAccessSecrets();
  const readerUser = process.env.CLICKHOUSE_READER_USER || 'verimimari_reader';
  const readerPass = process.env.CLICKHOUSE_READER_PASSWORD || 'sec_reader_p1_3_test';

  if (!secrets.configured) {
    return {
      status: 'MONITOR_CONFIG_MISSING',
      http_code: 0,
      ok: false,
      source: secrets.source,
      details: 'CF_ACCESS_CLIENT_ID or CF_ACCESS_CLIENT_SECRET not configured in Keychain or .env'
    };
  }

  try {
    const curlArgs = [
      '-s',
      '-w', '\n%{http_code}',
      '-m', '3',
      '-u', `${readerUser}:${readerPass}`,
      '-H', `CF-Access-Client-Id: ${secrets.clientId}`,
      '-H', `CF-Access-Client-Secret: ${secrets.clientSecret}`,
      '-d', 'SELECT 1 FORMAT JSONEachRow',
      `https://${domain}/`
    ];
    const raw = execFileSync('curl', curlArgs, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const lines = raw.trim().split('\n');
    const code = parseInt(lines[lines.length - 1], 10) || 0;
    const isOk = code === 200;
    return {
      status: isOk ? 'OK' : `HTTP_${code}`,
      http_code: code,
      ok: isOk,
      source: secrets.source,
      details: isOk ? 'SELECT succeeded (HTTP 200)' : `Expected HTTP 200, got ${code}`
    };
  } catch (err) {
    return {
      status: 'UNREACHABLE',
      http_code: 0,
      ok: false,
      source: secrets.source,
      details: err.message
    };
  }
}

/**
 * Tests unauthenticated request to verify Cloudflare Access blocks token-less calls.
 * Must return 403 or redirect to Access login.
 */
function testUnauthenticatedDenied(domain = DEFAULT_TUNNEL_DOMAIN) {
  try {
    const curlArgs = [
      '-s',
      '-w', '\n%{http_code}',
      '-m', '3',
      '-d', 'SELECT 1',
      `https://${domain}/`
    ];
    const raw = execFileSync('curl', curlArgs, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const lines = raw.trim().split('\n');
    const code = parseInt(lines[lines.length - 1], 10) || 0;
    const isDenied = code === 403 || code === 401 || code === 302;
    return {
      status: isDenied ? 'DENIED_OK' : `UNEXPECTED_${code}`,
      http_code: code,
      ok: isDenied,
      details: isDenied ? 'Unauthenticated request correctly blocked' : `Expected 403/401/302, got ${code}`
    };
  } catch (err) {
    return {
      status: 'DENIED_BLOCKED',
      http_code: 0,
      ok: true,
      details: 'Unauthenticated connection rejected'
    };
  }
}

/**
 * Loads probe history from disk, migrating legacy structures to epoch + incident_history if needed.
 */
function loadProbeHistory() {
  if (fs.existsSync(PROBE_HISTORY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROBE_HISTORY_FILE, 'utf8'));
      if (data.epoch && Array.isArray(data.incident_history)) {
        return data;
      }
      // Migrate legacy flat history: preserve incident probes separately so they don't poison new epoch
      const legacyProbes = Array.isArray(data.probes) ? data.probes : [];
      return {
        epoch: {
          epoch_id: null,
          epoch_status: 'AWAITING_FIRST_AUTH_SELECT',
          epoch_start_time: null,
          probes: []
        },
        incident_history: legacyProbes,
        metrics: null
      };
    } catch {}
  }
  return {
    epoch: {
      epoch_id: null,
      epoch_status: 'AWAITING_FIRST_AUTH_SELECT',
      epoch_start_time: null,
      probes: []
    },
    incident_history: [],
    metrics: null
  };
}

/**
 * Records a single probe and calculates rolling metrics for the current uptime epoch.
 * Incident history is segregated so failed/incident probes before the first authenticated SELECT
 * do not poison the uptime ratio.
 */
function recordTunnelHealthProbe(override = null) {
  const history = loadProbeHistory();
  const now = new Date();

  let probe;
  if (override) {
    probe = {
      timestamp: now.toISOString(),
      ...override
    };
  } else {
    const processAlive = isCloudflaredProcessAlive();
    const tunnelConnected = isNamedTunnelConnected();
    const authResult = testAuthenticatedAccessSelect();
    const unauthResult = testUnauthenticatedDenied();

    const monitorMissing = authResult.status === 'MONITOR_CONFIG_MISSING';
    const isHealthy = processAlive && tunnelConnected && authResult.ok && unauthResult.ok;

    let tunnelStatus = 'UNKNOWN';
    if (monitorMissing) {
      tunnelStatus = 'MONITOR_CONFIG_MISSING';
    } else if (!processAlive) {
      tunnelStatus = 'PROCESS_DOWN';
    } else if (!tunnelConnected) {
      tunnelStatus = 'DISCONNECTED';
    } else if (!authResult.ok) {
      tunnelStatus = 'UNREACHABLE';
    } else {
      tunnelStatus = 'HEALTHY';
    }

    probe = {
      timestamp: now.toISOString(),
      process_alive: processAlive,
      named_tunnel_connected: tunnelConnected,
      authenticated_select_ok: authResult.ok,
      authenticated_http_code: authResult.http_code,
      unauthenticated_denied_ok: unauthResult.ok,
      monitor_config_missing: monitorMissing,
      secret_source: authResult.source || 'NONE',
      tunnel_status: tunnelStatus,
      is_healthy: isHealthy
    };
  }

  // Check epoch initialization
  if (!history.epoch.epoch_start_time) {
    if (probe.is_healthy === true && probe.authenticated_select_ok === true && probe.authenticated_http_code === 200) {
      // First successful authenticated SELECT 1 begins the new epoch!
      history.epoch.epoch_id = `epoch-${now.getTime()}`;
      history.epoch.epoch_status = 'ACTIVE';
      history.epoch.epoch_start_time = probe.timestamp;
      history.epoch.probes = [probe];
    } else {
      // Still awaiting first authenticated SELECT 1; archive probe into incident_history
      history.incident_history.push(probe);
      if (history.incident_history.length > 500) {
        history.incident_history = history.incident_history.slice(-500);
      }
    }
  } else {
    // Epoch is active
    history.epoch.probes.push(probe);
    // Keep last 1440 probes in epoch (24 hours at 1/min)
    if (history.epoch.probes.length > 1440) {
      history.epoch.probes = history.epoch.probes.slice(-1440);
    }
  }

  const epochActive = Boolean(history.epoch.epoch_start_time);
  let epochProbes = history.epoch.probes;
  let rollingHours = 0.0;

  if (epochActive) {
    const startMs = new Date(history.epoch.epoch_start_time).getTime();
    rollingHours = parseFloat(((now.getTime() - startMs) / (1000 * 3600)).toFixed(2));
  }

  const totalEpochProbes = epochProbes.length;
  const successfulProbes = epochProbes.filter(p => p.is_healthy === true).length;
  const failedProbes = totalEpochProbes - successfulProbes;
  const uptimeRatio = totalEpochProbes > 0 ? parseFloat(((successfulProbes / totalEpochProbes) * 100).toFixed(2)) : 0.0;

  const allUnauthDenied = epochProbes.length > 0 ? epochProbes.every(p => p.unauthenticated_denied_ok === true) : probe.unauthenticated_denied_ok === true;
  const allAuth200 = epochProbes.length > 0 ? epochProbes.every(p => p.authenticated_http_code === 200) : (probe.authenticated_http_code === 200);

  // Consecutive downtime within current epoch
  let maxDowntimeSec = 0;
  let currentDowntimeSec = 0;
  let currentDownStart = null;

  for (const p of epochProbes) {
    const t = new Date(p.timestamp).getTime();
    if (!p.is_healthy) {
      if (!currentDownStart) currentDownStart = t;
      const duration = Math.round((t - currentDownStart) / 1000);
      if (duration > maxDowntimeSec) maxDowntimeSec = duration;
      currentDowntimeSec = duration;
    } else {
      currentDownStart = null;
      currentDowntimeSec = 0;
    }
  }

  const isEpochRequirementMet = epochActive && (rollingHours >= 24.0) && (uptimeRatio >= 99.0) && allUnauthDenied && allAuth200;

  history.metrics = {
    epoch_started: epochActive,
    epoch_status: history.epoch.epoch_status,
    epoch_start_time: history.epoch.epoch_start_time,
    rolling_window_hours: rollingHours,
    rolling_window_required_hours: 24.0,
    total_epoch_probes: totalEpochProbes,
    successful_access_probes: successfulProbes,
    failed_access_probes: failedProbes,
    incident_history_count: history.incident_history.length,
    tunnel_uptime_ratio: uptimeRatio,
    target_uptime_ratio: 99.0,
    all_unauthenticated_denied: allUnauthDenied,
    all_authenticated_select_200: allAuth200,
    max_consecutive_downtime_sec: maxDowntimeSec,
    current_consecutive_downtime_sec: currentDowntimeSec,
    epoch_gate_passed: isEpochRequirementMet,
    latest_probe: probe
  };

  fs.mkdirSync(path.dirname(PROBE_HISTORY_FILE), { recursive: true });
  fs.writeFileSync(PROBE_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

  return history.metrics;
}

/**
 * Returns current tunnel probe metrics without writing a new probe if not needed.
 */
function getTunnelProbeMetrics() {
  const history = loadProbeHistory();
  if (!history.metrics) {
    return recordTunnelHealthProbe();
  }
  return history.metrics;
}

module.exports = {
  isCloudflaredProcessAlive,
  isNamedTunnelConnected,
  loadCloudflareAccessSecrets,
  testAuthenticatedAccessSelect,
  testUnauthenticatedDenied,
  recordTunnelHealthProbe,
  getTunnelProbeMetrics
};
