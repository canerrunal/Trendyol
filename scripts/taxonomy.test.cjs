const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAssignedJson, flattenTree, slugify, normalizeProduct } = require('./taxonomy_common.cjs');
const { categoryPages, shardNodes } = require('./collect_taxonomy_shard.cjs');
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

test('ana seviyelerde 200, derin seviyelerde günlük 40 ve dönüşümlü 200 uygular', () => {
  assert.equal(categoryPages({categoryId:27,level:0}, '2026-08-21'), 10);
  assert.equal(categoryPages({categoryId:28,level:1}, '2026-08-21'), 10);
  const deepPages = Array.from({length:20}, (_, offset) => categoryPages({categoryId:101+offset,level:2}, '2026-08-21'));
  assert.equal(deepPages.filter(value => value === 10).length, 2);
  assert.equal(deepPages.filter(value => value === 2).length, 18);
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
