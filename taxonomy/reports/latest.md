# Trendyol Çok Satanlar Kategori Evreni — 2026-09-18

## Yönetici özeti

- **Run ID:** `trendyol-20260918-120006-8adcd`
- **Kalite:** PARTIAL
- **Yayın durumu:** BLOCKED_PARTIAL
- **Kategori kataloğu:** 4.006 menü yolu, 3.955 benzersiz kategori kimliği, 6 seviye
- **Günlük güncellenen kategori:** 0/3.955 (%0)
- **Canlı yayına girecek toplam kapsama:** 3.883/3.955 (%98,18)
- **Benzersiz ürün:** 480.918
- **Kategori–ürün sıralama kaydı:** 565.930
- **Ürün döndüren kategori:** 3.883
- **Başarılı fakat boş kategori:** 0
- **Normal kategori vitriniyle kurtarılan:** 0
- **Dönen uzak kategori sayfalarıyla genişletilen:** 0 kategori, 192.620 ek kayıt
- **Öncelikli dört kök kategori taraması:** 0 ek ürün, 0 kategori arama sayfası
- **Atlanan uzak sayfa isteği:** 0
- **En yeni sıralamasında bulunan:** 169.234 ürün, 2.908 kategori, 0 sayfa
- **Öncelikli en yeni ürün detayı:** 0
- **Yeni ürün kontrol noktası:** 0 tamamlandı, 0 yoğun kategori sınıra ulaştı, 0 ilk ölçüm
- **Detay geçmişi olan kategori:** 0/3.883 (%0)
- **Bugün yenilenen ürün detayı:** 0/0; ilk kez ölçülen 0
- **Öncelikli fallback ürün detayı:** 0
- **Hatalı kategori:** 0
- **Önceki geçerli veriden taşınan kategori:** 3.883
- **Eksik shard çıktısı:** 0, 1, 2, 3

## Tarama stratejisi

Bütün kategorilerin ilk 40 ürünü her gün izlenir; Çok Satanlar servisinin desteklediği üst sınır olan ilk 100 ürün ana, birinci seviye ve 10 günlük dönüşüme giren kategorilerde alınır. Ayrıca her ürün döndüren kategorinin normal vitrindeki 3–100. sayfaları 49 günlük dönüşümle ikişer sayfa taranır. Seçilen sayfa kategori ürün sayısını aşarsa istek gerçek son sayfa aralığına döndürülür. Her kategori ayrıca `MOST_RECENT` sırasıyla taranır; önceki günün kontrol ürünlerine ulaşılana kadar en çok 10 sayfa ilerlenir. İlk çalışmada iki sayfalık başlangıç kaydı oluşturulur. Çok Satanlar servisi boş dönerse aynı kategori normal ürün aramasında en çok satan sırasıyla otomatik yeniden taranır. Bütün bulunan ürünler aynı detay ve ertesi gün stok karşılaştırma kuyruğuna girer.

## Ana kategori kapsamı

| Ana kategori | Kapsanan / Toplam | Oran |
|---|---:|---:|
| Aksesuar | 152/156 | %97,44 |
| Anne & Bebek & Çocuk | 101/107 | %94,39 |
| Ayakkabı | 45/46 | %97,83 |
| Bahçe & Yapı Market | 359/363 | %98,9 |
| Digital Goods | 6/6 | %100 |
| Elektronik | 372/379 | %98,15 |
| Ev ve Mobilya | 391/406 | %96,31 |
| Giyim | 197/199 | %98,99 |
| Hamile Giyim | 50/52 | %96,15 |
| Hobi | 257/259 | %99,23 |
| Kırtasiye & Ofis Malzemeleri | 126/126 | %100 |
| Kitap | 123/134 | %91,79 |
| Kompakt Fotoğraf Makinesi | 1/1 | %100 |
| Kozmetik & Kişisel Bakım | 178/180 | %98,89 |
| Otomobil & Motosiklet | 416/416 | %100 |
| Sanat Eseri | 8/9 | %88,89 |
| Spor&Outdoor | 465/471 | %98,73 |
| Süpermarket | 642/652 | %98,47 |
| Takı & Aksesuar Setleri | 1/1 | %100 |

## Veri dosyaları

- [Kategori kataloğu](../catalog.csv)
- [Günlük özet](../snapshots/2026-09-18/summary.json)
- Günlük sıralamalar: `taxonomy/snapshots/2026-09-18/rankings.ndjson.gz`
- Tekilleştirilmiş ürünler: `taxonomy/snapshots/2026-09-18/products.ndjson.gz`
- En yeni sıralamasında bulunan ürünler: `taxonomy/snapshots/2026-09-18/new-products.ndjson.gz`
