// Rute `/api/openai-signup/userscript` — unduh userscript pengisi email.
//
// Kenapa berkas terpisah (bukan hanya salin-tempel di panel):
//   1. Tampermonkey bisa memasang langsung dari URL `.user.js`, jadi pengguna
//      tidak perlu menyalin 2,5 KB skrip ke editor. Menyalin-tempel adalah
//      titik gagal yang sudah terbukti bikin fitur ini terasa "tidak bekerja".
//   2. Hasil unduhan bisa diperiksa: header `content-type: text/javascript`
//      dan isi yang deterministik untuk email yang sama.
//
// Isi skrip TIDAK memuat kredensial apa pun: hanya email TempMail aktif milik
// admin itu sendiri, yang memang sudah ditampilkan di halaman TempMail.

import { buildAutofillUserscript, validateSignupInput } from './openaiSignup.js';

export const USERSCRIPT_PATH = '/api/openai-signup/userscript';

/**
 * @param {string} email email TempMail aktif
 * @param {string} origin origin aplikasi (dipakai sebagai penanda sumber)
 */
export function buildUserscriptResponse(email, origin = '') {
  const { email: address } = validateSignupInput({ email });
  const body = buildAutofillUserscript(address, { origin });
  return new Response(body, {
    status: 200,
    headers: {
      // `text/javascript` + nama berkas `.user.js` membuat Tampermonkey
      // menawarkan dialog pemasangan, bukan menampilkan teks mentah.
      'content-type': 'text/javascript; charset=utf-8',
      'content-disposition': 'inline; filename="blea-openai-autofill.user.js"',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
