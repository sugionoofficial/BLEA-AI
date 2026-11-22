# Ollama lokal lewat Cloudflare Tunnel

Dokumen ini menjelaskan cara memakai model **Ollama** yang berjalan di komputer sendiri
(Windows/macOS/Linux) sebagai provider Chat di BLEA-AI, tanpa VPS dan tanpa biaya.

## Kenapa perlu tunnel

Worker BLEA-AI berjalan di edge Cloudflare. Dari sana `http://localhost:11434` menunjuk
ke mesin Cloudflare, bukan ke komputer pengguna, sehingga Ollama lokal **tidak bisa**
dipanggil langsung. Solusinya: buat endpoint HTTPS publik yang meneruskan permintaan ke
Ollama lokal memakai Cloudflare Tunnel (`cloudflared`).

```
Browser → Worker BLEA (edge) → https://xxxx.trycloudflare.com → cloudflared di laptop → Ollama 127.0.0.1:11434
```

Provider `ollama` sudah terdaftar sebagai preset chat-only (`PROVIDER_PRESETS.ollama` di
`src/lib/videoCatalog.js`). Preset ini tidak pernah muncul di `/api/video/models` karena
Ollama tidak punya endpoint video, dan **tidak punya default base URL** — Worker tidak
boleh diam-diam mengarahkan provider ini ke API provider lain.

## 1. Siapkan Ollama

```powershell
ollama list                                  # pastikan model sudah ada
ollama pull qwen3.5:4b                       # contoh model chat 4B
ollama run qwen3.5:4b                        # uji chat di terminal, /bye untuk keluar
```

Untuk laptop 8 GB RAM, batasi context agar tidak swap:

```
/set parameter num_ctx 8192
```

Pastikan server hanya mendengarkan di localhost (default). Jangan set
`OLLAMA_HOST=0.0.0.0` di laptop — bukan hanya tidak perlu, tapi juga berisiko.

## 2. Jalankan Cloudflare Tunnel

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:11434
```

Output memuat URL acak, contoh:

```
Your quick Tunnel has been created! Visit it at:
https://kucing-biru-abc123.trycloudflare.com
```

Biarkan jendela itu terbuka selama BLEA dipakai. Verifikasi dari terminal lain:

```powershell
curl.exe -s https://kucing-biru-abc123.trycloudflare.com/api/tags
curl.exe -s https://kucing-biru-abc123.trycloudflare.com/v1/models
```

Kalau keduanya mengembalikan JSON model, tunnel siap.

## 3. Daftarkan provider di BLEA

Provider key disimpan di tabel Supabase `provider_api_keys`.

**Cara 1 — Admin Panel (disarankan).** Admin Panel → **API Key** → **Tambah Provider**,
klik chip **Ollama (self-host)**, lalu:

1. isi *Base URL* dengan URL tunnel, mis. `https://kucing-biru-abc123.trycloudflare.com`;
2. simpan, lalu buka baris provider **Ollama (self-host)**;
3. pada kolom API key isi `ollama-local` (string apa saja, **minimal 8 karakter**) → simpan.

**Cara 2 — SQL Editor Supabase** (kalau tidak mau lewat UI):

```sql
insert into provider_api_keys (provider, label, api_key, base_url)
values ('ollama', 'Ollama Laptop (tunnel)', 'ollama-local', 'https://kucing-biru-abc123.trycloudflare.com')
on conflict (provider) do update
  set label = excluded.label, api_key = excluded.api_key, base_url = excluded.base_url;
```

- `api_key` diisi string apa saja **minimal 8 karakter** (`ollama-local`), karena Ollama
  tidak memvalidasi key. Worker menolak provider tanpa key
  (`API key untuk provider "ollama" belum dikonfigurasi`), dan tabel `provider_api_keys`
  punya constraint `char_length(api_key) = 0 or between 8 and 2048` — key 1–7 karakter
  akan gagal disimpan dengan pesan "Penyimpanan gagal".
- `base_url` boleh dengan atau tanpa akhiran `/v1`; `resolveProviderApiBase` menormalkannya
  menjadi `.../v1`.

Aktifkan model yang mau dipakai — **Admin Panel → Katalog Model**, pilih provider
**Ollama (self-host)**, klik muat katalog (Worker memanggil `{base_url}/v1/models`), lalu
aktifkan model yang diinginkan. Model non-chat (embedding) otomatis disaring.

