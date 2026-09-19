// =============================================================================
// Verimimari Marketplace Data Platform V2 — Deterministic Stage 2 Manifest Generator
// Generates and freezes a deterministic 10% taxonomy manifest (~400 categories).
//
// Rules:
// 1. Proportional representation across all 15 major root departments.
// 2. Balanced distribution across light, medium, and heavy volume tiers.
// 3. Deterministic sorting by rootId and categoryId (reproducible SHA256).
// 4. Freezes category ID list and computes SHA256 digest.
// 5. Zero random or modulo N selection.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'taxonomy', 'catalog.json');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const MANIFEST_FILE = path.join(RUNTIME_DIR, 'stage_2_manifest_10pct.json');

const MAJOR_15_ROOTS = [
  'Süpermarket',
  'Spor&Outdoor',
  'Otomobil & Motosiklet',
  'Ev ve Mobilya',
  'Elektronik',
  'Bahçe & Yapı Market',
  'Hobi',
  'Giyim',
  'Kozmetik & Kişisel Bakım',
  'Aksesuar',
  'Kitap',
  'Kırtasiye & Ofis Malzemeleri',
  'Anne & Bebek & Çocuk',
  'Hamile Giyim',
  'Ayakkabı'
];

/**
 * Assigns volume tier based on category level and attributes.
 * Level 1/2: HEAVY (broad browse/listing)
 * Level 3:   MEDIUM (specific sub-category)
 * Level 4/5: LIGHT (deep long-tail leaf)
 */
function classifyVolumeTier(node) {
  const level = node.level || 0;
  if (level <= 2) return 'HEAVY';
  if (level === 3) return 'MEDIUM';
  return 'LIGHT';
}

