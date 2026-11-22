# Named tunnel permanen untuk Ollama (URL tetap + auto-start)

Dokumen ini adalah lanjutan dari [`ollama-tunnel.md`](./ollama-tunnel.md). Bagian
tersebut memakai **quick tunnel** yang URL-nya berubah setiap `cloudflared` dijalankan
ulang. Panduan ini menggantinya dengan **named tunnel**: satu URL tetap milik Anda
(mis. `https://ollama.contoh.com`) yang berjalan sebagai service Windows dan hidup
otomatis setiap komputer menyala.

Hasil akhir:

```
Worker BLEA → https://ollama.contoh.com → cloudflared (service) → Ollama 127.0.0.1:11434
```

Tidak ada lagi langkah "jalankan tunnel, salin URL, perbarui Base URL di Admin Panel".

> Tanpa domain? Rutinitas quick tunnel yang harus diulang setiap laptop menyala ada di
> [`ollama-restart.md`](./ollama-restart.md).

## Prasyarat

1. **Domain yang DNS-nya dikelola Cloudflare** (nameserver domain sudah diarahkan ke
   Cloudflare). Ini wajib untuk named tunnel, karena Cloudflare perlu membuat record CNAME
   atas nama Anda. Domain murah `.my.id`/`.xyz` cukup; paket gratis Cloudflare bisa dipakai.
2. `cloudflared` sudah terpasang (`winget install --id Cloudflare.cloudflared`).
3. Ollama berjalan normal di `http://127.0.0.1:11434` dan model sudah di-pull.

Cek prasyarat:

```powershell
cloudflared --version
curl.exe -s http://127.0.0.1:11434/api/tags
```

## Langkah 1 — Login & buat tunnel

```powershell
cloudflared tunnel login
```

Browser terbuka → pilih zone/domain Anda → **Authorize**. File sertifikat tersimpan di
`C:\Users\<user>\.cloudflared\cert.pem`.

```powershell
cloudflared tunnel create blea-ollama
```

Output menampilkan **Tunnel ID** (UUID) dan lokasi kredensial:

```
Tunnel credentials written to C:\Users\lenovo\.cloudflared\3f1c9a44-....json
Created tunnel blea-ollama with id 3f1c9a44-...
```

Catat UUID itu. Cek daftar tunnel:

```powershell
cloudflared tunnel list
```

## Langkah 2 — Tulis `config.yml`

Buat file `C:\Users\lenovo\.cloudflared\config.yml`:

```yaml
tunnel: blea-ollama
credentials-file: C:\Users\lenovo\.cloudflared\3f1c9a44-....json

ingress:
  - hostname: ollama.contoh.com
    service: http://127.0.0.1:11434
    originRequest:
      # Ollama menolak (403) permintaan dengan Host non-lokal. Baris ini wajib.
      httpHostHeader: 127.0.0.1:11434
      connectTimeout: 30s
      # Chat bisa lama (CPU lokal); jangan putus terlalu cepat.
      noTLSVerify: false
  - service: http_status:404
```

Ganti `3f1c9a44-....json` dengan nama file kredensial Anda dan `ollama.contoh.com` dengan
subdomain pilihan. **Baris terakhir `http_status:404` wajib ada** — tanpa catch-all,
cloudflared menolak start.

## Langkah 3 — Arahkan DNS

```powershell
cloudflared tunnel route dns blea-ollama ollama.contoh.com
```

Perintah ini membuat CNAME `ollama.contoh.com` → `<UUID>.cfargotunnel.com` (proxied).
Cek:

```powershell
Resolve-DnsName ollama.contoh.com
```

## Langkah 4 — Uji dulu di foreground

Sebelum dipasang sebagai service, pastikan konfigurasinya benar:

```powershell
cloudflared tunnel run blea-ollama
```

Di jendela lain:

```powershell
curl.exe -sS -i https://ollama.contoh.com/v1/models
```

Target: `HTTP/2 200` dan body berisi daftar model (mis. `huihui_ai/qwen2.5-abliterate:3b`).
Kalau 403 → `httpHostHeader` belum terbaca (cek indentasi YAML). Kalau 502/1033 → Ollama
tidak jalan atau port salah.

Setelah 200, hentikan dengan `Ctrl+C` dan lanjut ke service.

## Langkah 5 — Pasang sebagai service Windows

Jalankan **PowerShell sebagai Administrator**.

```powershell
cloudflared service install
```

Service berjalan sebagai `LocalSystem`, dan **di sinilah jebakan paling umum**: ia tidak
membaca `C:\Users\lenovo\.cloudflared\`, melainkan folder profil sistem:

```
C:\Windows\System32\config\systemprofile\.cloudflared\
```

Salin konfigurasi dan kredensial ke sana (PowerShell Administrator):

```powershell
$dst = "C:\Windows\System32\config\systemprofile\.cloudflared"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$env:USERPROFILE\.cloudflared\config.yml" $dst -Force
Copy-Item "$env:USERPROFILE\.cloudflared\*.json" $dst -Force
```

Sesuaikan `credentials-file` di file tujuan agar menunjuk path sistem, mis.:

```yaml
credentials-file: C:\Windows\System32\config\systemprofile\.cloudflared\3f1c9a44-....json
```

Lalu:

```powershell
Restart-Service cloudflared
Get-Service cloudflared
```

Status harus `Running`. Kalau `Stopped`, baca log di **Event Viewer → Windows Logs →
Application** (sumber: `cloudflared`) — biasanya "config not found" atau kredensial tidak
terbaca.

> Alternatif tanpa hak Administrator: buat Task Scheduler "At log on" yang menjalankan
> `cloudflared tunnel run blea-ollama` dengan opsi *Run whether user is logged on or not*.
> Cara ini membaca config user biasa, tapi tidak hidup sebelum user login.

## Langkah 6 — Verifikasi URL tetap

Ini inti dari kenapa kita repot: URL harus sama setelah reboot.

```powershell
Restart-Computer
```

Setelah Windows menyala lagi (tanpa membuka terminal apa pun):

```powershell
Get-Service cloudflared
curl.exe -sS -i https://ollama.contoh.com/v1/models
```

Yang diharapkan: service `Running` dan endpoint mengembalikan `200` dengan daftar model —
**tanpa** menjalankan `cloudflared tunnel ...` secara manual.

Perintah diagnostik lain:

```powershell
cloudflared tunnel info blea-ollama     # status koneksi & lokasi edge
cloudflared tunnel list                 # daftar tunnel + konektor
```

Kalau `tunnel info` menampilkan 0 koneksi, service hidup tapi tidak tersambung ke
Cloudflare — cek log Event Viewer dan koneksi internet.

## Langkah 7 — Arahkan BLEA ke URL tetap

Karena URL sekarang permanen, cukup sekali:

- Admin Panel → **API Key** → baris **Ollama (self-host)** → Base URL:
  `https://ollama.contoh.com` → simpan.
