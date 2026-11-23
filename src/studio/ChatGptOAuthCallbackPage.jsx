import { ChatGptOAuthPanel } from './ChatGptOAuthPanel';
import './chatgpt-accounts.css';

/**
 * Halaman callback OAuth ChatGPT (`/auth/callback`).
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
export function ChatGptOAuthCallbackPage() {
  return (
    <div className="chatgpt-accounts">
      <ChatGptOAuthPanel />
    </div>
  );
}

export default ChatGptOAuthCallbackPage;
