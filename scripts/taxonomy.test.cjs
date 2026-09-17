const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAssignedJson, flattenTree, slugify, normalizeProduct, searchFallbackUrl } = require('./taxonomy_common.cjs');
const { categoryPages, rotatingExpansionPages, shardNodes, collectNewestListings, collectCategoryListings } = require('./collect_taxonomy_shard.cjs');
const { selectDetailCohort, lastTimestamp } = require('./enrich_taxonomy.cjs');

test('Trendyol fragmentindeki atanmış JSON verisini ayrıştırır', () => {
  const props = parseAssignedJson('<script>window["__top-ranking__PROPS"]={"data":{"ok":true,"label":"a}b"}};</script>');
  assert.equal(props.data.ok, true);
});

test('kategori ağacını bütün derinlikleriyle düzleştirir', () => {
  const rows = flattenTree([{ id:27, name:'Aksesuar', children:[{ id:28, name:'Takı & Mücevher', children:[{ id:101, name:'Bileklik', children:[{ id:103541, name:'Altın Bileklik' }] }] }] }]);
  assert.equal(rows.length, 4);
  assert.equal(rows.at(-1).path, 'Aksesuar > Takı & Mücevher > Bileklik > Altın Bileklik');
  assert.equal(rows.at(-1).level, 3);
  assert.equal(slugify('Takı & Mücevher'), 'taki-mucevher');
});

test('kategori işçilerini çakışmadan shardlara böler', () => {
  const nodes = [{categoryId:27},{categoryId:28},{categoryId:29},{categoryId:30},{categoryId:27}];
  const assigned = [0,1,2,3].flatMap(shard => shardNodes(nodes, shard, 4));
  assert.deepEqual(assigned.map(item => item.categoryId).sort(), [27,28,29,30]);
});

test('ana seviyelerde 100, derin seviyelerde günlük 40 ve dönüşümlü 100 uygular', () => {
  assert.equal(categoryPages({categoryId:27,level:0}, '2026-08-21'), 5);
  assert.equal(categoryPages({categoryId:28,level:1}, '2026-08-21'), 5);
  const deepPages = Array.from({length:20}, (_, offset) => categoryPages({categoryId:101+offset,level:2}, '2026-08-21'));
  assert.equal(deepPages.filter(value => value === 5).length, 2);
  assert.equal(deepPages.filter(value => value === 2).length, 18);
});

test('normal kategori sayfalarını 49 günde 3–100 aralığının tamamında döndürür', () => {
  const pages = new Set();
  for (let offset = 0; offset < 49; offset++) {
    const date = new Date(Date.UTC(2026, 8, 1 + offset)).toISOString().slice(0, 10);
    for (const page of rotatingExpansionPages(103498, date, {
      expansionPagesPerCategory: 2, expansionFirstPage: 3, expansionLastPage: 100,
    })) pages.add(page);
  }
  assert.equal(pages.size, 98);
  assert.equal(Math.min(...pages), 3);
  assert.equal(Math.max(...pages), 100);
});

test('ürün adını tıklanabilir tam bağlantı ve kampanya bilgisiyle saklar', () => {
  const product = normalizeProduct({
    id: 123, name: 'Örnek Ürün', url: '/marka/ornek-urun-p-123', inStock: true,
    sanitizedPrice: { finalPrice: { value: 99.9 } },
    promotion: [{ name: 'Sepette İndirim' }]
  });
  assert.equal(product.url, 'https://www.trendyol.com/marka/ornek-urun-p-123');
  assert.deepEqual(product.promotions, ['Sepette İndirim']);
});

test('normal kategori yedeği aynı kategori ve en çok satan sırasını kullanır', () => {
  const url = new URL(searchFallbackUrl(103537, 2, 36));
  assert.equal(url.searchParams.get('wc'), '103537');
  assert.equal(url.searchParams.get('pi'), '2');
  assert.equal(url.searchParams.get('pageSize'), '36');
  assert.equal(url.searchParams.get('sst'), 'BEST_SELLER');
});

