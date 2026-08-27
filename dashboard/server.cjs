#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HERMES_CRON_DIR = path.join(os.homedir(), '.hermes', 'cron');
const JOBS_FILE = path.join(HERMES_CRON_DIR, 'jobs.json');
const EXECUTIONS_DB = path.join(HERMES_CRON_DIR, 'executions.db');
const LOG_DIR = path.join(ROOT, '.runtime', 'cron-logs');
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.DASHBOARD_PORT || 4317);
const TIMEZONE = 'Europe/Istanbul';
const GITHUB_BASE = 'https://github.com/caner8047-coder/Trendyol/blob/main';
const SOCIAL_REPOSITORY = process.env.SOCIAL_REPOSITORY || 'caner8047-coder/verimimaricom';
const SOCIAL_WORKFLOW = process.env.SOCIAL_WORKFLOW || 'publish-announcements.yml';
const SOCIAL_SITE = process.env.SOCIAL_SITE || 'https://verimimari.com';
const GH_BIN = process.env.GH_BIN || [path.join(os.homedir(), '.local', 'bin', 'gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(file => fs.existsSync(file)) || 'gh';
const SOCIAL_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', handle: '@veri.mimari', profileUrl: 'https://www.instagram.com/veri.mimari/' },
  { key: 'facebook', label: 'Facebook', handle: 'Veri Mimarı', profileUrl: 'https://www.facebook.com/verimimaricom' },
  { key: 'linkedin', label: 'LinkedIn', handle: 'Veri Mimarı', profileUrl: 'https://www.linkedin.com/in/veri-mimari/' },
  { key: 'x', label: 'X', handle: '@verimimari', profileUrl: 'https://x.com/verimimari' }
];

let statusCache = { expiresAt: 0, value: null };
let socialCache = { expiresAt: 0, value: null };

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function run(command, args, fallback = '') {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return fallback; }
}

function git(args, fallback = '') { return run('/usr/bin/git', args, fallback); }

function publicGithubJson(pathname, fallback = '{}') {
  return run('/usr/bin/curl', [
    '-fsSL', '--max-time', '4',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    `https://api.github.com/repos/${SOCIAL_REPOSITORY}${pathname}`
  ], fallback);
}

