import { useEffect, useMemo, useState } from 'react';

// Kontrol "tampilkan 50 / 100 / semua" + pager untuk daftar panjang,
// dipakai bersama oleh halaman Kredit, History, dan Riwayat Kredit.
export const PER_PAGE = [50, 100, 'all'];

export function usePagedList(items) {
  const [perPage, setPerPage] = useState(50);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [perPage, items.length]);
  const size = perPage === 'all' ? Math.max(items.length, 1) : perPage;
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pageCount);
  const slice = useMemo(
    () => (perPage === 'all' ? items : items.slice((current - 1) * size, current * size)),
    [items, perPage, current, size],
  );
  return { perPage, setPerPage, page: current, setPage, pageCount, slice, total: items.length };
}

export function PerPageSelect({ value, onChange, id }) {
  return (
    <label className="page-size" htmlFor={id}>
      Tampilkan
      <select id={id} value={value === 'all' ? 'all' : String(value)} onChange={(event) => onChange(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
        <option value="50">50</option>
        <option value="100">100</option>
        <option value="all">Semua</option>
      </select>
      <span className="page-size-suffix">item</span>
    </label>
  );
}

export function Pager({ page, pageCount, total, onPage }) {
  if (pageCount <= 1) return null;
  return (
    <div className="page-pager" role="navigation" aria-label="Navigasi halaman">
      <button type="button" className="credits-secondary" onClick={() => onPage(page - 1)} disabled={page <= 1}>Sebelumnya</button>
      <span>Halaman <b>{page}</b> dari {pageCount} · {total.toLocaleString('id-ID')} item</span>
      <button type="button" className="credits-secondary" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>Berikutnya</button>
    </div>
  );
}
