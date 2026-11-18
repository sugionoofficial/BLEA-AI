# Freebeat MCP: uji koneksi admin

`/admin/freebeat` hanya tersedia untuk admin dan hanya menawarkan OAuth serta `get_credit_balance`. Tidak ada endpoint generasi atau pembelian yang diaktifkan. Backend memeriksa role admin pada setiap permintaan, menggunakan pendaftaran OAuth dinamis, PKCE S256, `freebeat:read`, dan state yang terikat ke browser. Endpoint resmi: `https://freebeat.ai/api/mcp`.

Worker memerlukan `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` yang sudah digunakan fitur Gmail. Jangan ganti kunci yang ada. Callback default: `https://blea-ai.blea-ai.workers.dev/api/freebeat/callback`. Opsional `FREEBEAT_OAUTH_REDIRECT_URI` dapat mengatur domain HTTPS lain dengan path yang sama; buka aplikasi dari origin tersebut agar cookie OAuth tersedia pada callback.

Token akses untuk pengujian dienkripsi AES-GCM ke cookie HttpOnly, Secure, SameSite=Lax, terikat ID admin, dan digunakan hanya setelah verifikasi admin. Tidak ada token refresh yang disimpan. Sesi berlaku paling lama satu jam (atau masa token yang lebih pendek); hubungkan ulang setelah kedaluwarsa. Setiap admin/browser punya sesi sendiri, belum ada akun provider bersama untuk pengguna. Tombol Putuskan menghapus cookie dan mencoba mencabut token; jika gagal, cabut akses di Freebeat. Perubahan kunci enkripsi juga mengakhiri sesi ini dan akan memengaruhi fitur Gmail yang memakai kunci yang sama.

Koneksi, saldo, cakupan OAuth, dan ketersediaan pada akun/plan belum diuji pada Freebeat live. Tidak ada bypass pembatasan plan atau kredit. Penggunaan kredit Freebeat gratis bersifat nonkomersial menurut ketentuan Freebeat; akses untuk pengguna BLEA dan penggunaan komersial memerlukan pengecekan izin terpisah. Sistem kredit BLEA tidak terhubung ke Freebeat, dan pembelian tetap nonaktif.

Unit/integration tests: `node --test tests/freebeat-mcp.test.js`; pengujian menggunakan respons upstream tiruan, bukan akun Freebeat asli.

## Diagnosis koneksi

Pada tahap registrasi atau pertukaran token, pesan menyertakan kode tetap yang aman untuk dibagikan: `FB-REGISTER-NETWORK`/`FB-TOKEN-NETWORK` berarti permintaan gagal sebelum menerima respons; `TIMEOUT` berarti batas waktu terlampaui; `HTTP` berarti Freebeat memberi respons penolakan; `RESPONSE` berarti respons JSON tidak valid; `REDIRECT` berarti pengalihan ditolak demi keamanan. Status HTTP registrasi dicantumkan jika tersedia. Detail mentah kesalahan, kode OAuth dan token tidak ditampilkan atau dicatat. Pengalihan 307/308 hanya diikuti sekali ke endpoint yang sama pada origin Freebeat yang sama, termasuk variasi garis miring akhir; semua pengalihan lain ditolak.

Jika registrasi mengembalikan HTTP 400 dengan kode kesalahan OAuth standar, halaman menampilkan kode yang termasuk daftar aman seperti `invalid_redirect_uri` atau `invalid_client_metadata`. Jika penyedia menyebut loopback pada penolakan redirect, halaman menampilkan petunjuk tetap tanpa menyalin deskripsi mentah. Isi respons penyedia, token, kode otorisasi, dan detail lain tidak ditampilkan atau dicatat. Respons kesalahan dibatasi 16 KiB.