test('en yeni ürün kanalı MOST_RECENT sıralamasını kullanır', () => {
  const url = new URL(searchFallbackUrl(103537, 1, 36, 'MOST_RECENT'));
  assert.equal(url.searchParams.get('sst'), 'MOST_RECENT');
});

test('en yeni ürün taraması önceki kontrol ürünlerine ulaşana kadar ilerler', async () => {
  const calls = [];
  const rows = ids => ids.map(id => ({ id, merchantId: 7, name: `Ürün ${id}`, url: `/m/u-p-${id}` }));
  const result = await collectNewestListings(null, 103498, {
    newestDiscovery: true, newestKnownProductIds: ['90', '91', '92'], newestCheckpointHits: 3,
    newestPageSize: 4, newestMaxPagesPerCategory: 10,
    fetchSearchPage: async (_page, _categoryId, pageNumber, _pageSize, _attempts, sort) => {
      calls.push([pageNumber, sort]);
      return pageNumber === 1 ? rows([110, 109, 108, 107]) : rows([106, 90, 91, 92]);
    },
  });
  assert.deepEqual(calls, [[1, 'MOST_RECENT'], [2, 'MOST_RECENT']]);
  assert.equal(result.caughtUp, true);
  assert.equal(result.checkpointHits, 3);
  assert.deepEqual(result.headProductIds, ['110', '109', '108', '107']);
});

test('ilk en yeni ürün çalışması iki sayfalık kontrol tabanı kurar', async () => {
  const result = await collectNewestListings(null, 27, {
    newestDiscovery: true, newestPageSize: 2, newestFirstRunPages: 2, newestMaxPagesPerCategory: 10,
    fetchSearchPage: async (_page, _categoryId, pageNumber) => [
      { id: pageNumber * 10 + 1, merchantId: 1, url: `/m/a-p-${pageNumber * 10 + 1}` },
      { id: pageNumber * 10 + 2, merchantId: 1, url: `/m/a-p-${pageNumber * 10 + 2}` },
    ],
  });
  assert.equal(result.baseline, true);
  assert.equal(result.caughtUp, null);
  assert.equal(result.pages.length, 2);
});

test('çok satanlar boşsa normal kategori ürünlerini ayrıntı kuyruğuna hazırlar', async () => {
  const fallbackRows = Array.from({ length: 36 }, (_, index) => ({
    id: 1000 + index, merchantId: 7, name: `Ürün ${index + 1}`, brand: 'Marka',
    url: `/marka/urun-${index + 1}-p-${1000 + index}`, price: { discountedPrice: 99 },
    tagStockBar: { isSoldOut: false }, ratingScore: { averageRating: 4.5, totalCount: 12 },
  }));
  const result = await collectCategoryListings(null, 103537, 2, {
    catalogExpansion: false,
    pauseMs: 0,
    fetchRankingPage: async () => [],
    fetchSearchPage: async (_page, _categoryId, pageNumber) => pageNumber === 1 ? fallbackRows : fallbackRows.slice(0, 4).map((row, index) => ({
      ...row, id: 2000 + index, url: `/marka/ikinci-${index + 1}-p-${2000 + index}`,
    })),
  });
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.memberships.length, 40);
  assert.equal(result.products.size, 40);
  assert.equal(result.memberships[0].source, 'category_search_fallback');
  assert.equal(result.memberships.at(-1).rank, 40);
  assert.equal(result.products.get('1000:7').brand, 'Marka');
  assert.equal(result.products.get('1000:7').inStock, true);
});

test('çok satanların yanına dönen uzak kategori sayfalarından yeni ürün ekler', async () => {
  const rankingRows = Array.from({ length: 20 }, (_, index) => ({
    id: 1000 + index, merchantId: 7, name: `Çok satan ${index + 1}`, url: `/m/a-p-${1000 + index}`,
  }));
  const expansionRows = Array.from({ length: 36 }, (_, index) => ({
    id: 2000 + index, merchantId: 8, name: `Katalog ${index + 1}`, url: `/m/b-p-${2000 + index}`,
  }));
  const result = await collectCategoryListings(null, 103498, 1, {
    date: '2026-09-14', pauseMs: 0,
    expansionPagesPerCategory: 2, expansionFirstPage: 20, expansionLastPage: 21,
    fetchRankingPage: async (_page, _categoryId, pageNumber) => pageNumber === 1 ? rankingRows : [],
    fetchSearchPage: async (_page, _categoryId, pageNumber) => pageNumber === 20
      ? expansionRows
      : expansionRows.map((row, index) => ({ ...row, id: 3000 + index, url: `/m/c-p-${3000 + index}` })),
  });
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.expansionPages.sort((a, b) => a - b), [20, 21]);
  assert.equal(result.expansionProducts, 72);
  assert.equal(result.products.size, 92);
  assert.equal(result.memberships.filter(row => row.source === 'category_search_expansion').length, 72);
  assert.equal(result.memberships.find(row => row.productKey === '2000:8').rank, 685);
});