function generateDeterministicStage2Manifest({ targetCount = 400, catalogPath = CATALOG_FILE } = {}) {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog file not found: ${catalogPath}`);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const allLeaves = (catalog.nodes || []).filter(n => n.categoryId && !n.hasChildren);

  // Group leaves by major root department
  const leavesByRoot = new Map();
  MAJOR_15_ROOTS.forEach(r => leavesByRoot.set(r, []));

  allLeaves.forEach(leaf => {
    const rootName = leaf.rootName;
    if (leavesByRoot.has(rootName)) {
      leavesByRoot.get(rootName).push({
        categoryId: leaf.categoryId,
        name: leaf.name,
        slug: leaf.slug,
        rootId: leaf.rootId,
        rootName: leaf.rootName,
        path: leaf.path || leaf.name,
        level: leaf.level || 0,
        volume_tier: classifyVolumeTier(leaf)
      });
    }
  });

  const totalMajorLeaves = Array.from(leavesByRoot.values()).reduce((sum, list) => sum + list.length, 0);

  // Calculate proportional quotas per root department ensuring minimum representation
  const rootQuotas = new Map();
  let allocated = 0;

  MAJOR_15_ROOTS.forEach(r => {
    const rootLeaves = leavesByRoot.get(r);
    // Minimum 4 categories per department, otherwise proportional
    const prop = Math.round((rootLeaves.length / totalMajorLeaves) * targetCount);
    const quota = Math.max(4, Math.min(rootLeaves.length, prop));
    rootQuotas.set(r, quota);
    allocated += quota;
  });

  // Adjust allocated count to exactly match targetCount (400)
  let diff = targetCount - allocated;
  const sortedRootsByLeafCount = [...MAJOR_15_ROOTS].sort((a, b) => leavesByRoot.get(b).length - leavesByRoot.get(a).length);

  while (diff !== 0) {
    for (const r of sortedRootsByLeafCount) {
      if (diff === 0) break;
      const currentQuota = rootQuotas.get(r);
      const available = leavesByRoot.get(r).length;
      if (diff > 0 && currentQuota < available) {
        rootQuotas.set(r, currentQuota + 1);
        diff--;
      } else if (diff < 0 && currentQuota > 4) {
        rootQuotas.set(r, currentQuota - 1);
        diff++;
      }
    }
  }

  // Stratified selection within each root department (balancing HEAVY, MEDIUM, LIGHT)
  const selectedCategories = [];
  const departmentBreakdown = {};

  MAJOR_15_ROOTS.forEach(rootName => {
    const rootLeaves = leavesByRoot.get(rootName);
    const quota = rootQuotas.get(rootName);

    // Group by volume tier
    const heavy = rootLeaves.filter(c => c.volume_tier === 'HEAVY').sort((a, b) => a.categoryId - b.categoryId);
    const medium = rootLeaves.filter(c => c.volume_tier === 'MEDIUM').sort((a, b) => a.categoryId - b.categoryId);
    const light = rootLeaves.filter(c => c.volume_tier === 'LIGHT').sort((a, b) => a.categoryId - b.categoryId);

    // Tier quotas: ~25% Heavy, ~50% Medium, ~25% Light
    let heavyTarget = Math.max(1, Math.round(quota * 0.25));
    let lightTarget = Math.max(1, Math.round(quota * 0.25));
    let mediumTarget = quota - heavyTarget - lightTarget;

    const pickFrom = (pool, count) => {
      if (count <= 0 || pool.length === 0) return [];
      if (pool.length <= count) return [...pool];
      const step = Math.max(1, Math.floor(pool.length / count));
      const res = [];
      for (let i = 0; i < pool.length && res.length < count; i += step) {
        res.push(pool[i]);
      }
      return res;
    };

    const pickedHeavy = pickFrom(heavy, heavyTarget);
    const pickedLight = pickFrom(light, lightTarget);
    let remainingNeeded = quota - (pickedHeavy.length + pickedLight.length);
    const pickedMedium = pickFrom(medium, remainingNeeded);

    const rootSelected = [...pickedHeavy, ...pickedMedium, ...pickedLight];

    // Fallback if tiers were uneven: fill from unused sorted root leaves
    if (rootSelected.length < quota) {
      const selectedIds = new Set(rootSelected.map(c => c.categoryId));
      const leftovers = rootLeaves.filter(c => !selectedIds.has(c.categoryId)).sort((a, b) => a.categoryId - b.categoryId);
      for (const l of leftovers) {
        if (rootSelected.length >= quota) break;
        rootSelected.push(l);
      }
    }

    // Sort deterministically within department by categoryId
    rootSelected.sort((a, b) => a.categoryId - b.categoryId);
    selectedCategories.push(...rootSelected);

    departmentBreakdown[rootName] = {
      total_leaves_available: rootLeaves.length,
      quota_selected: rootSelected.length,
      heavy_count: rootSelected.filter(c => c.volume_tier === 'HEAVY').length,
      medium_count: rootSelected.filter(c => c.volume_tier === 'MEDIUM').length,
      light_count: rootSelected.filter(c => c.volume_tier === 'LIGHT').length
    };
  });

  // Final deterministic sort across the entire manifest: by rootId, then categoryId
  selectedCategories.sort((a, b) => {
    if (a.rootId !== b.rootId) return a.rootId - b.rootId;
    return a.categoryId - b.categoryId;
  });

  // Compute canonical deterministic SHA256 digest of category IDs
  const canonicalIds = selectedCategories.map(c => c.categoryId);
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonicalIds)).digest('hex');

  const manifest = {
    manifest_name: 'STAGE_2_DETERMINISTIC_10PCT_TAXONOMY_MANIFEST',
    manifest_version: 1,
    target_stage: 2,
    target_percentage: 10,
    target_categories_count: selectedCategories.length,
    manifest_sha256: hash,
    frozen_at: '2026-09-18T23:22:00.000Z',
    active_streams: {
      product_observations: 'REQUIRED_ACTIVE',
      category_rank_observations: 'REQUIRED_ACTIVE',
      profile_observations: 'EMPTY_ALLOWED_BY_STAGE (Planned Stage 3/4)',
      inventory_observations: 'EMPTY_ALLOWED_BY_STAGE (Planned Stage 5)'
    },
    root_department_count: MAJOR_15_ROOTS.length,
    department_breakdown: departmentBreakdown,
    category_ids: canonicalIds,
    categories: selectedCategories
  };

  return manifest;
}

function saveDeterministicManifest(manifest, destPath = MANIFEST_FILE) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2), 'utf8');
  return destPath;
}

if (require.main === module) {
  console.log('Generating deterministic 10% Stage 2 manifest...');
  const manifest = generateDeterministicStage2Manifest();
  saveDeterministicManifest(manifest);
  console.log(`✓ Manifest successfully generated:`);
  console.log(`   • Total Categories:   ${manifest.target_categories_count}`);
  console.log(`   • Root Departments:   ${manifest.root_department_count}`);
  console.log(`   • Manifest SHA256:    ${manifest.manifest_sha256}`);
  console.log(`   • Saved to:           ${MANIFEST_FILE}`);
}

module.exports = {
  generateDeterministicStage2Manifest,
  saveDeterministicManifest,
  MAJOR_15_ROOTS,
  MANIFEST_FILE
};