function parseSocialRefs(payload) {
  const nodes = payload?.data?.repository?.refs?.nodes || [];
  return nodes.map(node => {
    const name = String(node.name || '').replace(/^refs\/tags\/social\//, '');
    const separator = name.indexOf('/');
    if (separator < 1) return null;
    const platform = name.slice(0, separator);
    const slug = name.slice(separator + 1);
    if (!SOCIAL_PLATFORMS.some(item => item.key === platform) || !slug) return null;
    return {
      platform,
      slug,
      commit: node.target?.oid || null,
      sourceCommitAt: isoOrNull(node.target?.committedDate),
      announcementUrl: `${SOCIAL_SITE}/duyurular/${encodeURIComponent(slug)}`,
      tagUrl: `https://github.com/${SOCIAL_REPOSITORY}/tree/social/${platform}/${encodeURIComponent(slug)}`
    };
  }).filter(Boolean).sort((a, b) => String(b.sourceCommitAt || '').localeCompare(String(a.sourceCommitAt || '')));
}

function normalizeSocialRun(run) {
  const running = ['queued', 'in_progress', 'requested', 'waiting'].includes(run.status);
  const outcome = running ? 'running' : run.conclusion === 'success' ? 'success' : run.conclusion === 'cancelled' ? 'cancelled' : 'failed';
  return {
    id: run.databaseId,
    status: run.status,
    conclusion: run.conclusion || null,
    outcome,
    event: run.event,
    title: run.displayTitle || 'Sosyal yayın görevi',
    createdAt: isoOrNull(run.createdAt),
    updatedAt: isoOrNull(run.updatedAt),
    commit: run.headSha || null,
    url: run.url
  };
}

function buildSocialStatus({ bypassCache = false } = {}) {
  if (!bypassCache && socialCache.value && socialCache.expiresAt > Date.now()) return socialCache.value;
  const [owner, repository] = SOCIAL_REPOSITORY.split('/');
  const variableOutput = run(GH_BIN, ['variable', 'list', '--repo', SOCIAL_REPOSITORY, '--json', 'name,value'], '[]');
  const runOutput = run(GH_BIN, ['run', 'list', '--repo', SOCIAL_REPOSITORY, '--workflow', SOCIAL_WORKFLOW, '--limit', '12', '--json', 'databaseId,status,conclusion,event,displayTitle,createdAt,updatedAt,headSha,url'], '[]');
  const refsQuery = `query { repository(owner: \"${owner}\", name: \"${repository}\") { refs(refPrefix: \"refs/tags/social/\", first: 100) { nodes { name target { ... on Commit { oid committedDate } } } } } }`;
  const refsOutput = run(GH_BIN, ['api', 'graphql', '-f', `query=${refsQuery}`], '{}');
  let variables = []; let runs = []; let refsPayload = {};
  try { variables = JSON.parse(variableOutput || '[]'); } catch {}
  try { runs = JSON.parse(runOutput || '[]').map(normalizeSocialRun); } catch {}
  try { refsPayload = JSON.parse(refsOutput || '{}'); } catch {}
  if (!runs.length) {
    try {
      const publicRuns = JSON.parse(publicGithubJson(`/actions/workflows/${SOCIAL_WORKFLOW}/runs?per_page=12`, '{}'));
      runs = (publicRuns.workflow_runs || []).map(run => normalizeSocialRun({
        databaseId: run.id, status: run.status, conclusion: run.conclusion, event: run.event,
        displayTitle: run.display_title, createdAt: run.created_at, updatedAt: run.updated_at,
        headSha: run.head_sha, url: run.html_url
      }));
    } catch {}
  }
  if (!(refsPayload?.data?.repository?.refs?.nodes || []).length) {
    try {
      const publicTags = JSON.parse(publicGithubJson('/tags?per_page=100', '[]'));
      refsPayload = { data:{ repository:{ refs:{ nodes:(publicTags || []).filter(tag => String(tag.name).startsWith('social/')).map(tag => ({
        name: String(tag.name).replace(/^social\//, ''), target:{ oid:tag.commit?.sha || null, committedDate:null }
      })) } } } };
    } catch {}
  }
  const variableMap = new Map(variables.map(item => [item.name, item.value]));
  const configured = String(variableMap.get('SOCIAL_AUTO_PLATFORMS') || process.env.SOCIAL_AUTO_PLATFORMS || 'linkedin,x,instagram,facebook').split(',').map(item => item.trim()).filter(Boolean);
  const refs = parseSocialRefs(refsPayload);
  const platforms = SOCIAL_PLATFORMS.map(item => {
    const publications = refs.filter(ref => ref.platform === item.key);
    return {
      ...item,
      enabled: configured.includes(item.key),
      publicationCount: publications.length,
      latest: publications[0] || null
    };
  });
  const latestRun = runs[0] || null;
  const available = variables.length > 0 || runs.length > 0 || refs.length > 0;
  const value = {
    available,
    repository: SOCIAL_REPOSITORY,
    repositoryUrl: `https://github.com/${SOCIAL_REPOSITORY}`,
    workflowUrl: `https://github.com/${SOCIAL_REPOSITORY}/actions/workflows/${SOCIAL_WORKFLOW}`,
    enabled: variableMap.has('SOCIAL_PUBLISH_ENABLED') ? variableMap.get('SOCIAL_PUBLISH_ENABLED') === 'true' : process.env.SOCIAL_PUBLISH_ENABLED !== 'false',
    source: variables.length ? 'github-cli' : 'public-api',
    configuredPlatforms: configured,
    summary: {
      activePlatforms: platforms.filter(item => item.enabled).length,
      publicationCount: refs.length,
      successfulRuns: runs.filter(item => item.outcome === 'success').length,
      failedRuns: runs.filter(item => item.outcome === 'failed').length,
      lastRunAt: latestRun?.createdAt || null,
      lastOutcome: latestRun?.outcome || 'unknown'
    },
    platforms,
    recentPublications: refs.slice(0, 12),
    recentRuns: runs.slice(0, 8),
    error: available ? null : 'GitHub sosyal yayın verilerine ulaşılamadı. gh oturumunu ve ağ bağlantısını kontrol edin.'
  };
  socialCache = { expiresAt: Date.now() + 300000, value };
  return value;
}

function istanbulDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function durationSeconds(start, finish) {
  const a = new Date(start || 0).getTime();
  const b = new Date(finish || 0).getTime();
  return a && b && b >= a ? Math.round((b - a) / 1000) : null;
}

function cronTime(display, fallback) {
  const match = String(display || '').match(/^(\d{1,2})\s+(\d{1,2})\s+/);
  if (!match) return fallback || '--:--';
  return `${String(match[2]).padStart(2, '0')}:${String(match[1]).padStart(2, '0')}`;
}

function profileLabel(config) {
  return String(config.telegramTitle || config.name || config.profile)
    .replace(/^Trendyol\s+/i, '')
    .replace(/\s+Günlük Raporu$/i, '')
    .replace(/\s+(?:En\s+)?Çok\s+Satan(?:lar|\s+Ürünler)$/i, '')
    .trim();
}

function discoverProfiles() {
  const configs = [{ file: path.join(ROOT, 'config.json'), root: ROOT }];
  const profileDir = path.join(ROOT, 'profiles');
  if (fs.existsSync(profileDir)) {
    for (const file of fs.readdirSync(profileDir).filter(name => name.endsWith('.json')).sort()) {
      const config = readJson(path.join(profileDir, file));
      if (config?.profile) configs.push({ file: path.join(profileDir, file), root: path.join(ROOT, 'categories', config.profile) });
    }
  }
  return configs.map(item => {
    const config = readJson(item.file, {});
    return { slug: config.profile, label: profileLabel(config), config, root: item.root };
  }).filter(profile => profile.slug);
}

function readExecutions() {
  if (!fs.existsSync(EXECUTIONS_DB)) return [];
  const sql = `SELECT id, job_id, source, status, claimed_at, started_at, finished_at, substr(error,1,1200) AS error FROM executions ORDER BY claimed_at DESC LIMIT 300;`;
  const output = run('/usr/bin/sqlite3', ['-json', EXECUTIONS_DB, sql], '[]');
  try { return JSON.parse(output || '[]'); }
  catch { return []; }
}

function latestLog(slug) {
  if (!fs.existsSync(LOG_DIR)) return { path: null, updatedAt: null, tail: '' };
  const candidates = fs.readdirSync(LOG_DIR)
    .filter(name => name.startsWith(`${slug}-`) && name.endsWith('.log'))
    .map(name => {
      const file = path.join(LOG_DIR, name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) return { path: null, updatedAt: null, tail: '' };
  const selected = candidates[0];
  const lines = fs.readFileSync(selected.file, 'utf8').split(/\r?\n/).filter(Boolean);
  return {
    path: selected.file,
    updatedAt: new Date(selected.mtime).toISOString(),
    tail: lines.slice(-40).join('\n')
  };
}

function progressFromLog(text) {
  const detail = [...String(text).matchAll(/DETAIL_PROGRESS[^\n]*completed=(\d+)\/(\d+)[^\n]*refreshed=(\d+)/g)].pop();
  if (detail) return { phase: 'detail', current: Number(detail[1]), total: Number(detail[2]), refreshed: Number(detail[3]), percent: Math.round(Number(detail[1]) / Number(detail[2]) * 100) };
  const listing = [...String(text).matchAll(/LISTING_PROGRESS[^\n]*total=(\d+)/g)].pop();
  if (listing) return { phase: 'listing', current: Number(listing[1]), total: 200, refreshed: 0, percent: Math.min(100, Math.round(Number(listing[1]) / 2)) };
  if (/DAILY_RUN_OK/.test(text)) return { phase: 'done', current: 200, total: 200, refreshed: 200, percent: 100 };
  return null;
}

function errorSummary(error) {
  const text = String(error || '');
  if (!text) return null;
  if (/send_path_degraded|Telegram send failed|delivery.*telegram/i.test(text)) return 'Telegram bildirimi gönderilemedi.';
  if (/ERR_TIMED_OUT|Timeout \d+ms|zaman aşımı/i.test(text)) return 'Trendyol bağlantısı zaman aşımına uğradı.';
  if (/kalite kapısı|quality.*fail/i.test(text)) return 'Veri kalite kapısı çalışmayı reddetti.';
  if (/git push|fetch first|non-fast-forward/i.test(text)) return 'GitHub gönderimi tamamlanamadı.';
  if (/provider timeout/i.test(text)) return 'Model sağlayıcısı zaman aşımına uğradı.';
  return text.split(/\r?\n/).find(line => line.trim())?.slice(0, 180) || 'Bilinmeyen hata';
}

function historyFor(jobId, executions, days = 7) {
  const result = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date();
    day.setDate(day.getDate() - offset);
    const key = istanbulDate(day);
    const runForDay = executions
      .filter(item => item.job_id === jobId && istanbulDate(item.started_at || item.claimed_at) === key)
      .sort((a, b) => String(b.started_at || b.claimed_at).localeCompare(String(a.started_at || a.claimed_at)))[0];
    result.push({ date: key, status: runForDay?.status || 'none', durationSeconds: runForDay ? durationSeconds(runForDay.started_at, runForDay.finished_at) : null });
  }
  return result;
}

function commitFor(profile) {
  const relative = profile.slug === 'cocuk' ? 'data/latest.json' : `categories/${profile.slug}/data/latest.json`;
  const line = git(['log', '-1', '--format=%H|%cI|%s', 'origin/main', '--', relative]);
  if (!line) return null;
  const [hash, committedAt, ...subject] = line.split('|');
  return { hash, shortHash: hash.slice(0, 7), committedAt, subject: subject.join('|') };
}

function buildTaxonomyStatus(jobByName, executions, today) {
  const catalog = readJson(path.join(ROOT, 'taxonomy', 'catalog.json'), {});
  const latest = readJson(path.join(ROOT, 'taxonomy', 'status.json'), {});
  const runtimeDir = path.join(ROOT, '.runtime', 'taxonomy', today);
  const shardStatuses = [0, 1, 2, 3].map(shard => readJson(path.join(runtimeDir, `shard-${shard}.status.json`), {
    shard, status: 'waiting', totalCategories: 0, completedCategories: 0, failedCategories: 0, products: 0, memberships: 0
  }));
  const definitions = [
    ['trendyol-taxonomy-discovery', 'Ağacı yenile', '15:00'],
    ['trendyol-taxonomy-shard-0', 'İşçi 1/4', '15:10'],
    ['trendyol-taxonomy-shard-1', 'İşçi 2/4', '16:00'],
    ['trendyol-taxonomy-shard-2', 'İşçi 3/4', '16:50'],
    ['trendyol-taxonomy-shard-3', 'İşçi 4/4', '17:40'],
    ['trendyol-taxonomy-finalize', 'Kalite + GitHub', '18:40']
  ];
  const stages = definitions.map(([name, label, fallback]) => {
    const job = jobByName.get(name) || null;
    const execution = executions.find(item => item.job_id === job?.id) || null;
    const status = execution?.status || job?.last_status || 'waiting';
    return {
      name, label, jobId: job?.id || null, schedule: cronTime(job?.schedule_display, fallback),
      enabled: job?.enabled !== false && Boolean(job), status,
      lastRunAt: isoOrNull(job?.last_run_at || execution?.started_at), nextRunAt: isoOrNull(job?.next_run_at),
      error: errorSummary(job?.last_error || execution?.error)
    };
  });
  const completedTodayRaw = shardStatuses.reduce((sum, shard) => sum + Number(shard.completedCategories || 0), 0);
  const completedToday = Math.min(completedTodayRaw, catalog.stats?.uniqueCategoryIds || catalog.stats?.total || completedTodayRaw);
  const failedToday = shardStatuses.reduce((sum, shard) => sum + Number(shard.failedCategories || 0), 0);
  return {
    catalog: {
      generatedAt: isoOrNull(catalog.generatedAt), total: catalog.stats?.total || 0,
      uniqueCategories: catalog.stats?.uniqueCategoryIds || catalog.stats?.total || 0,
      duplicatePaths: catalog.stats?.duplicatePaths || 0, roots: catalog.stats?.roots || 0,
      leaves: catalog.stats?.leaves || 0, maxDepth: catalog.stats?.maxDepth ?? null, levels: catalog.stats?.levels || {}, rootsBreakdown: catalog.roots || []
    },
    latest: {
      date: latest.date || null, status: latest.status || 'WAITING', coveredCategories: latest.coveredCategories || 0,
      totalCategories: latest.totalCategories || catalog.stats?.total || 0, coverage: latest.coverage || 0,
      uniqueProducts: latest.uniqueProducts || 0, rankingMemberships: latest.rankingMemberships || 0,
      categoriesWithProducts: latest.categoriesWithProducts || 0, emptyCategories: latest.emptyCategories || 0,
      failedCategories: latest.failedCategories || 0
    },
    today: { completedCategories: completedToday, failedCategories: failedToday, shards: shardStatuses },
    stages,
    reportUrl: '/taxonomy/report',
    githubUrl: `${GITHUB_BASE}/taxonomy/reports/${latest.date ? 'latest.md' : 'catalog.md'}`
  };
}

function buildStatus({ bypassCache = false } = {}) {
  if (!bypassCache && statusCache.value && statusCache.expiresAt > Date.now()) return statusCache.value;
  const jobsData = readJson(JOBS_FILE, { jobs: [], updated_at: null });
  const jobs = (jobsData.jobs || []).filter(job => String(job.name || '').startsWith('trendyol-') && job.workdir === ROOT);
  const jobByName = new Map(jobs.map(job => [job.name, job]));
  const executions = readExecutions();
  const today = istanbulDate();
  const profiles = discoverProfiles().map(profile => {
    const job = jobByName.get(`trendyol-${profile.slug}-daily-intelligence`) || null;
    const quality = readJson(path.join(profile.root, 'quality', 'latest.json'), {});
    const log = latestLog(profile.slug);
    const relatedExecutions = executions.filter(item => item.job_id === job?.id);
    const latestExecution = relatedExecutions[0] || null;
    const running = ['claimed', 'running'].includes(latestExecution?.status);
    const fresh = quality.date === today;
    const qualityPass = quality.status === 'PASS';
    const lastStatus = running ? 'running' : job?.last_status || latestExecution?.status || 'waiting';
    let health = 'healthy';
    if (!job || job.enabled === false) health = 'paused';
    else if (running) health = 'running';
    else if (lastStatus === 'error' || lastStatus === 'failed') health = 'failed';
    else if (!qualityPass || !fresh) health = 'warning';
    const reportRelative = profile.slug === 'cocuk' ? `reports/${quality.date || 'latest'}.md` : `categories/${profile.slug}/reports/${quality.date || 'latest'}.md`;
    const progress = running ? progressFromLog(log.tail) : null;
    return {
      slug: profile.slug,
      label: profile.label,
      sourceLabel: profile.config.sourceLabel || profile.config.name,
      schedule: cronTime(job?.schedule_display, profile.config.dailyRunTime),
      cron: job?.schedule_display || null,
      jobId: job?.id || null,
      enabled: job?.enabled !== false,
      state: job?.state || 'missing',
      health,
      lastStatus,
      lastRunAt: isoOrNull(job?.last_run_at || latestExecution?.started_at),
      nextRunAt: isoOrNull(job?.next_run_at),
      delivery: job?.last_delivery_error ? 'failed' : (job?.last_status === 'ok' && job?.deliver === 'telegram' ? 'delivered' : 'unknown'),
      deliveryError: errorSummary(job?.last_delivery_error),
      error: errorSummary(job?.last_error || latestExecution?.error),
      quality: {
        status: quality.status || 'MISSING',
        date: quality.date || null,
        productCount: quality.productCount || 0,
        detailSuccessRate: quality.detailSuccessRate || 0,
        coreCoverage: quality.coreCoverage || 0,
        coverage: quality.coverage || {},
        lowCoverageFields: quality.lowCoverageFields || []
      },
      fresh,
      progress,
      history: historyFor(job?.id, executions),
      reportUrl: `/report/${profile.slug}`,
      logUrl: `/log/${profile.slug}`,
      githubUrl: `${GITHUB_BASE}/${reportRelative}`,
      commit: commitFor(profile),
      latestLog: { updatedAt: log.updatedAt, tail: log.tail }
    };
  }).sort((a, b) => a.schedule.localeCompare(b.schedule));

  const nextProfile = profiles.filter(item => item.nextRunAt).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0] || null;
  const todayRuns = profiles.filter(item => item.lastRunAt && istanbulDate(item.lastRunAt) === today);
  const recentEvents = executions
    .filter(item => jobs.some(job => job.id === item.job_id))
    .slice(0, 24)
    .map(item => {
      const job = jobs.find(candidate => candidate.id === item.job_id);
      const profile = profiles.find(candidate => candidate.jobId === item.job_id);
      return {
        id: item.id,
        profile: profile?.slug || null,
        label: profile?.label || job?.name || item.job_id,
        status: item.status,
        startedAt: isoOrNull(item.started_at || item.claimed_at),
        finishedAt: isoOrNull(item.finished_at),
        durationSeconds: durationSeconds(item.started_at, item.finished_at),
        error: errorSummary(item.error)
      };
    });
  const remoteHead = git(['rev-parse', 'origin/main']);
  const remoteInfo = git(['log', '-1', '--format=%cI|%s', 'origin/main']);
  const [remoteUpdatedAt, ...remoteSubject] = remoteInfo.split('|');
  const value = {
    generatedAt: new Date().toISOString(),
    timezone: TIMEZONE,
    today,
    summary: {
      total: profiles.length,
      healthy: profiles.filter(item => item.health === 'healthy').length,
      failed: profiles.filter(item => item.health === 'failed').length,
      warning: profiles.filter(item => item.health === 'warning').length,
      running: profiles.filter(item => item.health === 'running').length,
      completedToday: todayRuns.filter(item => item.lastStatus === 'ok').length,
      totalProducts: profiles.reduce((sum, item) => sum + Number(item.quality.productCount || 0), 0),
      next: nextProfile ? { slug: nextProfile.slug, label: nextProfile.label, at: nextProfile.nextRunAt, schedule: nextProfile.schedule } : null
    },
    repository: {
      branch: git(['branch', '--show-current']),
      remoteHead,
      shortHead: remoteHead.slice(0, 7),
      updatedAt: isoOrNull(remoteUpdatedAt),
      subject: remoteSubject.join('|'),
      github: 'https://github.com/caner8047-coder/Trendyol'
    },
    scheduler: {
      updatedAt: isoOrNull(jobsData.updated_at),
      heartbeat: fs.existsSync(path.join(HERMES_CRON_DIR, 'ticker_heartbeat')) ? fs.readFileSync(path.join(HERMES_CRON_DIR, 'ticker_heartbeat'), 'utf8').trim() : null,
      lastSuccess: fs.existsSync(path.join(HERMES_CRON_DIR, 'ticker_last_success')) ? fs.readFileSync(path.join(HERMES_CRON_DIR, 'ticker_last_success'), 'utf8').trim() : null
    },
    social: buildSocialStatus({ bypassCache }),
    taxonomy: buildTaxonomyStatus(jobByName, executions, today),
    profiles,
    recentEvents
  };
  statusCache = { expiresAt: Date.now() + 5000, value };
  return value;
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
  return true;
}

function profileFile(slug, kind) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  const profile = discoverProfiles().find(item => item.slug === slug);
  if (!profile) return null;
  if (kind === 'report') return path.join(profile.root, 'reports', 'latest.md');
  if (kind === 'log') return latestLog(slug).path;
  return null;
}

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method !== 'GET') return send(res, 405, 'Yalnız GET desteklenir.');
  if (url.pathname === '/api/status') {
    try { return send(res, 200, JSON.stringify(buildStatus({ bypassCache: url.searchParams.has('fresh') })), 'application/json; charset=utf-8'); }
    catch (error) { return send(res, 500, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8'); }
  }
  if (url.pathname === '/taxonomy/report') {
    const latest = path.join(ROOT, 'taxonomy', 'reports', 'latest.md');
    const file = fs.existsSync(latest) ? latest : path.join(ROOT, 'taxonomy', 'reports', 'catalog.md');
    return fs.existsSync(file) ? send(res, 200, fs.readFileSync(file), 'text/markdown; charset=utf-8') : send(res, 404, 'Kategori evreni raporu henüz oluşmadı.');
  }
  const reportMatch = url.pathname.match(/^\/report\/([a-z0-9-]+)$/);
  if (reportMatch) {
    const file = profileFile(reportMatch[1], 'report');
    return file && fs.existsSync(file) ? send(res, 200, fs.readFileSync(file), 'text/markdown; charset=utf-8') : send(res, 404, 'Rapor bulunamadı.');
  }
  const logMatch = url.pathname.match(/^\/log\/([a-z0-9-]+)$/);
  if (logMatch) {
    const file = profileFile(logMatch[1], 'log');
    return file && fs.existsSync(file) ? send(res, 200, fs.readFileSync(file), 'text/plain; charset=utf-8') : send(res, 404, 'Log bulunamadı.');
  }
  if (serveStatic(res, url.pathname)) return;
  return send(res, 404, 'Sayfa bulunamadı.');
}

function startServer() {
  const server = http.createServer(requestHandler);
  server.listen(PORT, HOST, () => console.log(`DASHBOARD_READY http://${HOST}:${PORT}`));
  return server;
}

module.exports = { ROOT, buildStatus, buildSocialStatus, parseSocialRefs, normalizeSocialRun, cronTime, errorSummary, progressFromLog, discoverProfiles, startServer };
if (require.main === module) startServer();
