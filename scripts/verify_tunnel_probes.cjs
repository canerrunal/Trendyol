// =============================================================================
// Verimimari Marketplace Data Platform V2 — Cloudflare Tunnel Probe Verifier
// Tests:
// 1. cloudflared process alive
// 2. named tunnel connected (127.0.0.1:20241/metrics)
// 3. ch.verimimari.com reachability
// 4. Authenticated reader SELECT = 200
// 5. Token-less unauthenticated request = 403 / Access Denied
// 6. Uptime ratio & probe history
// ZERO SECRET LOGGING GUARANTEE.
// =============================================================================

'use strict';

const {
  isCloudflaredProcessAlive,
  isNamedTunnelConnected,
  testAuthenticatedAccessSelect,
  testUnauthenticatedDenied,
  recordTunnelHealthProbe,
  getTunnelProbeMetrics
} = require('./lib/tunnel_monitor.cjs');

function main() {
  console.log('=============================================================================');
  console.log('  CLOUDFLARE NAMED TUNNEL & ACCESS MULTI-FACTOR VERIFICATION');
  console.log('=============================================================================');

  // 1. Process alive check
  const processAlive = isCloudflaredProcessAlive();
  console.log(`1. cloudflared Process Alive:        ${processAlive ? 'PASS (PID running)' : 'FAIL (Process Down)'}`);

  // 2. Named tunnel connected check
  const tunnelConnected = isNamedTunnelConnected();
  console.log(`2. Named Tunnel Connected:          ${tunnelConnected ? 'PASS (Edge Connected)' : 'FAIL (Disconnected)'}`);

  // 3. Authenticated Access Token + Reader SELECT check
  const authSelect = testAuthenticatedAccessSelect();
  console.log(`3. Access Protected Reader SELECT:   ${authSelect.ok ? 'PASS (HTTP 200)' : `FAIL (${authSelect.status})`}`);
  console.log(`   - Secret Source:                 ${authSelect.source || 'NONE'}`);
  console.log(`   - Details:                       ${authSelect.details}`);

  // 4. Token-less request check (Must be denied)
  const unauthDenied = testUnauthenticatedDenied();
  console.log(`4. Unauthenticated Request Denied:  ${unauthDenied.ok ? 'PASS (Access Blocked)' : `FAIL (${unauthDenied.status})`}`);
  console.log(`   - Details:                       ${unauthDenied.details}`);

  // 5. Record probe & display rolling uptime metrics
  const probeMetrics = recordTunnelHealthProbe();
  console.log('-----------------------------------------------------------------------------');
  console.log('TUNNEL HEALTH EPOCH & ROLLING UPTIME METRICS:');
  console.log(`   • Epoch Status:                     ${probeMetrics.epoch_status}`);
  console.log(`   • Epoch Start Time:                 ${probeMetrics.epoch_start_time || 'Awaiting first successful authenticated SELECT 1'}`);
  console.log(`   • Rolling Window Duration:          ${probeMetrics.rolling_window_hours} saat (Gereken: >= ${probeMetrics.rolling_window_required_hours} saat)`);
  console.log(`   • Total Epoch Probes:               ${probeMetrics.total_epoch_probes}`);
  console.log(`   • Successful Access Probes:         ${probeMetrics.successful_access_probes}`);
  console.log(`   • Failed Access Probes:             ${probeMetrics.failed_access_probes}`);
  console.log(`   • İzole Edilen Olay Geçmişi:        ${probeMetrics.incident_history_count} incident probes (Yeni epoch'u zehirlemez)`);
  console.log(`   • Tunnel Uptime Ratio:              ${probeMetrics.tunnel_uptime_ratio}% (Hedef: >= ${probeMetrics.target_uptime_ratio}%)`);
  console.log(`   • Unauthenticated Requests Denied:  ${probeMetrics.all_unauthenticated_denied ? 'PASS (100% Denied)' : 'FAIL'}`);
  console.log(`   • Authenticated SELECT 200:         ${probeMetrics.all_authenticated_select_200 ? 'PASS (All HTTP 200)' : 'FAIL'}`);
  console.log(`   • Max Consecutive Downtime:         ${probeMetrics.max_consecutive_downtime_sec}s`);
  console.log(`   • Current Downtime:                 ${probeMetrics.current_consecutive_downtime_sec}s`);
  console.log(`   • Stage 2 Tunnel Gate Passed:       ${probeMetrics.epoch_gate_passed ? 'PASS' : 'WAITING/BLOCKED (Uptime >=99% & Window >=24h required)'}`);
  console.log('=============================================================================\n');

  return {
    processAlive,
    tunnelConnected,
    authSelect,
    unauthDenied,
    probeMetrics
  };
}

if (require.main === module) {
  main();
}

module.exports = { main };
