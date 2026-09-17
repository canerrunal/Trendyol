#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function cliArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  const inline = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function profileLabel(config) {
  if (config.website && typeof config.website.label === 'string' && config.website.label.trim()) {
    return config.website.label.trim();
  }
  return String(config.name || config.profile)
    .replace(/^Trendyol\s+/i, '')
    .replace(/\s+(?:En\s+)?Çok\s+Satan(?:lar|\s+Ürünler)$/i, '')
    .trim();
}

function discoverProfiles(root = ROOT) {
  const configFiles = [path.join(root, 'config.json')];
  const profilesDirectory = path.join(root, 'profiles');
  if (fs.existsSync(profilesDirectory)) {
    configFiles.push(
      ...fs
        .readdirSync(profilesDirectory)
        .filter(file => file.endsWith('.json'))
        .sort()
        .map(file => path.join(profilesDirectory, file))
    );
  }

  const discovered = configFiles.map((configFile, index) => {
    const config = readJson(configFile);
    const slug = String(config.profile || '').trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`Geçersiz profil kimliği: ${configFile}`);
    }
    const isRootProfile = path.resolve(configFile) === path.join(root, 'config.json');
    return {
      slug,
      label: profileLabel(config),
      sourceLabel: String(config.sourceLabel || config.name || slug).trim(),
      prefix: isRootProfile ? '' : path.join('categories', slug),
      runTime: String(config.dailyRunTime || '99:99'),
      enabled: config.website?.enabled !== false,
      discoveryIndex: index
    };
  });

  const seen = new Set();
  for (const profile of discovered) {
    if (seen.has(profile.slug)) throw new Error(`Tekrarlanan profil kimliği: ${profile.slug}`);
    seen.add(profile.slug);
  }

  const runOrderKey = (time) => {
    const [h, m] = String(time || '99:99').split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return 9999;
    const minutes = h * 60 + m;
    return minutes >= 1200 ? minutes - 1200 : minutes + 240;
  };

  return discovered.sort(
    (a, b) => runOrderKey(a.runTime) - runOrderKey(b.runTime) || a.discoveryIndex - b.discoveryIndex
  );
}

async function publishProfile(baseUrl, secret, profile) {
  const root = path.join(ROOT, profile.prefix);
  const qualityFile = path.join(root, 'quality', 'latest.json');
  const productsFile = path.join(root, 'data', 'latest.json');
  if (profile.enabled && (!fs.existsSync(qualityFile) || !fs.existsSync(productsFile))) {
    console.log(`PUBLISH_SKIPPED profile=${profile.slug} reason=missing-snapshot`);
    return;
  }
  const quality = profile.enabled ? readJson(qualityFile) : {};
  const products = profile.enabled ? readJson(productsFile) : [];
  if (profile.enabled && (quality.status !== 'PASS' || products.length < 200)) {
    console.log(`PUBLISH_SKIPPED profile=${profile.slug} reason=quality-gate`);
    return;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/pazar-nabzi/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      profile: profile.slug,
      profileMetadata: {
        label: profile.label,
        sourceLabel: profile.sourceLabel,
        enabled: profile.enabled
      },
      quality,
      products,
      sourceCommit: process.env.GITHUB_SHA || null
    }),
    signal: AbortSignal.timeout(90000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new Error(`${profile.slug}: HTTP ${response.status} ${JSON.stringify(result)}`);
  }
  if (!profile.enabled) {
    console.log(`PUBLISH_DISABLED profile=${profile.slug}`);
    return;
  }
  console.log(`PUBLISH_OK profile=${profile.slug} products=${result.productCount}`);
}

async function main() {
  const baseUrl = process.env.VERI_MIMARI_INGEST_URL || '';
  const secret = process.env.VERI_MIMARI_INGEST_SECRET || '';
  if (!baseUrl || !secret) {
    console.log('PUBLISH_SKIPPED Veri Mimarı yayın sırları henüz tanımlanmadı.');
    return;
  }
  const profiles = discoverProfiles();
  const requested = cliArg('profile');
  const selected = requested ? profiles.filter(profile => profile.slug === requested) : profiles;
  if (!selected.length) throw new Error(`Bilinmeyen profil: ${requested}`);
  for (const profile of selected) {
    await publishProfile(baseUrl, secret, profile);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { discoverProfiles, profileLabel };
