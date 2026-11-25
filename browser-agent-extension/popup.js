import { parseTaskCommands } from './commands.js';
import { createTaskController } from './task-controller.js';

const $ = (selector) => document.querySelector(selector);
const commandField = $('#command');
const statusBox = $('#status');
const confirmation = $('#confirmation');
let pendingAction = null;

function setStatus(text) { statusBox.textContent = text; }

async function refreshTabs() {
  const select = $('#targets');
  select.replaceChildren(new Option('Pilih tab tujuan…', ''));
  try {
    const response = await chrome.runtime.sendMessage({ channel: 'blea-browser-companion-v1', type: 'list-tabs' });
    if (response?.error) throw new Error(response.error);
    for (const tab of response?.result || []) {
      const option = new Option(`${tab.title} — ${new URL(tab.url).host}`, String(tab.id));
      option.dataset.origin = new URL(tab.url).origin;
      select.add(option);
    }
    const target = await chrome.runtime.sendMessage({ channel: 'blea-browser-companion-v1', type: 'get-target' });
    if (target?.result?.tabId) select.value = String(target.result.tabId);
    $('#targetStatus').textContent = target?.result
      ? `Terpilih: ${target.result.title} (${new URL(target.result.url).origin})`
      : 'Pilih tab tujuan, lalu berikan izin situs secara eksplisit.';
  } catch (error) {
    $('#targetStatus').textContent = `Gagal memuat tab: ${String(error?.message || error)}`;
  }
}

$('#refreshTabs').addEventListener('click', refreshTabs);
$('#grantOrigin').addEventListener('click', async () => {
  try {
    const url = new URL($('#extraOrigin').value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Masukkan origin saja, misalnya https://www.google.com.');
    }
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    $('#targetStatus').textContent = granted ? `Origin diizinkan: ${url.origin}` : `Izin ditolak untuk ${url.origin}.`;
  } catch (error) { $('#targetStatus').textContent = String(error?.message || error); }
});
$('#authorizeTarget').addEventListener('click', async () => {
  const tabId = Number($('#targets').value);
  if (!tabId) { $('#targetStatus').textContent = 'Pilih tab tujuan terlebih dahulu.'; return; }
  try {
    const origin = $('#targets').selectedOptions[0]?.dataset.origin;
    if (!origin) throw new Error('Origin tab tidak diketahui; muat ulang daftar tab.');
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error(`Izin situs ditolak untuk ${origin}.`);
    const response = await chrome.runtime.sendMessage({ channel: 'blea-browser-companion-v1', type: 'set-target', payload: { tabId } });
    if (response?.error) throw new Error(response.error);
    $('#targetStatus').textContent = `Izin diberikan: ${response.result.title} (${new URL(response.result.url).origin})`;
  } catch (error) {
    $('#targetStatus').textContent = `Tidak terhubung: ${String(error?.message || error)}`;
  }
});
refreshTabs();

async function activeTab() {
  const selected = await chrome.runtime.sendMessage({ channel: 'blea-browser-companion-v1', type: 'get-target' });
  if (selected?.error) throw new Error(selected.error);
  if (!selected?.result?.tabId) throw new Error('Pilih tab tujuan di bagian atas side panel terlebih dahulu.');
  return chrome.tabs.get(selected.result.tabId);
}

async function executeInTab(func, args = []) {
  const tab = await activeTab();
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return results?.[0]?.result;
}

