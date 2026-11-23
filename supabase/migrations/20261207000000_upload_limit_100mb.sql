-- Batas unggahan 100MB ditegakkan juga di level bucket, bukan hanya di klien.
--
-- Klien (src/lib/uploads.js) sudah menolak berkas > 100MB sebelum mengunggah,
-- tetapi klien bisa dimanipulasi. Tanpa batas di bucket, seseorang bisa
-- mengunggah berkas raksasa langsung ke Storage API dengan tokennya sendiri.
-- Batas ini membuat Storage yang menolak, bukan sekadar UI.
--
-- Tidak ada perubahan pada allowed_mime_types: daftar MIME terlalu rapuh untuk
-- dokumen (DOCX/XLSX/CSV punya varian yang tak terhitung) dan tujuan fitur ini
-- adalah mengizinkan banyak jenis berkas.

update storage.buckets
set file_size_limit = 104857600 -- 100 * 1024 * 1024
where id = 'ai-studio-uploads';
