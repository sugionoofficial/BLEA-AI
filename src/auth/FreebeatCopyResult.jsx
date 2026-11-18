import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';

export function FreebeatCopyResult({ title, value, description }) {
  const [message, setMessage] = useState('');
  const field = useRef(null);
  const text = JSON.stringify(value, null, 2);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setMessage('Berhasil disalin.');
    } catch {
      field.current?.focus();
      field.current?.select();
      setMessage('Tidak dapat menyalin otomatis. Pilih dan salin teks di kotak secara manual.');
    }
  }

  return <div className="freebeat-result">
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    <div className="freebeat-actions"><button type="button" className="is-secondary" onClick={copy} aria-label={`Salin ${title}`}><Copy size={15} /> Salin</button></div>
    <p className="freebeat-copy-status" role="status" aria-live="polite">{message}</p>
    <textarea ref={field} className="freebeat-copy-text" aria-label={title} value={text} readOnly rows={12} spellCheck={false} />
  </div>;
}