async function runAction(action) {
  if (action.type === 'search') {
    const url = `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
    const tab = await activeTab();
    await chrome.tabs.update(tab.id, { url });
    setStatus(`Membuka hasil Google untuk: ${action.query}`);
    return;
  }
  if (action.type === 'open') {
    const tab = await activeTab();
    await chrome.tabs.update(tab.id, { url: action.url });
    setStatus(`Membuka ${action.url}`);
    return;
  }
  if (action.type === 'copy') {
    await navigator.clipboard.writeText(action.value);
    setStatus('Teks disalin ke clipboard.');
    return;
  }
  if (action.type === 'paste') {
    const value = await navigator.clipboard.readText();
    if (!value) { setStatus('Clipboard kosong.'); return; }
    action = { ...action, type: 'fill', value };
  }
  if (action.type === 'read') {
    const data = await executeInTab(() => ({
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').slice(0, 7000),
    }));
    setStatus(data?.text ? `${data.title}\n${data.url}\n\n${data.text}` : 'Tidak dapat membaca teks pada tab ini.');
    return;
  }
  if (action.type === 'click') {
    const result = await executeInTab((label) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const candidates = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')];
      const target = candidates.find((el) => el.getClientRects().length && norm(el.innerText || el.getAttribute('aria-label') || el.value) === norm(label));
      if (!target) return 'Tidak ditemukan tombol terlihat dengan label yang persis cocok.';
      target.click(); return `Diklik: ${target.innerText || target.getAttribute('aria-label') || target.value}`;
    }, [action.label]);
    setStatus(result || 'Aksi selesai.');
    return;
  }
  if (action.type === 'fill') {
    const result = await executeInTab((label, value) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const controls = [...document.querySelectorAll('input:not([type="password"]):not([type="hidden"]),textarea,[contenteditable="true"]')]
        .filter((el) => el.getClientRects().length && !el.disabled && !el.readOnly);
      const accessibleName = (el) => {
        const id = el.id;
        const labelText = id ? [...document.querySelectorAll(`label[for="${CSS.escape(id)}"]`)].map((x) => x.innerText).join(' ') : '';
        const wrappingLabel = el.closest('label')?.innerText || '';
        return [labelText, wrappingLabel, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name].join(' ');
      };
      const target = controls.find((el) => norm(accessibleName(el)) === norm(label));
      if (!target) return 'Tidak ditemukan kolom terlihat dengan nama yang persis cocok. Password dan kolom tersembunyi dikecualikan.';
      target.focus();
      if (target.isContentEditable) target.textContent = value;
      else {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
        setter ? setter.call(target, value) : target.value = value;
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return `Teks diisikan ke kolom "${label}". Form tidak dikirim.`;
    }, [action.label, action.value]);
    setStatus(result || 'Aksi selesai. Form tidak dikirim.');
  }
}

let task = null;
let taskActions = [];
let taskIndex = 0;
let autoMode = false;
let activeLoop = false;

function setControls() {
  const stopped = task?.state === 'stopped';
  $('#run').disabled = Boolean(task && !['completed', 'stopped'].includes(task.state));
  $('#stop').disabled = !task || stopped || task.state === 'completed';
  $('#resume').hidden = !stopped;
}

function describeAction(action) {
  if (action.type === 'search') return `Cari di Google: ${action.query}`;
  if (action.type === 'open') return `Buka ${action.url}`;
  if (action.type === 'read') return 'Baca teks halaman tab aktif';
  if (action.type === 'click') return `Klik tombol “${action.label}” (dapat mengirim form/pesan)`;
  if (action.type === 'fill') return `Isi kolom “${action.label}” dengan teks yang diberikan`;
  if (action.type === 'paste') return `Baca clipboard dan tempel ke kolom “${action.label}”`;
  if (action.type === 'copy') return 'Salin teks eksplisit ke clipboard';
  return 'Tindakan browser';
}

function showNextConfirmation() {
  if (!task || taskIndex >= taskActions.length) return;
  pendingAction = taskActions[taskIndex];
  $('#confirmText').textContent = `Langkah ${taskIndex + 1}/${taskActions.length}: ${describeAction(pendingAction)}. Lanjutkan?`;
  confirmation.hidden = false;
  setStatus(task.state === 'awaiting_confirmation' ? 'Task dijeda. Tinjau dan konfirmasi langkah berikutnya.' : 'Menunggu konfirmasi untuk langkah berikutnya.');
}

async function runNext() {
  if (!task || task.stopRequested || taskIndex >= taskActions.length) {
    if (task && taskIndex >= taskActions.length && !task.inFlight) {
      task.complete();
      setStatus('Task selesai.');
    }
    setControls();
    return;
  }
  const action = taskActions[taskIndex];
  const needsConfirmedFlag = task.state !== 'running_auto';
  if (!task.begin(needsConfirmedFlag ? { confirmed: true } : {})) {
    if (task.state === 'running_supervised' || task.state === 'awaiting_confirmation') showNextConfirmation();
    setControls();
    return;
  }
  activeLoop = true;
  confirmation.hidden = true;
  setStatus(`Menjalankan ${taskIndex + 1}/${taskActions.length}: ${describeAction(action)}`);
  try {
    await runAction(action);
  } catch (error) {
    setStatus(`Langkah gagal: ${String(error?.message || error)}`);
  } finally {
    task.finishStep();
    taskIndex += 1;
    activeLoop = false;
  }
  if (task.stopRequested || task.state === 'stopped') {
    setStatus('Task berhenti. Langkah yang sudah berjalan tidak dapat dibatalkan. Klik Lanjutkan untuk melanjutkan dengan konfirmasi.');
    setControls();
    return;
  }
  if (taskIndex >= taskActions.length) {
    task.complete();
    setStatus('Semua langkah selesai.');
    setControls();
    return;
  }
  if (task.state === 'running_auto') {
    await runNext();
    return;
  }
  showNextConfirmation();
  setControls();
}

$('#run').addEventListener('click', async () => {
  const parsedTask = parseTaskCommands(commandField.value);
  if (parsedTask.error) { setStatus(parsedTask.error); return; }
  autoMode = parsedTask.auto;
  taskActions = parsedTask.actions;
  const origins = [...new Set(taskActions.flatMap((action) => {
    try {
      const url = action.type === 'search' ? new URL('https://www.google.com') : action.type === 'open' ? new URL(action.url) : null;
      return url ? [`${url.origin}/*`] : [];
    } catch { return []; }
  }))];
  if (origins.length) {
    try {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) { setStatus('Izin host tidak diberikan; task tidak dimulai.'); return; }
    } catch (error) { setStatus(`Tidak dapat meminta izin situs: ${String(error?.message || error)}`); return; }
  }
  task = createTaskController({ autoRequested: autoMode });
  taskIndex = 0;
  setControls();
  if (autoMode) {
    setStatus('Mode otomatis aktif untuk task ini. STOP menghentikan langkah berikutnya.');
    runNext();
  } else {
    showNextConfirmation();
    setControls();
  }
});

$('#stop').addEventListener('click', () => {
  if (!task) return;
  const state = task.stop();
  confirmation.hidden = true;
  setStatus(task.inFlight ? 'STOP diminta. Langkah yang sedang berjalan akan selesai, langkah berikutnya tidak dijalankan.' : `Task dihentikan (${state}).`);
  setControls();
});

$('#resume').addEventListener('click', () => {
  if (!task?.resume()) return;
  showNextConfirmation();
  setControls();
});

$('#confirmRun').addEventListener('click', async () => {
  if (!task || !pendingAction || !task.confirmNext()) return;
  pendingAction = null;
  confirmation.hidden = true;
  await runNext();
});