test('uzak sayfalardan biri hata verirse çok satan sonuçlarını kaybetmez', async () => {
  const result = await collectCategoryListings(null, 27, 1, {
    date: '2026-09-14', pauseMs: 0,
    expansionPagesPerCategory: 2, expansionFirstPage: 20, expansionLastPage: 21,
    fetchRankingPage: async () => [{ id: 1, merchantId: 2, name: 'Ürün', url: '/m/a-p-1' }],
    fetchSearchPage: async (_page, _categoryId, pageNumber) => {
      if (pageNumber === 20) throw new Error('geçici hata');
      return [{ id: 3, merchantId: 4, name: 'Yeni ürün', url: '/m/b-p-3' }];
    },
  });
  assert.equal(result.products.size, 2);
  assert.equal(result.expansionProducts, 1);
  assert.deepEqual(result.expansionFailures, [{ pageNumber: 20, error: 'geçici hata' }]);
});

test('öncelikli kök kategoriyi gerçek arama sonucunun sonuna kadar tarar', async () => {
  const calls = [];
  const rows = ids => ids.map(id => ({ id, merchantId: 1, name: `Ürün ${id}`, url: `/m/urun-p-${id}` }));
  const result = await collectCategoryListings(null, 173890, 1, {
    catalogExpansion: false,
    newestDiscovery: false,
    pauseMs: 0,
    priorityCategoryIds: [173890],
    prioritySearchPageSize: 2,
    prioritySearchMaxPages: 10,
    prioritySearchPauseMs: 0,
    fetchRankingPage: async () => rows([1]),
    fetchSearchPage: async (_page, _categoryId, pageNumber) => {
      calls.push(pageNumber);
      const page = pageNumber === 1 ? rows([2, 3]) : pageNumber === 2 ? rows([4, 5]) : rows([6]);
      page.total = 5;
      return page;
    },
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(result.priorityPages, 3);
  assert.equal(result.priorityProducts, 5);
  assert.equal(result.products.size, 6);
  assert.equal(result.memberships.filter(row => row.source === 'priority_category_search').length, 5);
});

test('seçilen sayfa kategori toplamını aşarsa gerçek sayfa aralığına döner', async () => {
  const calls = [];
  const result = await collectCategoryListings(null, 27, 1, {
    date: '2026-09-14', pauseMs: 0,
    expansionPagesPerCategory: 1, expansionFirstPage: 3, expansionLastPage: 100,
    fetchRankingPage: async () => [{ id: 1, merchantId: 2, name: 'Ürün', url: '/m/a-p-1' }],
    fetchSearchPage: async (_page, _categoryId, pageNumber) => {
      calls.push(pageNumber);
      const rows = pageNumber > 10 ? [] : [{ id: pageNumber, merchantId: 4, name: 'Yeni ürün', url: `/m/b-p-${pageNumber}` }];
      rows.total = 360;
      return rows;
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0] > 10);
  assert.ok(calls[1] >= 3 && calls[1] <= 10);
  assert.equal(result.expansionProducts, 1);
});

function detailProduct(id) {
  return { productKey: `${id}:1`, productId: id, merchantId: 1, url: `https://www.trendyol.com/x-p-${id}` };
}

test('detay dönüşümü önce geçmişi olmayan kategorilere ürün ayırır', () => {
  const products = [1, 2, 3, 4].map(detailProduct);
  const memberships = [
    { categoryId: 10, productKey: '1:1' },
    { categoryId: 10, productKey: '2:1' },
    { categoryId: 20, productKey: '3:1' },
    { categoryId: 30, productKey: '4:1' },
  ];
  const cohort = selectDetailCohort(products, memberships, {
    watch: [], followUp: [], history: {}, lastObserved: { '1:1': '2026-09-13T08:00:00Z' },
  }, { detailDailyPerShard: 0, detailFollowUpPerShard: 0, detailRotationPerShard: 2 });
  assert.deepEqual(cohort.selected.map(item => item.product.productKey), ['3:1', '4:1']);
  assert.equal(cohort.stats.categoriesObservedBefore, 1);
});

test('ertesi gün stok karşılaştırma kuyruğunu yeni dönüşümden önce işler ve tekilleştirir', () => {
  const products = [1, 2, 3].map(detailProduct);
  const cohort = selectDetailCohort(products, [], {
    watch: [detailProduct(1)],
    followUp: [{ ...detailProduct(1), baselineAt: '2026-09-13T08:00:00Z' }, { ...detailProduct(2), baselineAt: '2026-09-13T08:00:00Z' }],
    history: {}, lastObserved: {},
  }, { detailDailyPerShard: 1, detailFollowUpPerShard: 2, detailRotationPerShard: 1 });
  assert.deepEqual(cohort.selected.map(item => [item.product.productKey, item.reason]), [
    ['1:1', 'daily_watch'],
    ['2:1', 'follow_up'],
    ['3:1', 'rotation'],
  ]);
});

test('eski state geçmişini kalıcı kapsam kaydına taşır', () => {
  const timestamp = '2026-09-13T08:00:00Z';
  assert.equal(lastTimestamp([{ stock_observed_at: 'bozuk' }, { stock_observed_at: timestamp }]), timestamp);
  const cohort = selectDetailCohort([detailProduct(1), detailProduct(2)], [
    { categoryId: 10, productKey: '1:1' }, { categoryId: 20, productKey: '2:1' },
  ], { watch: [], followUp: [], history: { '1:1': [{ stock_observed_at: timestamp }] } }, {
    detailDailyPerShard: 0, detailFollowUpPerShard: 0, detailRotationPerShard: 1,
  });
  assert.equal(cohort.lastObserved['1:1'], timestamp);
  assert.equal(cohort.selected[0].product.productKey, '2:1');
});

test('kurtarılan kategori ürünlerini genel detay dönüşümünden önce tamamlar', () => {
  const products = [1, 2, 3, 4].map(detailProduct);
  const memberships = [
    { categoryId: 10, productKey: '1:1', source: 'top_ranking' },
    { categoryId: 10, productKey: '4:1', source: 'category_search_fallback' },
    { categoryId: 20, productKey: '2:1', source: 'top_ranking' },
    { categoryId: 20, productKey: '3:1', source: 'top_ranking' },
  ];
  const cohort = selectDetailCohort(products, memberships, {
    watch: [], followUp: [], history: {},
    lastObserved: { '1:1': '2026-09-13T08:00:00Z', '2:1': '2026-09-13T08:00:00Z' },
  }, { detailDailyPerShard: 0, detailFollowUpPerShard: 0, detailRotationPerShard: 1 });
  assert.equal(cohort.selected[0].product.productKey, '4:1');
  assert.equal(cohort.stats.fallbackRotation, 1);
});

test('en yeni sıralamasında bulunan ürünü kategori detay tabanında önce seçer', () => {
  const products = [1, 2, 3].map(detailProduct);
  const memberships = [
    { categoryId: 10, productKey: '1:1', source: 'top_ranking' },
    { categoryId: 10, productKey: '3:1', source: 'category_search_newest' },
    { categoryId: 20, productKey: '2:1', source: 'top_ranking' },
  ];
  const cohort = selectDetailCohort(products, memberships, {
    watch: [], followUp: [], history: {}, lastObserved: {},
  }, { detailDailyPerShard: 0, detailFollowUpPerShard: 0, detailRotationPerShard: 1 });
  assert.equal(cohort.selected[0].product.productKey, '3:1');
  assert.equal(cohort.stats.newestRotation, 1);
});