Alternatif SQL:

```sql
insert into provider_models (provider, model, active)
values ('ollama', 'qwen3.5:4b', true)
on conflict (provider, model) do update set active = true;
```

Nama model harus **persis** seperti keluaran `ollama list` (termasuk tag setelah `:`).

Cek hasilnya:

```bash
curl -s https://<worker-anda>/api/status
# {"ok":true,"configured":true,"providers":["ollama"],...}

curl -s https://<worker-anda>/api/enabled-models
# model dengan provider "ollama" muncul di modelItems
```

Chat di BLEA hanya memakai model yang aktif di `provider_models` **dan** tertarik ke
`/api/enabled-models` (model video/embedding otomatis disaring).

## 4. Keamanan — wajib dibaca

Quick tunnel bersifat **publik dan tanpa autentikasi**. Siapa pun yang mengetahui URL
dapat memakai CPU laptop Anda. Mitigasi yang disarankan:

1. Jangan bagikan URL tunnel; URL baru terbentuk setiap kali `cloudflared` dijalankan ulang.
2. Batasi model kecil dan `num_ctx` rendah agar penyalahgunaan tidak menghabiskan RAM.
3. Untuk pemakaian serius, pakai **named tunnel + Cloudflare Access** (Zero Trust) atau
   taruh token bersama di reverse proxy sehingga `/v1/*` menolak permintaan tanpa header
   `authorization` yang benar.
4. Matikan tunnel (`Ctrl+C`) saat tidak dipakai.

## 5. Named tunnel permanen (butuh domain di Cloudflare)

```powershell
cloudflared tunnel login
cloudflared tunnel create blea-ollama
cloudflared tunnel route dns blea-ollama ollama.contoh.com
cloudflared tunnel run --url http://localhost:11434 blea-ollama
```

Lalu pakai `https://ollama.contoh.com` sebagai `base_url`. Hanya URL ini yang perlu
diperbarui; URL quick tunnel berubah setiap restart sehingga `base_url` di database harus
di-`update` juga.

## 6. Batasan yang perlu diketahui

- Laptop harus menyala, tidak sleep, dan Ollama berjalan. Kalau laptop mati, chat gagal
  (`502`/`530`) sampai tunnel hidup lagi.
- Kecepatan = kecepatan laptop Anda, bukan Cloudflare. Token pertama lambat karena model
  dimuat ke RAM (`OLLAMA_KEEP_ALIVE=30m` membantu).
- Streaming didukung (`/v1/chat/completions` dengan `stream: true`), tapi throughput tetap
  dibatasi uplink rumah.
- Vision/tools hanya berfungsi bila modelnya mendukung; BLEA mengirim payload chat biasa.
- Tidak ada penagihan kredit BLEA pada jalur ini — biayanya RAM dan listrik Anda sendiri.

## 7. Troubleshooting

| Gejala | Penyebab | Solusi |
| --- | --- | --- |
| `502` / `530` dari Worker | Tunnel mati atau URL kedaluwarsa | Jalankan `cloudflared` lagi, `update provider_api_keys` dengan URL baru |
| `Base URL untuk provider "ollama" tidak valid` | `base_url` kosong / bukan http(s) | Isi `base_url` dengan URL tunnel |
| `API key untuk provider "ollama" belum dikonfigurasi` | `api_key` kosong | Isi dengan string ≥ 8 karakter, mis. `ollama-local` |
| `Penyimpanan gagal` di Admin Panel | `api_key` 1–7 karakter (constraint tabel) | Pakai minimal 8 karakter, mis. `ollama-local` |
| `model not found` dari Ollama | Nama model beda tag | Samakan dengan `ollama list` |
| Chat menggantung lalu timeout | Model terlalu besar untuk RAM laptop | Pakai 1B–4B, turunkan `num_ctx` |
| Katalog kosong | `/v1/models` gagal | Uji `curl.exe {base_url}/v1/models`; pastikan tidak ada `/api` di URL |
| URL berubah tiap restart | Quick tunnel | Pakai named tunnel (bagian 5) |

## 8. Uji otomatis di repo

```bash
node --test tests/ollama-tunnel.test.js
```

Test mencakup normalisasi base URL, `/api/status`, `/api/catalog`, `/api/chat` ke endpoint
OpenAI-compatible Ollama, dan jaminan bahwa `ollama` tidak pernah muncul sebagai provider
video.
