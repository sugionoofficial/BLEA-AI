import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPlanNeedsConfirmation, parseBrowserPlan } from '../src/agent/browserPlan.js';

test('planner accepts bounded supported actions and JSON code fences', () => {
  assert.deepEqual(parseBrowserPlan('```json\n{"action":"click","label":"Lihat hasil"}\n```'), { action: 'click', label: 'Lihat hasil' });
  assert.equal(parseBrowserPlan('{"action":"scroll","amount":5000}').amount, 700);
  assert.equal(parseBrowserPlan('{"action":"navigate","url":"https://example.com/a"}').url, 'https://example.com/a');
});

test('planner rejects destructive, private-network, credential, and unsupported actions', () => {
  assert.throws(() => parseBrowserPlan('{"action":"click","label":"Hapus akun"}'), /diblokir/);
  assert.throws(() => parseBrowserPlan('{"action":"navigate","url":"http://127.0.0.1/admin"}'), /HTTP/);
  assert.throws(() => parseBrowserPlan('{"action":"navigate","url":"javascript:alert(1)"}'), /URL|HTTP/);
  assert.throws(() => parseBrowserPlan('{"action":"fill","label":"Password","value":"abc"}'), /kredensial/);
  assert.throws(() => parseBrowserPlan('{"action":"shell","cmd":"rm -rf /"}'), /tidak dikenal/);
});

test('send/submit requires an explicit user confirmation', () => {
  assert.equal(browserPlanNeedsConfirmation({ action: 'click', label: 'Kirim pesan' }), true);
  assert.equal(browserPlanNeedsConfirmation({ action: 'click', label: 'Buka profil' }), false);
});
