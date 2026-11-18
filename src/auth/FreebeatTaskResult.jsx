import { ExternalLink } from 'lucide-react';

// Links come from the server's HTTPS-only filter. Do not fetch or embed them:
// opening one is an explicit user action and may contact a third-party host.
export function FreebeatTaskResult({ task }) {
  return <div className="freebeat-task-result">
    <p>Status tugas: {task.status}. Biaya/refund yang tidak dilaporkan adalah tidak diketahui.</p>
    <pre>{JSON.stringify(task.billing, null, 2)}</pre>
    {task.images.length > 0 && <>
      <p>Tekan tombol berikut untuk membuka hasil gambar di tab baru:</p>
      <div className="freebeat-result-links">{task.images.map((image, index) => <a className="freebeat-result-link" key={image} href={image} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Buka hasil gambar {index + 1}</a>)}</div>
      <p>Membuka tautan menghubungkan browser Anda ke host gambar penyedia. Jangan bagikan tautan pribadi ini.</p>
    </>}
    {task.status === 'completed' && task.images.length === 0 && <p className="freebeat-alert">Freebeat melaporkan tugas selesai, tetapi belum ada tautan gambar yang dapat ditampilkan. Periksa status lagi atau lihat hasil pada akun Freebeat; jangan mengirim generasi ulang.</p>}
  </div>;
}
