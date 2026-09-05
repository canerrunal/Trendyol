# Ürün metrikleri ve stoktan satış tahmini

5 Eylül 2026 incelemesi: Hermes gateway PID 789 ve cron heartbeat aktif. 18 Trendyol işi etkin. Bugünkü Erkek koşusu değerlendirme kapsamı %48 olduğu için FAIL; diğer son koşular başarılı. Son tamamlanmış kategori evreni 3.955 kategori / 4.006 yol, 67.677 ürün, 84.520 üyelik. Bunlar tüm Trendyol ürünleri değil, izlenen katalogdur.

## Veri sözleşmesi

Bilinen `__envoy__SHARED_PROPS.product` (eski sayfalarda `__envoy_product-image-gallery__PROPS.product`) nesnesi yalnız JSON olarak ayrıştırılır, JavaScript çalıştırılmaz ve ürün kimliği doğrulanır. Yeni alanlar günlük CSV/JSON geçmişine dahil edilir. Örnek ürün 1164529918 canlı testinde 429,90 TL, 4 adet, M beden, satıcı 868610, 48 değerlendirme, 34 yazılı yorum, 34 soru doğrulandı. Sayfadaki `maxSaleLimit=11` stok değildir.

- `stock_quantity`: seçili satıcı/ilan/varyantın bildirdiği miktar; gerçek depo toplamı veya kesin stok garantisi değildir.
- `inventory_key`: ürün + merchant + itemNumber + listingId. Kimlik yoksa tahmin yok.
- `stock_observed_at`: detayın gerçekten okunduğu zaman; liste koşusunun başlangıç zamanı değil.
- `variants`, `sellers`: yalnız sayfada görülen varyantlar ve satıcılar; miktarı açıklanmayan varyant `null` kalır.
- `seller_count_observed`: benzersiz görülen satıcıların alt sınırı; `seller_count` yalnız kaynak açık toplam veriyorsa doludur. Boş diğer-satıcı listesi tüm satıcıların görüldüğünün kanıtı değildir.
- `rating_count`, `review_count`, `question_count`, `rating`: ayrı metrikler; açıklanmış sıfır korunur, eksik veri sıfıra çevrilmez.

## Satış hesabı

Aynı inventory_key ve kaynakla 18–30 saat aralığında yapılan taze ölçümlerde net azalış / geçen saat × 24, **tahmin** olarak saklanır. 10 → 5, 24 saat ise günlük tahmin 5'tir. Stok yenilemesi, düzeltmesi, iade veya rezervasyon gerçek satıştan fark yaratabilir. Aynı kalan stok kesin sıfır satış demek değildir.

Satıcı/varyant/ilan değişikliği, eksik miktar, eski gözlem, uzun aralık, stok artışı ve değişmeyen miktar için gerekçe kodu saklanır, satış sayısı üretilmez. 7/30 günlük toplam yalnız kesintisiz ölçülmüş aralıklarla hesaplanır; günlük değer çarpılmaz. İlk stok ölçümünden geçmiş satışlar geriye dönük üretilemez. Görünür satış etiketi (ör. 3 günde 250+) bu tahminden ayrı kalır.

## Kapsam ve kapasite

12 mevcut profilin her biri günlük en fazla 300 detay ürünü (önce 200). Minimum kalite sınırı düşürülmedi. Derin kategoriler günlük iki sayfa/40 ürün; 200 ürünlük tarama 10 günde bir (önce 20 gün). Kategori keşfi mevcut ağacın tüm derinliklerini günlük yeniler; bulunmayan kategori kimlikleri uydurulmaz.

Taksonomi shard başına 100 kalıcı takip ürünü + 100 dönüşümlü detay ürünü toplar. Kalıcı URL listesi sıralamadan çıkan ürünlerin de tekrar izlenmesini sağlar. Önceki ölçümler `.runtime/inventory/shard-N.json` içinde tutulur; bu dizin yedeklenmelidir. Silinirse yeni baz ölçümü gerekir. Kategori kapsamı, detay kapsamı ve sayısal stok kapsamı ayrı raporlanır. Tüm katalogdaki tüm satıcı/varyantların günlük tam stok kapsamı bu bütçeyle sağlanmaz; kapasite `taxonomy/collection-config.json` ile ayarlanır.

## Yayın sırası

1. Veri Mimarı reposundaki `202609050001_trendyol_product_metrics.sql` migration uygulanır.
2. Veri Mimarı API/grafik değişiklikleri yayınlanır; eski kayıtlar boş metriklerle okunur.
3. Bu repodaki doğrulanmış collector/config dosyaları Hermes'in `/Users/canerramazanunal/Documents/Trendyol` çalışma kopyasına alınır. Mevcut cron programı değişmez.
4. İlk başarılı koşu baz miktarları yayınlar. Sonraki uygun ölçüm günlük tahmini; yeterli kesintisiz aralık 7/30 günlük toplamları oluşturur.

Kod paketini dağıtmak mevcut veya gelecekteki bütün veri kapsamının doğrulandığı anlamına gelmez. Her koşunun metricCoverage/detailCoverage alanları izlenmelidir.

## Son doğrulama

Canlı 300 ürünlük Erkek koşusu: 299 başarılı detay, başarılı detaylarda %100 sayısal stok; kalite PASS. Soru sayısı başlangıç HTML'inden sonra geldiğinden ürün kimliğiyle eşleşen answered yanıtının yalnız totalElements alanı beklenir. Bu düzeltmeden sonraki altı canlı üründe soru ve stok 6/6; çok satıcılı 35509789 ürününde 16 satıcı, her satıcının fiyat/stok bilgisi ve 8.331 soru doğrulandı.

Supabase metrik migration 5 Eylül 2026 tarihinde canlıda başarıyla uygulandı; iki tablo ve latest görünümde JSONB kolonları doğrulandı.
