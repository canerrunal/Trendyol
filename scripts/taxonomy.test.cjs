const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAssignedJson, flattenTree, slugify, normalizeProduct } = require('./taxonomy_common.cjs');
const { categoryPages, shardNodes } = require('./collect_taxonomy_shard.cjs');

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
