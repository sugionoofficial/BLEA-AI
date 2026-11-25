const CHANNEL = 'blea-browser-companion-v1';
const APP_ORIGIN = /^https:\/\/blea\.ai$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const TARGET_KEY = 'bleaBrowserTarget';
const BLOCKED_HOST = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|.*\.local$|.*\.internal$)/i;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function targetIsPublicHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !BLOCKED_HOST.test(url.hostname) && !url.hostname.includes(':');
  } catch { return false; }
}

async function getTarget() {
  const stored = await chrome.storage.session.get(TARGET_KEY);
  const target = stored[TARGET_KEY];
  if (!target?.tabId) return null;
  try {
    const tab = await chrome.tabs.get(target.tabId);
    if (!tab.url || !targetIsPublicHttpUrl(tab.url)) return null;
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || tab.url };
  } catch { return null; }
}

async function withAuthorizedTarget(fn) {
  const target = await getTarget();
  if (!target) throw new Error('Belum ada tab task. Mulai task dari BLEA Agent untuk membuka tab otomatis.');
  const url = new URL(target.url);
  const allowed = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
  if (!allowed) throw new Error(`Izin situs belum diberikan untuk ${url.origin}. Berikan izin origin itu dari side panel ekstensi.`);
  return fn(target);
}

async function focusTarget(target) {
  const tab = await chrome.tabs.get(target.tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, tab) => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (error) reject(error); else resolve(tab);
    };
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish(null, tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(new Error('Waktu tunggu halaman task habis.')), timeoutMs);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(null, tab); }).catch((error) => finish(error));
  });
}

async function cdp(target, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId: target.tabId }, method, params);
}

async function withDebugger(target, fn) {
  const debuggee = { tabId: target.tabId };
  await chrome.debugger.attach(debuggee, '1.3');
  try { return await fn(); }
  finally { try { await chrome.debugger.detach(debuggee); } catch {} }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function typeInto(target, label, value) {
  const geometry = await chrome.scripting.executeScript({
    target: { tabId: target.tabId },
    func: (wanted) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const controls = [...document.querySelectorAll('input:not([type="password"]):not([type="hidden"]),textarea,[contenteditable="true"],[role="textbox"]')];
      const name = (el) => [el.labels ? [...el.labels].map((x) => x.innerText).join(' ') : '', el.getAttribute('aria-label'), el.placeholder, el.name].join(' ');
      const el = controls.find((item) => item.getClientRects().length && !item.disabled && !item.readOnly && norm(name(item)) === norm(wanted));
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, args: [label],
  });
  const point = geometry?.[0]?.result;
  if (!point) throw new Error(`Kolom “${label}” tidak ditemukan sebagai kontrol yang terlihat.`);
  await withDebugger(target, async () => {
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' });
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'CTRL', code: 'ControlLeft', modifiers: 2 });
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'CTRL', code: 'ControlLeft' });
    for (const char of String(value)) { await cdp(target, 'Input.insertText', { text: char }); await delay(35); }
  });
  return { ok: true, message: `Pointer diarahkan ke “${label}” dan ${String(value).length} karakter diketik satu per satu.` };
}

async function clickVisible(target, label) {
  const geometry = await chrome.scripting.executeScript({
    target: { tabId: target.tabId },
    func: (wanted) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const el = [...document.querySelectorAll('button,[role="button"],a[href],input[type="submit"]')]
        .find((item) => item.getClientRects().length && norm(item.innerText || item.getAttribute('aria-label') || item.title || item.value) === norm(wanted));
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, args: [label],
  });
  const point = geometry?.[0]?.result;
  if (!point) throw new Error(`Kontrol “${label}” tidak ditemukan.`);
  await withDebugger(target, async () => {
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' });
    await delay(120);
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  });
  return { ok: true, message: `Pointer mengklik “${label}”.` };
}

function snapshotPage() {
  const visible = (el) => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const label = el.id ? [...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)].map((x) => x.innerText).join(' ') : '';
    const wrap = el.closest('label')?.innerText || '';
    return [aria, label, wrap, placeholder, el.name || ''].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim().slice(0, 180);
  };
  const buttons = [...document.querySelectorAll('button,[role="button"],a[href],input[type="button"],input[type="submit"]')]
    .filter(visible)
    .slice(0, 80)
    .map((el) => ({ role: el.tagName === 'A' ? 'link' : 'button', text: (el.innerText || el.getAttribute('aria-label') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 160), href: el.tagName === 'A' ? el.href : '' }))
    .filter((x) => x.text);
  const fields = [...document.querySelectorAll('input:not([type="password"]):not([type="hidden"]),textarea,[contenteditable="true"],[role="textbox"]')]
    .filter(visible)
    .slice(0, 50)
    .map((el) => ({ name: labelFor(el), type: el.type || (el.isContentEditable ? 'contenteditable' : 'text'), value: el.isContentEditable ? el.innerText.slice(0, 120) : String(el.value || '').slice(0, 120) }))
    .filter((x) => x.name);
  return {
    url: location.href,
    title: document.title.slice(0, 200),
    text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 6000),
    buttons,
    fields,
  };
}

