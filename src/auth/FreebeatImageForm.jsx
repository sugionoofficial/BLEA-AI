// Both quote actions are read-only; the separate paid action remains behind its own confirmation.
export function prepareBlockers({ loading, connected, imageAccess, busy, imageBusy, testBusy, model, prompt }) {
  const reasons = [];
  if (loading) reasons.push('Menunggu pemeriksaan koneksi Freebeat.');
  else if (!connected) reasons.push('Sesi Freebeat belum terhubung atau sudah berakhir. Tekan Hubungkan izin gambar di atas.');
  else if (!imageAccess) reasons.push('Izin gambar belum tersedia. Tekan Hubungkan izin gambar di atas dan setujui izin di Freebeat.');
  if (busy || imageBusy || testBusy) reasons.push('Tunggu pemeriksaan yang sedang berjalan.');
  if (!model) reasons.push('Isi ID model gambar, misalnya 80.');
  else if (!/^\d+$/.test(model) || !Number.isSafeInteger(Number(model))) reasons.push('ID model harus berupa bilangan bulat nonnegatif.');
  if (!prompt.trim()) reasons.push('Isi prompt percobaan.');
  else if (prompt.trim().length > 2000) reasons.push('Prompt maksimal 2000 karakter.');
  return reasons;
}

export function FreebeatImageForm({ loading, connected, imageAccess, busy, imageBusy, testBusy, model, prompt, onModelChange, onPromptChange, onInspect, onPrepare }) {
  const blockers = prepareBlockers({ loading, connected, imageAccess, busy, imageBusy, testBusy, model, prompt });
  return <form onSubmit={onInspect}>
    <label className="freebeat-field">ID model gambar (angka dari daftar model)
      <input type="number" min="0" step="1" required value={model} onChange={(event) => onModelChange(event.target.value)} />
    </label>
    <label className="freebeat-field">Prompt percobaan (dikirim ke Freebeat untuk quote)
      <input type="text" maxLength={2000} required value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
    </label>
    <div className="freebeat-actions">
      <button type="submit" className="is-secondary" disabled={loading || !connected || busy || imageBusy || testBusy}>Periksa respons quote</button>
      <button type="button" disabled={blockers.length > 0} aria-describedby="freebeat-prepare-help" onClick={onPrepare}>Siapkan quote untuk persetujuan</button>
    </div>
    <div id="freebeat-prepare-help" className="freebeat-prepare-help" aria-live="polite">
      {blockers.length ? <><strong>Untuk mengaktifkan persiapan quote:</strong><ul>{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul></> : <span>Siap memeriksa quote. Langkah ini tidak membuat gambar atau memakai kredit.</span>}
    </div>
  </form>;
}
