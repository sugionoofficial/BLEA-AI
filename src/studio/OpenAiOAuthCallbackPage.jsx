import { OpenAiOAuthPanel } from './OpenAiOAuthPanel';
import './openai-accounts.css';

/**
 * Halaman callback OAuth OpenAI (`/auth/callback`).
 *
 * Kenapa perlu halaman sendiri: OpenAI mewajibkan redirect_uri loopback
 * `http://127.0.0.1:<port>/auth/callback`. Kalau BLEA dibuka dari 127.0.0.1,
 * browser mendarat di sini dan login langsung diselesaikan. Kalau dibuka dari
 * domain publik, alamat ini tetap berguna sebagai tempat menempel URL callback.
 *
 * Catatan: server dev/preview hanya melayani path `/`; untuk menguji alur
 * loopback, jalankan `npm run dev` lalu buka lewat 127.0.0.1 agar fallback SPA
 * menyajikan halaman ini.
 */
export function OpenAiOAuthCallbackPage() {
  return (
    <div className="openai-accounts">
      <OpenAiOAuthPanel />
    </div>
  );
}

export default OpenAiOAuthCallbackPage;
