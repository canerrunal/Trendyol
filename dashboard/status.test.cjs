const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatus, parseSocialRefs, normalizeSocialRun, cronTime, errorSummary, progressFromLog, discoverProfiles } = require('./server.cjs');

test('cron saatini okunabilir biçime çevirir', () => assert.equal(cronTime('30 14 * * *'), '14:30'));
test('timeout hatasını sadeleştirir', () => assert.match(errorSummary('page.goto: net::ERR_TIMED_OUT'), /zaman aşım/i));
test('canlı detay ilerlemesini logdan çıkarır', () => assert.deepEqual(progressFromLog('DETAIL_PROGRESS profile=hobi completed=40/200 refreshed=39'), { phase:'detail', current:40, total:200, refreshed:39, percent:20 }));
test('bütün profil ayarlarını otomatik keşfeder', () => {
  const slugs = discoverProfiles().map(profile => profile.slug);
  for (const expected of ['cocuk','erkek','mobilya','otomobil-motosiklet','hamile','hobi']) assert.ok(slugs.includes(expected));
});
test('sosyal yayın etiketlerini platform kayıtlarına dönüştürür', () => {
  const refs = parseSocialRefs({ data:{ repository:{ refs:{ nodes:[
    { name:'instagram/apple-m6', target:{ oid:'abc123', committedDate:'2026-08-27T09:55:37Z' } },
    { name:'facebook/apple-m6', target:{ oid:'abc123', committedDate:'2026-08-27T09:55:37Z' } },
    { name:'bilinmeyen/duyuru', target:{ oid:'def456', committedDate:'2026-08-27T09:55:37Z' } }
  ] } } } });
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map(item => item.platform).sort(), ['facebook','instagram']);
  assert.match(refs[0].announcementUrl, /duyurular\/apple-m6/);
});
test('GitHub Actions sonucunu panel durumuna çevirir', () => {
  assert.equal(normalizeSocialRun({ status:'completed', conclusion:'success' }).outcome, 'success');
  assert.equal(normalizeSocialRun({ status:'in_progress', conclusion:null }).outcome, 'running');
  assert.equal(normalizeSocialRun({ status:'completed', conclusion:'failure' }).outcome, 'failed');
});
test('canlı durum modeli görev ve kalite verisini birleştirir', () => {
  const status = buildStatus({ bypassCache:true });
  assert.ok(status.profiles.length >= 12);
  assert.equal(status.summary.total, status.profiles.length);
  assert.ok(status.profiles.every(profile => profile.schedule && profile.quality));
  assert.ok(Array.isArray(status.recentEvents));
  assert.ok(status.taxonomy.catalog.total >= status.taxonomy.catalog.uniqueCategories);
  assert.ok(status.taxonomy.catalog.uniqueCategories > 0);
  assert.ok(status.taxonomy.latest.emptyCategories >= 0);
  assert.ok(status.taxonomy.catalog.roots > 0);
  assert.equal(status.taxonomy.stages.length, 6);
  assert.ok(status.social);
  assert.equal(status.social.platforms.length, 4);
  assert.ok(status.outbox);
  assert.equal(typeof status.outbox.pending_batches, 'number');
  assert.equal(typeof status.outbox.health, 'string');
  assert.ok(status.clickhouse);
  assert.equal(typeof status.clickhouse.health, 'string');
});

test('ClickHouse durumu yapılandırılmamışken health not_configured döner', () => {
  const original = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  try {
    const status = buildStatus({ bypassCache: true });
    assert.equal(status.clickhouse.configured, false);
    assert.equal(status.clickhouse.health, 'not_configured');
    assert.equal(status.clickhouse.url, null);
  } finally {
    if (original != null) process.env.CLICKHOUSE_URL = original;
  }
});

test('ClickHouse erişilemezken health unreachable döner', () => {
  const original = process.env.CLICKHOUSE_URL;
  process.env.CLICKHOUSE_URL = 'http://127.0.0.1:59999'; // unreachable port
  try {
    const status = buildStatus({ bypassCache: true });
    assert.equal(status.clickhouse.configured, true);
    assert.equal(status.clickhouse.health, 'unreachable');
  } finally {
    if (original != null) process.env.CLICKHOUSE_URL = original;
    else delete process.env.CLICKHOUSE_URL;
  }
});

test('ClickHouse çalışırken health healthy döner', () => {
  const original = process.env.CLICKHOUSE_URL;
  process.env.CLICKHOUSE_URL = 'http://127.0.0.1:8123'; // live canary ClickHouse
  try {
    const status = buildStatus({ bypassCache: true });
    assert.equal(status.clickhouse.configured, true);
    assert.equal(status.clickhouse.health, 'healthy');
  } finally {
    if (original != null) process.env.CLICKHOUSE_URL = original;
    else delete process.env.CLICKHOUSE_URL;
  }
});

