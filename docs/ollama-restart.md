# Mulai ulang: menyalakan Ollama + tunnel untuk BLEA

Panduan ini untuk dipakai **setiap kali laptop baru menyala** atau setelah restart.
Tidak perlu mengingat apa pun dari percakapan sebelumnya: cukup ikuti empat langkah
di bawah, sekitar dua menit.

Kalau baru pertama kali menyiapkan (belum pernah install apa pun), mulai dari
`docs/ollama-tunnel.md`. Dokumen ini khusus untuk pengulangan.

## Ringkasan

| # | Langkah | Perkiraan waktu |
|---|---------|-----------------|
| 1 | Pastikan Ollama hidup | 10 detik |
| 2 | Jalankan skrip tunnel | 20-60 detik |
| 3 | Tempel URL di Admin Panel | 20 detik |
| 4 | Uji di Chat | 30 detik |

---

## Langkah 1 - Pastikan Ollama hidup

Cek ikon Ollama di system tray (dekat jam). Kalau tidak ada, jalankan dari Start Menu:
**Ollama**.

Verifikasi cepat di PowerShell:

```powershell
ollama list
```

Harus muncul model yang dipakai BLEA:

```
huihui_ai/qwen2.5-abliterate:3b
```

Kalau perintah itu error "connection refused", jalankan server-nya secara manual:

```powershell
ollama serve
```

Biarkan jendela itu terbuka, lalu lanjut ke langkah 2 di jendela PowerShell baru.

---

## Langkah 2 - Jalankan skrip tunnel

```powershell
cd C:\blea-ai
powershell -ExecutionPolicy Bypass -File .\tools\ollama-tunnel-quick.ps1
```

Skrip akan:

1. memeriksa Ollama dan menampilkan model yang tersedia;
2. mencari `cloudflared`;
3. menyalakan tunnel dengan `--http-host-header` (tanpa flag ini Ollama membalas 403);
4. menunggu URL `https://....trycloudflare.com` muncul;
5. menyalin URL itu ke clipboard;
6. mengecek `GET /v1/models` sampai `200`.

Contoh keluaran yang benar:

```
==> Cek Ollama di http://127.0.0.1:11434
    Model: huihui_ai/qwen2.5-abliterate:3b
==> Cari cloudflared
    C:\Program Files (x86)\cloudflared\cloudflared.exe
==> Mulai tunnel (log: C:\Users\lenovo\AppData\Local\Temp\blea-ollama-tunnel-....log)
==> Menunggu URL trycloudflare (maks 90 detik)
    URL: https://assessed-arbor-enhanced-pdf.trycloudflare.com
    URL sudah disalin ke clipboard - tinggal Ctrl+V di Admin Panel.
==> Verifikasi endpoint publik
    GET https://assessed-arbor-enhanced-pdf.trycloudflare.com/v1/models -> 200
```

Catat URL-nya (di baris `URL: ...`). Baris verifikasi boleh `Belum 200` pada
percobaan pertama; tunnel kadang butuh beberapa detik tambahan. Yang penting
langkah 3 dan 4 berhasil.

> Jendela PowerShell boleh ditutup setelah ini. Tunnel berjalan di proses terpisah
> dan **tidak** ikut mati. Yang mematikan tunnel hanya shutdown/restart atau
> `Stop-Process` (lihat bagian akhir).

---

## Langkah 3 - Tempel URL di Admin Panel

1. Buka BLEA, masuk sebagai admin.
2. Buka **Admin Panel**.
3. Pilih menu **Integrasi & AI -> API Key -> Provider & API Key**.
4. Cari baris provider **ollama** (label `Ollama Laptop (tunnel)`).
5. Di kolom **Base URL**, tekan `Ctrl+V` (URL sudah ada di clipboard dari langkah 2).
6. Klik **Simpan** pada baris itu.

Aturan pengisian Base URL:

- Harus dimulai `https://`.
- **Tanpa** `/v1` di belakang dan **tanpa** garis miring penutup.
  Benar: `https://assessed-arbor-enhanced-pdf.trycloudflare.com`
  Salah: `https://assessed-arbor-enhanced-pdf.trycloudflare.com/`
  Salah: `https://assessed-arbor-enhanced-pdf.trycloudflare.com/v1`
