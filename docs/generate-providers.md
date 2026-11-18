# Generate: gambar dan video multi-provider

Halaman `/generate` memisahkan pilihan **Generate gambar** dan **Generate video**. Integrasi setiap provider harus dibuat dan diverifikasi secara terpisah; label atau model di katalog tidak otomatis membuktikan kemampuan API provider.

## Gambar

Saat ini hanya uji Freebeat milik admin yang dihubungkan ke halaman Generate. Hubungkan OAuth dengan izin gambar di `/admin/freebeat`; di halaman Generate admin dapat memilih model live, memasukkan prompt, menyiapkan quote, lalu secara terpisah menyetujui satu permintaan dengan batas `max_credits` sebesar quote. Server tetap memakai receipt terikat sesi, quote ulang, tabel deduplikasi, dan penguncian hasil tidak pasti seperti dijelaskan di `freebeat-mcp.md`. Jangan mengirim ulang permintaan yang hasilnya tidak pasti. Uji ini menggunakan kredit akun Freebeat admin dan bukan pembelian atau pemotongan kredit BLEA.

Pengguna biasa belum dapat memakai generasi gambar. Akun Freebeat bersama, persetujuan penggunaan untuk pengguna lain/komersial, pengeluaran kredit BLEA, dan riwayat gambar pengguna belum diimplementasikan. Daftar adapter gambar pada `GenerateImagePanel.jsx` hanya berisi adapter yang sudah diimplementasikan dan dapat diperluas setelah provider berikutnya aman dan siap; jangan menambah nama provider sebagai janji kemampuan tanpa adapter dan pengujian.

## Video

Halaman menampilkan hanya model video yang ditandai aktif di Admin Panel dan memiliki provider dengan kredensial serta base URL yang dapat digunakan. Jika belum ada, daftar kosong dan tombol generate dinonaktifkan; tidak memakai fallback model atau provider. Provider lain dapat memakai jalur video yang sudah ada sesuai protokol provider yang didukung. Input media untuk jalur lama diunggah ke bucket publik sehingga dapat diakses melalui URL; tampilkan dan pahami peringatan sebelum mengunggah. Periksa kompatibilitas masing-masing provider sebelum produksi.

UnoRouter tidak lagi ditampilkan di katalog video dan `/api/video/models` tidak meminta katalog UnoRouter. `/api/video/generate` menolak provider tersebut atau provider kosong; ini tidak menghapus kredensial atau pengaturan UnoRouter dari fitur Chat/Admin, dan tidak menghapus riwayat video lama. Riwayat lama tetap dapat dipantau/diakses melalui mekanisme sebelumnya. Provider tanpa base URL valid tidak boleh jatuh diam-diam ke URL provider lain.

**Batasan penting:** jalur video lama belum menegakkan saldo/debit kredit BLEA, idempotensi tagihan, atau quote Freebeat. Pemanggilan melalui provider lama dapat memakai saldo provider; angka harga historis pada katalog bukan konfirmasi biaya. Pembelian kredit BLEA tetap nonaktif. Freebeat image-to-video belum dihubungkan ke `/generate`; bagian admin menyediakan uji Wan 3.0 terpisah dengan quote, persetujuan per pengiriman dan penanganan hasil tidak pasti; hal ini bukan generasi untuk pengguna biasa dan belum diuji live. Penggunaan untuk pengguna lain juga memerlukan izin Freebeat sesuai ketentuan penyedia.