test('Disk kapasite metrikleri doğru biçimde üretilir ve free_disk_gb hesaplanır', () => {
  const status = buildStatus({ bypassCache: true });
  assert.ok(status.disk, 'disk objesi mevcut olmalı');
  assert.equal(typeof status.disk.free_disk_gb, 'number');
  assert.ok(status.disk.free_disk_gb > 0);
  assert.equal(typeof status.disk.total_disk_gb, 'number');
  assert.ok(status.disk.total_disk_gb > 0);
  assert.equal(typeof status.disk.daily_growth_gb, 'number');
  assert.equal(typeof status.disk.estimated_days_until_disk_full, 'number');
  assert.ok(status.disk.estimated_days_until_disk_full > 0);
});

test('Son GitHub Releases backup durumu okunur', () => {
  const status = buildStatus({ bypassCache: true });
  assert.ok(status.backup, 'backup objesi mevcut olmalı');
  assert.equal(status.backup.restore_verification, 'PASS');
  assert.ok(status.backup.total_rows >= 0);
  assert.ok(status.backup.backup_id);
});

test('Cloudflare Tunnel yapılandırılmadığında not_configured döner', () => {
  const origId = process.env.CF_ACCESS_CLIENT_ID;
  const origSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  const origIgnore = process.env.CF_ACCESS_IGNORE_KEYCHAIN;
  process.env.CF_ACCESS_IGNORE_KEYCHAIN = '1';
  delete process.env.CF_ACCESS_CLIENT_ID;
  delete process.env.CF_ACCESS_CLIENT_SECRET;
  try {
    const status = buildStatus({ bypassCache: true });
    assert.ok(status.tunnel);
    assert.equal(status.tunnel.configured, false);
    assert.equal(status.tunnel.health, 'not_configured');
  } finally {
    if (origId) process.env.CF_ACCESS_CLIENT_ID = origId;
    if (origSecret) process.env.CF_ACCESS_CLIENT_SECRET = origSecret;
    if (origIgnore) process.env.CF_ACCESS_IGNORE_KEYCHAIN = origIgnore;
    else delete process.env.CF_ACCESS_IGNORE_KEYCHAIN;
  }
});

test('Cloudflare Service Token süresi 30 günden az kaldığında uyarı üretilir', () => {
  const origId = process.env.CF_ACCESS_CLIENT_ID;
  const origSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  const origExp = process.env.CF_ACCESS_TOKEN_EXPIRES_AT;

  process.env.CF_ACCESS_CLIENT_ID = 'test_id';
  process.env.CF_ACCESS_CLIENT_SECRET = 'test_secret';
  // 15 days in future (< 30 days)
  process.env.CF_ACCESS_TOKEN_EXPIRES_AT = new Date(Date.now() + 15 * 86400 * 1000).toISOString();

  try {
    const status = buildStatus({ bypassCache: true });
    assert.ok(status.tunnel);
    assert.equal(status.tunnel.configured, true);
    assert.equal(status.tunnel.expiry_warning, true);
    assert.ok(status.tunnel.days_until_token_expiry <= 15);
    assert.match(status.tunnel.warning_message, /expires in \d+ days/i);
  } finally {
    if (origId) process.env.CF_ACCESS_CLIENT_ID = origId;
    else delete process.env.CF_ACCESS_CLIENT_ID;
    if (origSecret) process.env.CF_ACCESS_CLIENT_SECRET = origSecret;
    else delete process.env.CF_ACCESS_CLIENT_SECRET;
    if (origExp) process.env.CF_ACCESS_TOKEN_EXPIRES_AT = origExp;
    else delete process.env.CF_ACCESS_TOKEN_EXPIRES_AT;
  }
});

test('Cloudflare Tunnel çok faktörlü durum ve rolling probe metrikleri üretir', () => {
  const status = buildStatus({ bypassCache: true });
  assert.ok(status.tunnel);
  assert.equal(typeof status.tunnel.cloudflared_process_alive, 'boolean');
  assert.equal(typeof status.tunnel.named_tunnel_connected, 'boolean');
  assert.equal(typeof status.tunnel.tunnel_uptime_ratio, 'number');
  assert.equal(typeof status.tunnel.max_consecutive_downtime_sec, 'number');
  assert.equal(typeof status.tunnel.successful_access_probes, 'number');
  assert.equal(typeof status.tunnel.failed_access_probes, 'number');
  assert.ok(status.tunnel.tunnel_status);
});


