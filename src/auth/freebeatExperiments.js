// One navigable workspace per experiment. Entries describe the existing tools;
// they do not enable provider models or authorize uploads/paid generations.
export const FREEBEAT_EXPERIMENTS = Object.freeze([
  { id: 'image-models', category: 'Gambar', title: 'Model & skema gambar', description: 'Katalog gambar/edit, informasi model, dan struktur tool.', access: 'Baca saja' },
  { id: 'image-edit', category: 'Gambar', title: 'Probe edit & hosting gambar', description: 'Periksa variasi quote edit dan upload_image dengan persetujuan terpisah.', access: 'Upload & uji berbayar' },
  { id: 'image-generation', category: 'Gambar', title: 'Generasi gambar', description: 'Quote, persetujuan satu kali, dan catatan uji gambar admin.', access: 'Uji berbayar' },
  { id: 'image-job', category: 'Gambar', title: 'Status job gambar', description: 'Periksa status, tagihan, dan kegagalan job yang sudah ada.', access: 'Baca saja' },
  { id: 'video', category: 'Video', title: 'Model & generasi video', description: 'Katalog video, parameter model, quote, dan uji dengan persetujuan.', access: 'Uji berbayar' },
  { id: 'hailuo', category: 'Video', title: 'Hailuo 2.3 Pro · #106', description: 'Informasi dan quote preset 10 detik/768p, tanpa membuat video.', access: 'Baca saja' },
  { id: 'dance', category: 'Video', title: 'Dance Video', description: 'Uji video dance dari lagu dan foto karakter.', access: 'Uji berbayar' },
  { id: 'singing', category: 'Video', title: 'Singing Video', description: 'Uji video bernyanyi dari foto penyanyi dan audio.', access: 'Uji berbayar' },
  { id: 'lip-sync', category: 'Video', title: 'Lip-Sync Video', description: 'Uji sinkronisasi bibir pada video sumber dengan audio.', access: 'Uji berbayar' },
  { id: 'music', category: 'Musik', title: 'Generasi musik', description: 'Model musik, quote, persetujuan, dan hasil uji audio.', access: 'Uji berbayar' },
  { id: 'vocal-schemas', category: 'Inspeksi MCP', title: 'Skema Singing & Lip-Sync', description: 'Periksa struktur tool vokal dan pendukungnya.', access: 'Baca saja' },
  { id: 'remaining-schemas', category: 'Inspeksi MCP', title: 'Skema tool lainnya', description: 'Inspeksi struktur tujuh tool tambahan Freebeat.', access: 'Baca saja' },
  { id: 'catalog', category: 'Inspeksi MCP', title: 'Katalog musik, efek & teks', description: 'Periksa katalog tanpa menjalankan generasi.', access: 'Baca saja' },
  { id: 'remaining-quotes', category: 'Inspeksi MCP', title: 'Probe quote tool tambahan', description: 'Periksa bentuk parameter dan estimasi biaya tool tambahan.', access: 'Baca saja' },
]);
export const FREEBEAT_EXPERIMENT_CATEGORIES = Object.freeze(['Gambar', 'Video', 'Musik', 'Inspeksi MCP']);
export const freebeatExperimentPath = (id) => `/admin/freebeat/${id}`;