- Kolom **API key** tidak perlu diubah; isinya tetap `ollama-local`.

Kalau URL terlanjur tertinggal dari sesi sebelumnya, jangan pakai yang lama - URL
quick tunnel lama sudah mati dan akan menghasilkan error 530.

---

## Langkah 4 - Uji di Chat

1. Buka halaman **Chat**.
2. Pilih model **`huihui_ai/qwen2.5-abliterate:3b`** di daftar model.
3. Kirim satu pesan pendek, misalnya `halo`.

Balasan pertama biasanya muncul dalam 10-60 detik di laptop 8 GB. Model lokal
memang lambat (sekitar 2-3 token per detik); itu normal, bukan tanda rusak.

Uji tanpa membuka browser (opsional):

```powershell
curl.exe -s -o NUL -w "%{http_code}" https://URL-ANDA.trycloudflare.com/v1/models
```

Harus mencetak `200`. Kalau `000`, `502`, atau `530`, tunnel-nya mati - ulangi
langkah 2.

---

## Yang berubah dan yang tidak

| Hal | Berubah setiap restart? |
|-----|--------------------------|
| URL `trycloudflare.com` | **Ya** - selalu tempel ulang di Admin Panel |
| API key `ollama-local` | Tidak |
| Model 3B di Katalog Model | Tidak |
| Kode BLEA di Cloudflare | Tidak (hanya berubah kalau `npm run deploy`) |

Artinya rutinitas harian Anda cukup: **langkah 2 lalu langkah 3**.

---

## Kalau ada masalah

| Gejala | Penyebab | Solusi |
|--------|----------|--------|
| `Ollama tidak menjawab di port 11434` | Ollama belum jalan | Nyalakan Ollama, atau `ollama serve` |
| `cloudflared tidak ditemukan` | Belum terpasang | `winget install --id Cloudflare.cloudflared` |
| `ParserError` / `Missing closing '}'` | Skrip versi lama atau encoding rusak | `cd C:\blea-ai; git pull` lalu ulangi |
| `403` saat cek `/v1/models` | Skrip lama tanpa `--http-host-header` | `git pull` lalu ulangi |
| `502`, `530`, atau `000` | Tunnel mati atau URL sudah basi | Ulangi langkah 2, tempel URL baru |
| Chat: `Tidak dapat terhubung ke provider "ollama"` | `base_url` di Admin Panel salah/basi | Ulangi langkah 3 |
| Chat: balasan datang dari model lain (bukan lokal) | Fallback otomatis aktif karena tunnel mati | Hidupkan tunnel, tempel URL, ulangi |
| Model tidak muncul di daftar Chat | Model dinonaktifkan di Katalog Model | Admin Panel -> API Key -> **Katalog Model**, aktifkan model |

Kalau laptop dimatikan di tengah pemakaian, Chat BLEA tidak error total: provider
yang tidak bisa dihubungi akan otomatis dialihkan ke model cloud (lihat PR #138).
Model lokal hanya tersedia selama laptop menyala dan tunnel berjalan.

---

## Mematikan tunnel

Cari PID-nya (skrip mencetak `Tunnel aktif (PID ....)`), lalu:

```powershell
Stop-Process -Id PID-YANG-TERTERA
```

Atau matikan semua proses cloudflared sekaligus:

```powershell
Get-Process cloudflared | Stop-Process
```

Mematikan tunnel membuat model lokal tidak bisa dipakai sampai langkah 2 dijalankan
lagi. Setelah itu URL baru, jadi langkah 3 juga perlu diulang.

---

## Catatan keamanan

Siapa pun yang tahu URL `trycloudflare.com` Anda bisa memakai Ollama di laptop Anda
selama tunnel hidup. Karena itu:

- jangan membagikan URL tersebut;
- matikan tunnel (`Stop-Process`) saat laptop ditinggal lama;
- endpoint ini hanya meneruskan ke Ollama di `127.0.0.1`, jadi isi disk Anda tidak
  terbuka - tetapi kuota CPU/RAM laptop tetap terpakai oleh permintaan orang lain.

Kalau URL yang berubah-ubah mulai mengganggu, versi nama tetap (tanpa menempel ulang)
dijelaskan di `docs/ollama-named-tunnel.md` - syaratnya punya domain di Cloudflare.