function performAction(action) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!action || typeof action !== 'object') throw new Error('Aksi tidak valid.');
  if (action.type === 'navigate') {
    const url = String(action.url || '').trim();
    if (!targetIsPublicHttpUrl(url)) throw new Error('Navigasi hanya diizinkan ke URL HTTP(S) publik.');
    location.assign(url);
    return { ok: true, message: `Navigasi dimulai ke ${url}` };
  }
  if (action.type === 'click') {
    const label = String(action.label || '').trim();
    if (!label || label.length > 160) throw new Error('Label tombol tidak valid.');
    const candidates = [...document.querySelectorAll('button,[role="button"],a[href],input[type="button"],input[type="submit"]')];
    const target = candidates.find((el) => el.getClientRects().length && norm(el.innerText || el.getAttribute('aria-label') || el.title || el.value) === norm(label));
    if (!target) throw new Error(`Kontrol terlihat dengan label persis “${label}” tidak ditemukan.`);
    target.click();
    return { ok: true, message: `Kontrol “${label}” diklik.` };
  }
  if (action.type === 'fill') {
    const label = String(action.label || '').trim();
    const value = String(action.value ?? '');
    if (!label || label.length > 180 || value.length > 4000) throw new Error('Kolom atau nilai melebihi batas.');
    const controls = [...document.querySelectorAll('input:not([type="password"]):not([type="hidden"]),textarea,[contenteditable="true"],[role="textbox"]')]
      .filter((el) => el.getClientRects().length && !el.disabled && !el.readOnly);
    const target = controls.find((el) => norm((el.id ? [...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)].map((x) => x.innerText).join(' ') : '') + ' ' + (el.closest('label')?.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.name || '')) === norm(label));
    if (!target) throw new Error(`Kolom terlihat “${label}” tidak ditemukan. Kolom password tidak dapat diisi.`);
    target.focus();
    if (target.isContentEditable) target.textContent = value;
    else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
      setter ? setter.call(target, value) : target.value = value;
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, message: `Kolom “${label}” diisi. Tidak ada form yang dikirim.` };
  }
  if (action.type === 'scroll') {
    const amount = Math.max(-700, Math.min(700, Number(action.amount) || 0));
    window.scrollBy({ top: amount, behavior: 'smooth' });
    return { ok: true, message: `Halaman digulir ${amount}px.` };
  }
  return { error: 'Jenis aksi browser tidak didukung.' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== CHANNEL) return false;
  const fromContent = Boolean(sender.tab?.id) && !String(sender.url || '').startsWith('chrome-extension://');
  if (fromContent && !APP_ORIGIN.test(new URL(sender.url || sender.tab.url).origin)) {
    sendResponse({ error: 'Origin BLEA tidak diizinkan.' });
    return false;
  }

  (async () => {
    const type = String(message.type || '');
    if (!fromContent) {
      if (type === 'list-tabs') {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        return { result: tabs.filter((tab) => tab.id && targetIsPublicHttpUrl(tab.url || '') && !APP_ORIGIN.test(new URL(tab.url).origin)).map(({ id, title, url, active }) => ({ id, title: title || url, url, active })) };
      }
      if (type === 'set-target') {
        const tab = await chrome.tabs.get(Number(message.payload?.tabId));
        if (!targetIsPublicHttpUrl(tab.url || '') || APP_ORIGIN.test(new URL(tab.url).origin)) throw new Error('Pilih tab web publik selain tab BLEA.');
        const origin = new URL(tab.url).origin;
        const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
        if (!granted) throw new Error(`Izin situs belum diberikan untuk ${origin}.`);
        await chrome.storage.session.set({ [TARGET_KEY]: { tabId: tab.id, windowId: tab.windowId } });
        return { result: { tabId: tab.id, title: tab.title || tab.url, url: tab.url } };
      }
      if (type === 'get-target') return { result: await getTarget() };
      return { error: 'Permintaan extension tidak dikenal.' };
    }

    if (type === 'open-task-tab') {
      const created = await chrome.tabs.create({ url: 'https://www.google.com/', active: true });
      const tab = await waitForTabComplete(created.id);
      await chrome.storage.session.set({ [TARGET_KEY]: { tabId: tab.id, windowId: tab.windowId } });
      return { result: { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || 'Google' } };
    }
    if (type === 'ping') return { result: { connected: true } };
    if (type === 'get-target') return { result: await getTarget() };
    if (type === 'snapshot') {
      return await withAuthorizedTarget(async (target) => {
        await focusTarget(target);
        const results = await chrome.scripting.executeScript({ target: { tabId: target.tabId }, func: snapshotPage });
        return { result: results?.[0]?.result || null };
      });
    }
    if (type === 'act') {
      const action = message.payload?.action;
      return await withAuthorizedTarget(async (target) => {
        await focusTarget(target);
        if (action?.type === 'navigate') {
          const next = new URL(String(action.url || ''));
          const permission = await chrome.permissions.contains({ origins: [`${next.origin}/*`] });
          if (!permission) throw new Error(`Situs ${next.origin} belum diizinkan. Masukkan origin tersebut pada kolom izin tambahan di side panel ekstensi, lalu lanjutkan task.`);
        }
        if (action?.type === 'fill') return { result: await typeInto(target, action.label, action.value) };
        if (action?.type === 'click') return { result: await clickVisible(target, action.label) };
        const results = await chrome.scripting.executeScript({ target: { tabId: target.tabId }, func: performAction, args: [action] });
        return { result: results?.[0]?.result || { ok: true } };
      });
    }
    if (type === 'stop') return { result: { stopped: true } };
    return { error: 'Perintah browser tidak dikenal.' };
  })().then(sendResponse).catch((error) => sendResponse({ error: String(error?.message || error).slice(0, 400) }));
  return true;
});
