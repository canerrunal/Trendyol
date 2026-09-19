// =============================================================================
// Verimimari Marketplace Data Platform V2 — Deterministic Stage 4 Manifest Generator
// Generates and freezes a deterministic 50% taxonomy manifest.
//
// Rules:
// 1. Recalculate canonical taxonomy leaf count dynamically from catalog.json (NO hardcoded constants).
// 2. target_stage4_leaf_count = Math.floor(canonicalLeafCount * 0.50).
// 3. MUST preserve every single category from Stage 3 manifest (.runtime/stage_3_manifest_25pct.json).
// 4. Balanced selection across all 15 root departments and heavy/medium/light volume tiers.
// 5. Strictly 100% unique category IDs (zero duplicate categories).
// 6. Deterministic sorting (rootId, categoryId) and reproducible SHA256 digest.
// 7. Freezes manifest to .runtime/stage_4_manifest_50pct.json.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'taxonomy', 'catalog.json');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const STAGE_3_MANIFEST_FILE = path.join(RUNTIME_DIR, 'stage_3_manifest_25pct.json');
const STAGE_4_MANIFEST_FILE = path.join(RUNTIME_DIR, 'stage_4_manifest_50pct.json');

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

function generateDeterministicStage4Manifest({
  catalogPath = CATALOG_FILE,
  stage3ManifestPath = STAGE_3_MANIFEST_FILE,
  policy = 'floor' // 'floor' or 'round'
} = {}) {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog source of truth not found: ${catalogPath}`);
  }
  if (!fs.existsSync(stage3ManifestPath)) {
    throw new Error(`Stage 3 manifest file not found: ${stage3ManifestPath}`);
  }

  // 1. Load catalog and dynamically determine canonical unique category IDs (NO HARDCODING)
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const rawLeaves = (catalog.nodes || []).filter(n => n.categoryId && !n.hasChildren);

  // Authoritative rollout population: deduplicate raw leaves by categoryId
  const uniqueLeavesById = new Map();
  rawLeaves.forEach(leaf => {
    if (!uniqueLeavesById.has(leaf.categoryId)) {
      uniqueLeavesById.set(leaf.categoryId, leaf);
    }
  });
  const canonicalUniqueCategoryIds = uniqueLeavesById.size;

  if (!canonicalUniqueCategoryIds || canonicalUniqueCategoryIds <= 0) {
    throw new Error('Unable to determine canonical unique category IDs from catalog source of truth');
  }

  // Defined policy: 50% of canonical unique category IDs (floor policy: 1733)
  const targetStage4LeafCount = policy === 'round'
    ? Math.round(canonicalUniqueCategoryIds * 0.50)
    : Math.floor(canonicalUniqueCategoryIds * 0.50);

  // 2. Load Stage 3 manifest (879 categories) and preserve all of them
  const stage3Manifest = JSON.parse(fs.readFileSync(stage3ManifestPath, 'utf8'));
  const stage3Categories = stage3Manifest.categories || [];
  if (stage3Categories.length === 0) {
    throw new Error(`Stage 3 manifest contains no categories: ${stage3ManifestPath}`);
  }
  const stage3CategoryIds = new Set(stage3Categories.map(c => c.categoryId));

  const allUniqueLeaves = Array.from(uniqueLeavesById.values());

  // Group leaves by major root department
  const leavesByRoot = new Map();
  MAJOR_15_ROOTS.forEach(r => leavesByRoot.set(r, []));

  allUniqueLeaves.forEach(leaf => {
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

  // Calculate additional categories needed
  const additionalNeeded = targetStage4LeafCount - stage3Categories.length;
  if (additionalNeeded <= 0) {
    throw new Error(`Target Stage 4 count (${targetStage4LeafCount}) must exceed Stage 3 count (${stage3Categories.length})`);
  }

  // Filter unused leaves per root
  const unusedLeavesByRoot = new Map();
  let totalUnusedLeaves = 0;
  MAJOR_15_ROOTS.forEach(r => {
    const unused = leavesByRoot.get(r).filter(leaf => !stage3CategoryIds.has(leaf.categoryId));
    unusedLeavesByRoot.set(r, unused);
    totalUnusedLeaves += unused.length;
  });

  if (totalUnusedLeaves < additionalNeeded) {
    throw new Error(`Insufficient unused leaves in major roots! Available: ${totalUnusedLeaves}, Needed: ${additionalNeeded}`);
  }

  // Proportional allocation of additional slots across 15 root departments
  const additionalQuotas = new Map();
  let allocatedAdditional = 0;

  MAJOR_15_ROOTS.forEach(r => {
    const unused = unusedLeavesByRoot.get(r);
    const prop = Math.round((unused.length / totalUnusedLeaves) * additionalNeeded);
    const quota = Math.max(1, Math.min(unused.length, prop));
    additionalQuotas.set(r, quota);
    allocatedAdditional += quota;
  });

  // Adjust allocation to match exactly additionalNeeded
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

  // Select additional categories with volume tier balancing (~25% heavy, ~50% medium, ~25% light)
  const newlySelected = [];

  MAJOR_15_ROOTS.forEach(rootName => {
    const unusedPool = unusedLeavesByRoot.get(rootName);
    const quota = additionalQuotas.get(rootName);

    // Group by volume tier
    const heavy = unusedPool.filter(c => c.volume_tier === 'HEAVY').sort((a, b) => a.categoryId - b.categoryId);
    const medium = unusedPool.filter(c => c.volume_tier === 'MEDIUM').sort((a, b) => a.categoryId - b.categoryId);
    const light = unusedPool.filter(c => c.volume_tier === 'LIGHT').sort((a, b) => a.categoryId - b.categoryId);

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

  // Combine Stage 3 categories (100% preserved) + newly selected categories
  const allStage4Categories = [...stage3Categories, ...newlySelected];

  // Strictly verify total count and uniqueness
  if (allStage4Categories.length !== targetStage4LeafCount) {
    throw new Error(
      `Total categories count mismatch! Expected ${targetStage4LeafCount}, got ${allStage4Categories.length}`
    );
  }

  const uniqueIds = new Set(allStage4Categories.map(c => c.categoryId));
  if (uniqueIds.size !== targetStage4LeafCount) {
    throw new Error(
      `Duplicate category IDs detected in Stage 4 manifest! Unique: ${uniqueIds.size}, Total: ${targetStage4LeafCount}`
    );
  }

  // Final deterministic sort: by rootId, then categoryId
  allStage4Categories.sort((a, b) => {
    if (a.rootId !== b.rootId) return a.rootId - b.rootId;
    return a.categoryId - b.categoryId;
  });

  // Department breakdown
  const departmentBreakdown = {};
  MAJOR_15_ROOTS.forEach(rootName => {
    const deptCats = allStage4Categories.filter(c => c.rootName === rootName);
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
  const canonicalIds = allStage4Categories.map(c => c.categoryId);
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonicalIds)).digest('hex');

  const manifest = {
    manifest_name: 'STAGE_4_DETERMINISTIC_50PCT_TAXONOMY_MANIFEST',
    manifest_version: 1,
    target_stage: 4,
    target_percentage: 50,
    target_scope: '50% Taxonomy Scope',
    canonical_leaf_count_source: 'taxonomy/catalog.json',
    canonical_unique_category_ids: canonicalUniqueCategoryIds,
    canonical_leaf_nodes_count: catalog.stats?.leaves || rawLeaves.length,
    policy: `${policy}_50pct_of_canonical_unique_category_ids`,
    target_categories_count: allStage4Categories.length,
    manifest_sha256: hash,
    frozen_at: new Date().toISOString(),
    inherited_stage_3_categories_count: stage3Categories.length,
    newly_added_stage_4_categories_count: newlySelected.length,
    active_streams: {
      product_observations: 'REQUIRED_ACTIVE',
      category_rank_observations: 'REQUIRED_ACTIVE',
      profile_observations: 'EMPTY_ALLOWED_BY_STAGE',
      inventory_observations: 'EMPTY_ALLOWED_BY_STAGE'
    },
    root_department_count: MAJOR_15_ROOTS.length,
    department_breakdown: departmentBreakdown,
    category_ids: canonicalIds,
    categories: allStage4Categories
  };

  return manifest;
}

function saveDeterministicManifest(manifest, destPath = STAGE_4_MANIFEST_FILE) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2), 'utf8');
  return destPath;
}

if (require.main === module) {
  console.log('Recalculating canonical taxonomy leaf count and generating deterministic 50% Stage 4 manifest...');
  const manifest = generateDeterministicStage4Manifest();
  saveDeterministicManifest(manifest);
  console.log(`✓ Stage 4 Manifest successfully generated & frozen:`);
  console.log(`   • Canonical Leaves (Unique): ${manifest.canonical_unique_category_ids} (${manifest.canonical_leaf_nodes_count} raw nodes)`);
  console.log(`   • Target Categories (50%):   ${manifest.target_categories_count} (Policy: ${manifest.policy})`);
  console.log(`   • Stage 3 Inherited:         ${manifest.inherited_stage_3_categories_count} (all 879 preserved)`);
  console.log(`   • Stage 4 Newly Added:       ${manifest.newly_added_stage_4_categories_count}`);
  console.log(`   • Root Departments:          ${manifest.root_department_count}`);
  console.log(`   • Manifest SHA256:           ${manifest.manifest_sha256}`);
  console.log(`   • Saved to:                  ${STAGE_4_MANIFEST_FILE}`);
}

module.exports = {
  generateDeterministicStage4Manifest,
  saveDeterministicManifest,
  MAJOR_15_ROOTS,
  STAGE_4_MANIFEST_FILE
};
