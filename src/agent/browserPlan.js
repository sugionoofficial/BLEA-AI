import { isPrivateHost } from './tools.js';

const BLOCKED_CLICK = /\b(pay|bayar|purchase|buy|delete|hapus|transfer|checkout|order|refund|remove)\b/i;
const SENSITIVE_FIELD = /\b(password|passcode|otp|one.?time|credit.?card|payment|token|secret|cvv|cvc)\b/i;
const CONFIRM_CLICK = /\b(submit|kirim|send|publish|post)\b/i;

export function parseBrowserPlan(reply) {
  const raw = String(reply || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let plan;
  try { plan = JSON.parse(raw); } catch { throw new Error('Model tidak mengembalikan JSON aksi browser yang valid. Task dihentikan agar tidak menebak tindakan.'); }
  if (!plan || !['done', 'navigate', 'click', 'fill', 'scroll'].includes(plan.action)) throw new Error('Jenis aksi dari model tidak dikenal; task dihentikan.');
  if (plan.action === 'navigate') {
    let url;
    try { url = new URL(String(plan.url || '')); } catch { throw new Error('Model mengusulkan URL yang tidak valid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateHost(url.hostname)) throw new Error('Navigasi hanya diizinkan ke URL HTTP(S) publik tanpa kredensial.');
    plan.url = url.href;
  }
  if (plan.action === 'click') {
    if (!String(plan.label || '').trim() || String(plan.label).length > 160) throw new Error('Label kontrol tidak valid.');
    if (BLOCKED_CLICK.test(plan.label)) throw new Error('Aksi pembayaran atau penghapusan diblokir oleh kebijakan browser agent.');
  }
  if (plan.action === 'fill') {
    if (!String(plan.label || '').trim() || String(plan.label).length > 180 || String(plan.value ?? '').length > 4000) throw new Error('Data kolom tidak valid.');
    if (SENSITIVE_FIELD.test(plan.label)) throw new Error('Kolom kredensial, OTP, atau pembayaran tidak dapat diisi oleh browser agent.');
  }
  if (plan.action === 'scroll') plan.amount = Math.max(-700, Math.min(700, Number(plan.amount) || 0));
  return plan;
}

export function browserPlanNeedsConfirmation(plan) {
  return plan?.action === 'click' && CONFIRM_CLICK.test(String(plan.label || ''));
}
