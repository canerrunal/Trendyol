# Trendyol Çok Satanlar Kategori Evreni — 2026-09-15

## Yönetici özeti

- **Kalite:** PARTIAL
- **Kategori kataloğu:** 4.006 menü yolu, 3.955 benzersiz kategori kimliği, 6 seviye
- **Günlük güncellenen kategori:** 970/3.955 (%24,53)
- **Canlı yayına girecek toplam kapsama:** 3.743/3.955 (%94,64)
- **Benzersiz ürün:** 248.705
- **Kategori–ürün sıralama kaydı:** 281.389
- **Ürün döndüren kategori:** 3.743
- **Başarılı fakat boş kategori:** 0
- **Normal kategori vitriniyle kurtarılan:** 62
- **Dönen uzak kategori sayfalarıyla genişletilen:** 912 kategori, 63.225 ek kayıt
- **Öncelikli dört kök kategori taraması:** 0 ek ürün, 0 kategori arama sayfası
- **Atlanan uzak sayfa isteği:** 0
- **En yeni sıralamasında bulunan:** 68.779 ürün, 952 kategori, 2.218 sayfa
- **Öncelikli en yeni ürün detayı:** 699
- **Yeni ürün kontrol noktası:** 898 tamamlandı, 72 yoğun kategori sınıra ulaştı, 0 ilk ölçüm
- **Detay geçmişi olan kategori:** 970/3.743 (%25,92)
- **Bugün yenilenen ürün detayı:** 1.480/1.500; ilk kez ölçülen 700
- **Öncelikli fallback ürün detayı:** 0
- **Hatalı kategori:** 0
- **Önceki geçerli veriden taşınan kategori:** 2.773
- **Eksik shard çıktısı:** 1, 2, 3

## Tarama stratejisi

Bütün kategorilerin ilk 40 ürünü her gün izlenir; Çok Satanlar servisinin desteklediği üst sınır olan ilk 100 ürün ana, birinci seviye ve 10 günlük dönüşüme giren kategorilerde alınır. Ayrıca her ürün döndüren kategorinin normal vitrindeki 3–100. sayfaları 49 günlük dönüşümle ikişer sayfa taranır. Seçilen sayfa kategori ürün sayısını aşarsa istek gerçek son sayfa aralığına döndürülür. Her kategori ayrıca `MOST_RECENT` sırasıyla taranır; önceki günün kontrol ürünlerine ulaşılana kadar en çok 10 sayfa ilerlenir. İlk çalışmada iki sayfalık başlangıç kaydı oluşturulur. Çok Satanlar servisi boş dönerse aynı kategori normal ürün aramasında en çok satan sırasıyla otomatik yeniden taranır. Bütün bulunan ürünler aynı detay ve ertesi gün stok karşılaştırma kuyruğuna girer.

## Ana kategori kapsamı

| Ana kategori | Kapsanan / Toplam | Oran |
|---|---:|---:|
| Aksesuar | 151/156 | %96,79 |
| Anne & Bebek & Çocuk | 87/107 | %81,31 |
| Ayakkabı | 45/46 | %97,83 |
| Bahçe & Yapı Market | 347/363 | %95,59 |
| Digital Goods | 6/6 | %100 |
| Elektronik | 363/379 | %95,78 |
| Ev ve Mobilya | 358/406 | %88,18 |
| Giyim | 188/199 | %94,47 |
| Hamile Giyim | 46/52 | %88,46 |
| Hobi | 255/259 | %98,46 |
| Kırtasiye & Ofis Malzemeleri | 125/126 | %99,21 |
| Kitap | 107/134 | %79,85 |
| Kompakt Fotoğraf Makinesi | 1/1 | %100 |
| Kozmetik & Kişisel Bakım | 174/180 | %96,67 |
| Otomobil & Motosiklet | 411/416 | %98,8 |
| Sanat Eseri | 7/9 | %77,78 |
| Spor&Outdoor | 458/471 | %97,24 |
| Süpermarket | 620/652 | %95,09 |
| Takı & Aksesuar Setleri | 1/1 | %100 |

## Veri dosyaları

- [Kategori kataloğu](../catalog.csv)
- [Günlük özet](../snapshots/2026-09-15/summary.json)
- Günlük sıralamalar: `taxonomy/snapshots/2026-09-15/rankings.ndjson.gz`
- Tekilleştirilmiş ürünler: `taxonomy/snapshots/2026-09-15/products.ndjson.gz`
- En yeni sıralamasında bulunan ürünler: `taxonomy/snapshots/2026-09-15/new-products.ndjson.gz`
