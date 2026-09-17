# P0 Baseline Snapshot — 2026-09-17

Bu doküman, Verimimari Marketplace Data Platform V2 Aşama 1 (P0 Stabilizasyon) çalışmalarına başlamadan önceki çalışan sistem durumunu, Git tag'ini, konfigürasyonları ve metrikleri kaydeder.

## Git Durumu
- **Tarih:** 2026-09-17
- **Git Tag:** `pre-v2-stable-2026-09`
- **Aktif Dal:** `codex/veri-mimari-taxonomy-publish`
- **Temel Commit:** `0568bc3` (`feat: publish validated taxonomy to Veri Mimari`)
- **Remote Origin:** `https://github.com/canerrunal/Trendyol.git`

## Çalışan Sistem Bileşenleri
1. **Collector Runtime:** Mac Mini (Node.js v24.19.0, npm 11.17.0)
2. **Scheduler:** Hermes Cron (`~/.hermes/cron/jobs.json`)
   - 12 Kategori Profili: `cocuk` (20:00), `erkek` (21:00), `ev-yasam` (22:00), `kadin` (23:00), `genel-cok-satanlar` (00:00), `supermarket` (01:00), `kozmetik` (02:00), `elektronik` (03:00), `mobilya` (04:00), `otomobil-motosiklet` (05:00), `hamile` (06:00), `hobi` (07:00).
   - Taksonomi: `discovery` (15:00), `shard-0` (15:10), `shard-1` (15:20), `shard-2` (15:30), `shard-3` (15:40), `finalize` (19:10).
3. **Local Operations Dashboard:** `127.0.0.1:4317` (LaunchAgent `com.caner.trendyol-dashboard`, PID 774)
4. **Veritabanı / Ingest:**
   - Supabase PostgreSQL (Pazar Nabzı ve Taksonomi tabloları)
   - Ingest Endpoint: `/api/pazar-nabzi/ingest` ve `/api/pazar-nabzi/taksonomi/ingest`
5. **Bildirim:** Telegram `verimimari_bot`

## Son Başarılı Taksonomi Metrikleri (Snapshot)
- Kategori kataloğu: 3.955 kategori, 4.006 yol
- Benzersiz ürün: ~67.000 - ~113.000 (derinlik ve rotasyon döngüsüne göre)
- Sıralama üyeliği: ~84.500

## Geri Alma (Rollback) Prosedürü
Herhangi bir kritik aksaklık durumunda:
```bash
git checkout pre-v2-stable-2026-09
```
komutu ile bu stabil referans durumuna dönülebilir.
