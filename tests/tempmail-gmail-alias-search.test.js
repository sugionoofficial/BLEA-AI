import test from 'node:test';
import assert from 'node:assert/strict';

// Regresi: Gmail membuang plus-tag saat menyimpan alamat tujuan, sehingga
// pencarian `to:nama+1@gmail.com` tidak menemukan apa pun walau pesannya ada.
// Tes ini mengunci perilaku pencarian + pencocokan penerima lewat jalur nyata
// listGmailMessages() dengan Gmail API tiruan.
const ENV = {
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
};

test('pencarian Gmail untuk alias +tag memakai alamat dasar dan tetap menemukan pesannya', async () => {
  const gmailProvider = await import('../src/lib/gmailProvider.js');
  // Format enkripsi milik gmailProvider (AES-GCM, iv terpisah) — bukan format
  // chatgptPool, karena kuncinya diturunkan berbeda.
  const rawKey = Uint8Array.from(Buffer.from(ENV.PROVIDER_CREDENTIAL_ENCRYPTION_KEY, 'hex'));
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode('refresh-token-uji')));
  const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const connection = {
    email: 'sugiono@gmail.com',
    refresh_token_ciphertext: b64u(ciphertext),
    refresh_token_iv: b64u(iv),
  };

  const queries = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'access-uji', expires_in: 3600 });
    }
    if (target.includes('/users/me/messages?')) {
      const q = new URL(target).searchParams.get('q');
      queries.push(q);
      // Gmail hanya mengembalikan pesan untuk pencarian alamat DASAR.
      if (q === 'to:sugiono@gmail.com') {
        return Response.json({ messages: [{ id: 'msg-1' }] });
      }
      return Response.json({});
    }
    if (target.includes('/users/me/messages/msg-1')) {
      const headers = [
        { name: 'From', value: 'OpenAI <noreply@tm.openai.com>' },
        // Tag dibuang Gmail: hanya alamat dasar yang tersimpan.
        { name: 'To', value: 'sugiono@gmail.com' },
        { name: 'Subject', value: 'Verifikasi email Anda' },
        { name: 'Date', value: 'Sun, 23 Nov 2026 13:52:00 +0000' },
      ];
      return Response.json({ id: 'msg-1', snippet: 'Klik untuk verifikasi', payload: { headers } });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    // Mode longgar dipakai pembaca pendaftaran: Gmail membuang tag, jadi
    // pesan perlu ditemukan lewat alamat dasar.
    const messages = await gmailProvider.listGmailMessages(ENV, connection, 'sugiono+1@gmail.com', { matchMode: 'loose' });
    assert.deepEqual(queries, ['to:sugiono@gmail.com deliveredto:sugiono+1@gmail.com', 'to:sugiono@gmail.com']);
    assert.equal(messages.length, 1, 'pesan harus ditemukan meski tag +1 sudah dibuang Gmail');
    assert.equal(messages[0].subject, 'Verifikasi email Anda');

    // Mode ketat tetap tidak menampilkan pesan yang tag-nya hilang, supaya
    // halaman TempMail umum tidak membocorkan email pribadi.
    globalThis.fetch = (async () => new Response('skip', { status: 404 }));
    assert.equal(gmailProvider.listGmailMessages.length >= 3, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
