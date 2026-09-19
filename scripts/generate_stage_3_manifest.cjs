// =============================================================================
// Verimimari Marketplace Data Platform V2 — Deterministic Stage 3 Manifest Generator
// Generates and freezes a deterministic 25% taxonomy manifest (~879 categories).
//
// Requirements:
// 1. Target scope = 25% (total leaves: ~3515 -> target: exactly 879).
// 2. MUST include all 400 categories from Stage 2 (.runtime/stage_2_manifest_10pct.json).
// 3. Balanced across 15 root departments with balanced volume tiers (light/medium/heavy).
// 4. Exactly 879 unique category IDs (0 duplicate categories).
// 5. Deterministic sorting (rootId, categoryId) and reproducible SHA256 digest.
// 6. Freezes manifest to .runtime/stage_3_manifest_25pct.json.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'taxonomy', 'catalog.json');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const STAGE_2_MANIFEST_FILE = path.join(RUNTIME_DIR, 'stage_2_manifest_10pct.json');
const STAGE_3_MANIFEST_FILE = path.join(RUNTIME_DIR, 'stage_3_manifest_25pct.json');

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

function generateDeterministicStage3Manifest({
  targetCount = 879,
  stage2ManifestPath = STAGE_2_MANIFEST_FILE,
  catalogPath = CATALOG_FILE
} = {}) {
  if (!fs.existsSync(stage2ManifestPath)) {
    throw new Error(`Stage 2 manifest file not found: ${stage2ManifestPath}`);
  }
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog file not found: ${catalogPath}`);
  }

  // 1. Load Stage 2 manifest (400 categories)
  const stage2Manifest = JSON.parse(fs.readFileSync(stage2ManifestPath, 'utf8'));
  const stage2Categories = stage2Manifest.categories || [];
  if (stage2Categories.length !== 400) {
    throw new Error(`Expected 400 categories in Stage 2 manifest, found ${stage2Categories.length}`);
  }
  const stage2CategoryIds = new Set(stage2Categories.map(c => c.categoryId));

  // 2. Load catalog and deduplicate leaf nodes by unique categoryId
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const rawLeaves = (catalog.nodes || []).filter(n => n.categoryId && !n.hasChildren);

  const uniqueLeavesById = new Map();
  rawLeaves.forEach(leaf => {
    if (!uniqueLeavesById.has(leaf.categoryId)) {
      uniqueLeavesById.set(leaf.categoryId, leaf);
    }
  });
  const allLeaves = Array.from(uniqueLeavesById.values());

  // Group all available unique leaves by major root department
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

  // Calculate needed additional categories
  const additionalNeeded = targetCount - stage2Categories.length; // 879 - 400 = 479

  // Filter unused leaves per root
  const unusedLeavesByRoot = new Map();
  let totalUnusedLeaves = 0;
  MAJOR_15_ROOTS.forEach(r => {
    const unused = leavesByRoot.get(r).filter(leaf => !stage2CategoryIds.has(leaf.categoryId));
    unusedLeavesByRoot.set(r, unused);
    totalUnusedLeaves += unused.length;
  });

  // Proportional allocation of additional 479 slots across 15 root departments
  const additionalQuotas = new Map();
  let allocatedAdditional = 0;

  MAJOR_15_ROOTS.forEach(r => {
    const unused = unusedLeavesByRoot.get(r);
    const prop = Math.round((unused.length / totalUnusedLeaves) * additionalNeeded);
    const quota = Math.max(1, Math.min(unused.length, prop));
    additionalQuotas.set(r, quota);
    allocatedAdditional += quota;
  });

  // Adjust allocation to match exactly 479
  let diff = additionalNeeded - allocatedAdditional;
  const sortedRootsByUnused = [...MAJOR_15_ROOTS].sort(
    (a, b) => unusedLeavesByRoot.get(b).length - unusedLeavesByRoot.get(a).length
  );

  while (diff !== 0) {
    for (const r of sortedRootsByUnused) {
      if (diff === 0) break;
      const currentQuota = additionalQuotas.get(r);
      const available = unusedLeavesByRoot.get(r).length;
      if (diff > 0 && currentQuota < available) {
        additionalQuotas.set(r, currentQuota + 1);
        diff--;
      } else if (diff < 0 && currentQuota > 1) {
        additionalQuotas.set(r, currentQuota - 1);
        diff++;
      }
    }
  }

  // Select additional categories with tier balancing
  const newlySelected = [];

  MAJOR_15_ROOTS.forEach(rootName => {
    const unusedPool = unusedLeavesByRoot.get(rootName);
    const quota = additionalQuotas.get(rootName);

    // Group by volume tier
    const heavy = unusedPool.filter(c => c.volume_tier === 'HEAVY').sort((a, b) => a.categoryId - b.categoryId);
    const medium = unusedPool.filter(c => c.volume_tier === 'MEDIUM').sort((a, b) => a.categoryId - b.categoryId);
    const light = unusedPool.filter(c => c.volume_tier === 'LIGHT').sort((a, b) => a.categoryId - b.categoryId);

    // Target ~25% heavy, ~50% medium, ~25% light
    let heavyTarget = Math.max(0, Math.round(quota * 0.25));
    let lightTarget = Math.max(0, Math.round(quota * 0.25));
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

    const rootAdditional = [...pickedHeavy, ...pickedMedium, ...pickedLight];

    // Fallback fill if tiers were uneven
    if (rootAdditional.length < quota) {
      const pickedIds = new Set(rootAdditional.map(c => c.categoryId));
      const leftovers = unusedPool.filter(c => !pickedIds.has(c.categoryId)).sort((a, b) => a.categoryId - b.categoryId);
      for (const l of leftovers) {
        if (rootAdditional.length >= quota) break;
        rootAdditional.push(l);
      }
    }

    newlySelected.push(...rootAdditional);
  });

  // Combine Stage 2 categories + newly selected categories
  const allStage3Categories = [...stage2Categories, ...newlySelected];

  // Strictly verify total count and uniqueness
  if (allStage3Categories.length !== targetCount) {
    throw new Error(`Total categories count mismatch! Expected ${targetCount}, got ${allStage3Categories.length}`);
  }

  const uniqueIds = new Set(allStage3Categories.map(c => c.categoryId));
  if (uniqueIds.size !== targetCount) {
    throw new Error(`Duplicate category IDs detected in Stage 3 manifest! Unique: ${uniqueIds.size}, Total: ${targetCount}`);
  }

  // Final deterministic sort: by rootId, then categoryId
  allStage3Categories.sort((a, b) => {
    if (a.rootId !== b.rootId) return a.rootId - b.rootId;
    return a.categoryId - b.categoryId;
  });

  // Department breakdown
  const departmentBreakdown = {};
  MAJOR_15_ROOTS.forEach(rootName => {
    const deptCats = allStage3Categories.filter(c => c.rootName === rootName);
    const totalAvailable = leavesByRoot.get(rootName).length;
    departmentBreakdown[rootName] = {
      total_leaves_available: totalAvailable,
      quota_selected: deptCats.length,
      heavy_count: deptCats.filter(c => c.volume_tier === 'HEAVY').length,
      medium_count: deptCats.filter(c => c.volume_tier === 'MEDIUM').length,
      light_count: deptCats.filter(c => c.volume_tier === 'LIGHT').length
    };
  });

  // Compute canonical deterministic SHA256 digest of category IDs
  const canonicalIds = allStage3Categories.map(c => c.categoryId);
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonicalIds)).digest('hex');

  const manifest = {
    manifest_name: 'STAGE_3_DETERMINISTIC_25PCT_TAXONOMY_MANIFEST',
    manifest_version: 1,
    target_stage: 3,
    target_percentage: 25,
    target_categories_count: allStage3Categories.length,
    manifest_sha256: hash,
    frozen_at: new Date().toISOString(),
    inherited_stage_2_categories_count: stage2Categories.length,
    newly_added_stage_3_categories_count: newlySelected.length,
    active_streams: {
      product_observations: 'REQUIRED_ACTIVE',
      category_rank_observations: 'REQUIRED_ACTIVE',
      profile_observations: 'EMPTY_ALLOWED_BY_STAGE (Planned Stage 4)',
      inventory_observations: 'EMPTY_ALLOWED_BY_STAGE (Planned Stage 5)'
    },
    root_department_count: MAJOR_15_ROOTS.length,
    department_breakdown: departmentBreakdown,
    category_ids: canonicalIds,
    categories: allStage3Categories
  };

  return manifest;
}

function saveDeterministicManifest(manifest, destPath = STAGE_3_MANIFEST_FILE) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2), 'utf8');
  return destPath;
}

if (require.main === module) {
  console.log('Generating deterministic 25% Stage 3 manifest (879 categories)...');
  const manifest = generateDeterministicStage3Manifest();
  saveDeterministicManifest(manifest);
  console.log(`✓ Stage 3 Manifest successfully generated & frozen:`);
  console.log(`   • Total Categories:       ${manifest.target_categories_count} (exact target: 879)`);
  console.log(`   • Stage 2 Inherited:      ${manifest.inherited_stage_2_categories_count} (all 400 preserved)`);
  console.log(`   • Stage 3 Added:          ${manifest.newly_added_stage_3_categories_count} (newly selected)`);
  console.log(`   • Root Departments:       ${manifest.root_department_count}`);
  console.log(`   • Manifest SHA256:        ${manifest.manifest_sha256}`);
  console.log(`   • Saved to:               ${STAGE_3_MANIFEST_FILE}`);
}

module.exports = {
  generateDeterministicStage3Manifest,
  saveDeterministicManifest,
  MAJOR_15_ROOTS,
  STAGE_3_MANIFEST_FILE
};
