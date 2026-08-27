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
  assert.ok(status.recentEvents.length > 0);
  assert.equal(status.taxonomy.catalog.total, 4003);
  assert.equal(status.taxonomy.catalog.uniqueCategories, 3952);
  assert.ok(status.taxonomy.latest.emptyCategories >= 0);
  assert.equal(status.taxonomy.catalog.roots, 19);
  assert.equal(status.taxonomy.stages.length, 6);
  assert.ok(status.social);
  assert.equal(status.social.platforms.length, 4);
});