- Atau lewat SQL:

  ```sql
  update public.provider_api_keys
     set base_url = 'https://ollama.contoh.com',
         updated_at = now()
   where provider = 'ollama';
  ```

Verifikasi dari Worker:

```powershell
curl.exe -s https://blea-ai.blea-ai.workers.dev/api/status
curl.exe -s https://blea-ai.blea-ai.workers.dev/api/enabled-models
```

`providers` harus memuat `ollama`, dan model Ollama muncul di daftar.

## Keamanan: URL tetap berarti URL yang bisa ditebak

Quick tunnel memberi keuntungan obscurity karena URL acak. Dengan named tunnel, alamatnya
bisa diketahui siapa pun (`ollama.domainanda.com`), dan API Ollama tidak punya autentikasi.
Pilih salah satu:

1. **WAF rule (tanpa kode).** Worker BLEA selalu mengirim header
   `X-Title: BLEA AI`. Di Cloudflare Dashboard → Security → WAF → Custom rules, buat rule
   *Block* dengan ekspresi:

   ```
   http.host eq "ollama.contoh.com" and not any(http.request.headers["x-title"][*] == "BLEA AI")
   ```

   Ini menyaring pemindai otomatis, tapi bukan autentikasi sejati (header bisa dipalsukan).

2. **Reverse proxy ber-token (lebih nyata).** Jalankan Caddy di Windows sebagai gerbang:

   ```
   :11435 {
     @ok header Authorization "Bearer ollama-local"
     handle @ok {
       reverse_proxy 127.0.0.1:11434 {
         header_up Host 127.0.0.1:11434
       }
     }
     respond 401
   }
   ```

   Lalu `service: http://127.0.0.1:11435` di `config.yml` (dan hapus `httpHostHeader`
   karena Caddy sudah menulisnya). Token yang sama dipakai sebagai API key provider di BLEA.

3. **Cloudflare Access** hanya berguna kalau klien bisa mengirim header service token.
   Worker saat ini tidak mengirimkannya, jadi opsi ini butuh perubahan kode di
   `sendChatCompletionRequest`.

Apa pun pilihannya: **jangan** buka port 11434 ke internet dan jangan pasang
`OLLAMA_HOST=0.0.0.0`.

## Troubleshooting

| Gejala | Penyebab | Solusi |
| --- | --- | --- |
| Service `Stopped` setelah `service install` | Config tidak ada di profil sistem | Salin `config.yml` + `*.json` ke `C:\Windows\System32\config\systemprofile\.cloudflared\` |
| `cloudflared tunnel run` langsung exit | Tidak ada catch-all `http_status:404` | Tambahkan ingress terakhir |
| `403 Forbidden` (body kosong) | Ollama menolak Host non-lokal | Pastikan `httpHostHeader: 127.0.0.1:11434` |
| `502` / Error 1033 | Service tidak tersambung atau Ollama mati | `cloudflared tunnel info blea-ollama`, cek `curl http://127.0.0.1:11434/api/tags` |
| DNS belum resolve | Propagasi record | Tunggu 1–5 menit, cek `Resolve-DnsName`, pastikan zone aktif di Cloudflare |
| URL berubah sendiri | Masih memakai quick tunnel | Pastikan `config.yml` dan service memakai tunnel `blea-ollama` |
| Service jalan tapi BLEA 502 | `base_url` di DB salah/berisi `/v1` ganda | Isi `https://ollama.contoh.com` saja; Worker menormalkan `/v1` |

## Linux (ringkas)

Untuk server Linux, pengganti langkah 5 adalah systemd:

```bash
cloudflared tunnel login
cloudflared tunnel create blea-ollama
cloudflared tunnel route dns blea-ollama ollama.contoh.com
sudo cloudflared service install     # membaca /etc/cloudflared/config.yml
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

Config berada di `/etc/cloudflared/config.yml` dengan `credentials-file:
/home/<user>/.cloudflared/<UUID>.json`, isi ingress sama seperti di atas.

## Checklist akhir

- [ ] `cloudflared tunnel list` menampilkan `blea-ollama`
- [ ] `https://ollama.<domain>/v1/models` → `200` + daftar model
- [ ] `Get-Service cloudflared` → `Running`
- [ ] Setelah reboot, endpoint tetap `200` tanpa perintah manual
- [ ] `provider_api_keys.base_url` = `https://ollama.<domain>`
- [ ] `GET /api/status` Worker memuat `ollama`
- [ ] Aturan keamanan (WAF/gateway) aktif, port 11434 tidak terbuka ke internet
