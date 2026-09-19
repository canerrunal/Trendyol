// =============================================================================
// Verimimari Marketplace Data Platform V2 — Deterministic Stage 5 Manifest Generator
// Generates and freezes a deterministic 100% taxonomy manifest.
//
// Rules:
// 1. Recalculate canonical taxonomy leaf count dynamically from catalog.json (NO hardcoded constants).
// 2. target_stage5_leaf_count = canonicalUniqueCategoryIds (100% taxonomy = 3466).
// 3. MUST preserve every single category from Stage 4 manifest (.runtime/stage_4_manifest_50pct.json).
// 4. Add all remaining 1733 unique categories across all 15 root departments.
// 5. Strictly 100% unique category IDs (zero duplicate categories).
// 6. Deterministic sorting (rootId, categoryId) and reproducible SHA256 digest.
// 7. Freezes manifest to .runtime/stage_5_manifest_100pct.json.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'taxonomy', 'catalog.json');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const STAGE_4_MANIFEST_FILE = path.join(RUNTIME_DIR, 'stage_4_manifest_50pct.json');
const STAGE_5_MANIFEST_FILE = path.join(RUNTIME_DIR, 'stage_5_manifest_100pct.json');

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

function generateDeterministicStage5Manifest({
  catalogPath = CATALOG_FILE,
  stage4ManifestPath = STAGE_4_MANIFEST_FILE
} = {}) {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog source of truth not found: ${catalogPath}`);
  }
  if (!fs.existsSync(stage4ManifestPath)) {
    throw new Error(`Stage 4 manifest file not found: ${stage4ManifestPath}`);
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

  const targetStage5LeafCount = canonicalUniqueCategoryIds;

  // 2. Load Stage 4 manifest (1733 categories) and preserve all of them
  const stage4Manifest = JSON.parse(fs.readFileSync(stage4ManifestPath, 'utf8'));
  const stage4Categories = stage4Manifest.categories || [];
  if (stage4Categories.length === 0) {
    throw new Error(`Stage 4 manifest contains no categories: ${stage4ManifestPath}`);
  }
  const stage4CategoryIds = new Set(stage4Categories.map(c => c.categoryId));

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

  // 3. Extract all remaining unique categories not in Stage 4
  const newlySelected = [];
  allUniqueLeaves.forEach(leaf => {
    if (!stage4CategoryIds.has(leaf.categoryId)) {
      newlySelected.push({
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

  // Combine Stage 4 categories (100% preserved) + newly selected categories
  const allStage5Categories = [...stage4Categories, ...newlySelected];

  // Strictly verify total count and uniqueness
  if (allStage5Categories.length !== targetStage5LeafCount) {
    throw new Error(
      `Total categories count mismatch! Expected ${targetStage5LeafCount}, got ${allStage5Categories.length}`
    );
  }

  const uniqueIds = new Set(allStage5Categories.map(c => c.categoryId));
  if (uniqueIds.size !== targetStage5LeafCount) {
    throw new Error(
      `Duplicate category IDs detected in Stage 5 manifest! Unique: ${uniqueIds.size}, Total: ${targetStage5LeafCount}`
    );
  }

  // Final deterministic sort: by rootId, then categoryId
  allStage5Categories.sort((a, b) => {
    if (a.rootId !== b.rootId) return a.rootId - b.rootId;
    return a.categoryId - b.categoryId;
  });

  // Department breakdown
  const departmentBreakdown = {};
  MAJOR_15_ROOTS.forEach(rootName => {
    const deptCats = allStage5Categories.filter(c => c.rootName === rootName);
    const totalAvailable = leavesByRoot.get(rootName).length;
    departmentBreakdown[rootName] = {
      total_leaves_available: totalAvailable,
      quota_selected: deptCats.length,
      coverage_percent: 100.0,
      heavy_count: deptCats.filter(c => c.volume_tier === 'HEAVY').length,
      medium_count: deptCats.filter(c => c.volume_tier === 'MEDIUM').length,
      light_count: deptCats.filter(c => c.volume_tier === 'LIGHT').length
    };
  });

  // Compute canonical deterministic SHA256 digest of category IDs
  const canonicalIds = allStage5Categories.map(c => c.categoryId);
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonicalIds)).digest('hex');

  const manifest = {
    manifest_name: 'STAGE_5_DETERMINISTIC_100PCT_TAXONOMY_MANIFEST',
    manifest_version: 1,
    target_stage: 5,
    target_percentage: 100,
    target_scope: '100% Taxonomy Scope (Full Production Population)',
    canonical_leaf_count_source: 'taxonomy/catalog.json',
    canonical_unique_category_ids: canonicalUniqueCategoryIds,
    canonical_leaf_nodes_count: catalog.stats?.leaves || rawLeaves.length,
    policy: '100pct_of_canonical_unique_category_ids',
    target_categories_count: allStage5Categories.length,
    manifest_sha256: hash,
    frozen_at: new Date().toISOString(),
    inherited_stage_4_categories_count: stage4Categories.length,
    newly_added_stage_5_categories_count: newlySelected.length,
    active_streams: {
      product_observations: 'REQUIRED_ACTIVE',
      category_rank_observations: 'REQUIRED_ACTIVE',
      profile_observations: 'EMPTY_ALLOWED_BY_STAGE',
      inventory_observations: 'EMPTY_ALLOWED_BY_STAGE'
    },
    root_department_count: MAJOR_15_ROOTS.length,
    department_breakdown: departmentBreakdown,
    category_ids: canonicalIds,
    categories: allStage5Categories
  };

  return manifest;
}

function saveDeterministicManifest(manifest, destPath = STAGE_5_MANIFEST_FILE) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2), 'utf8');
  return destPath;
}

if (require.main === module) {
  console.log('Recalculating canonical taxonomy leaf count and generating deterministic 100% Stage 5 manifest...');
  const manifest = generateDeterministicStage5Manifest();
  saveDeterministicManifest(manifest);
  console.log(`✓ Stage 5 Manifest successfully generated & frozen:`);
  console.log(`   • Canonical Leaves (Unique): ${manifest.canonical_unique_category_ids} (${manifest.canonical_leaf_nodes_count} raw nodes)`);
  console.log(`   • Target Categories (100%):  ${manifest.target_categories_count} (Policy: ${manifest.policy})`);
  console.log(`   • Stage 4 Inherited:         ${manifest.inherited_stage_4_categories_count} (all 1733 preserved)`);
  console.log(`   • Stage 5 Newly Added:       ${manifest.newly_added_stage_5_categories_count}`);
  console.log(`   • Root Departments:          ${manifest.root_department_count}`);
  console.log(`   • Manifest SHA256:           ${manifest.manifest_sha256}`);
  console.log(`   • Saved to:                  ${STAGE_5_MANIFEST_FILE}`);
}

module.exports = {
  generateDeterministicStage5Manifest,
  saveDeterministicManifest,
  MAJOR_15_ROOTS,
  STAGE_5_MANIFEST_FILE
};
