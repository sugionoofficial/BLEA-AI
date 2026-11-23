import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight, BookOpen, Check, ChevronDown, CircleAlert, Copy, Cpu, Globe,
  ListChecks, Loader2, Send, Sparkles, Square, Trash2, Wrench, X,
} from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { fetchEnabledModelItems } from '../api/unorouter';
import { fetchAgentSkills, runAgentTurn } from '../agent/agentClient';
import { resolveAgentModel } from '../agent/modelRouting';
import { StudioMessageBody } from '../auth/AIStudio';
import { useAuth } from '../auth/AuthProvider';
import './agent.css';

const STORAGE_KEY = 'blea-agent-thread-v1';
const MAX_TURNS_KEPT = 20;

const SAMPLE_TASKS = [
  'Rancang struktur landing page untuk produk agen AI, lalu tulis copy hero-nya.',
  'Bandingkan dua pendekatan caching untuk API Worker, pilih satu, jelaskan trade-off-nya.',
  'Buat laporan status mingguan dari catatan ini: rilis login selesai, antrean video masih bocor, biaya token naik 12%.',
];

function loadStoredThread() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch { /* rusak: mulai bersih */ }
  return { messages: [], steps: [], skills: [] };
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function StepFeed({ steps, running }) {
  if (!steps.length && !running) return null;
  return (
    <ol className="agent-feed" aria-label="Langkah agen">
      {steps.map((step, index) => (
        <li className={`agent-feed-item is-${step.status}`} key={`${step.label}-${index}`}>
          <span className="agent-feed-mark" aria-hidden="true">
            {step.status === 'error' ? <X size={11} /> : step.status === 'done' ? <Check size={11} /> : <Loader2 size={11} className="agent-spin" />}
          </span>
          <span className="agent-feed-text">
            <b>{step.label}</b>
            {step.detail && <small>{step.detail}</small>}
          </span>
        </li>
      ))}
      {running && (
        <li className="agent-feed-item is-running">
          <span className="agent-feed-mark" aria-hidden="true"><Loader2 size={11} className="agent-spin" /></span>
          <span className="agent-feed-text"><b>Menyusun jawaban</b></span>
        </li>
      )}
    </ol>
  );
}

function SkillCard({ skills, catalog, onPin }) {
  return (
    <section className="agent-skills" aria-label="Skill agen">
      <header>
        <span className="agent-skills-title"><BookOpen size={13} /> Skill</span>
        <small>
          Diambil dari <a href="https://github.com/anthropics/skills" target="_blank" rel="noopener noreferrer">anthropics/skills</a> (Apache-2.0), teks verbatim dengan checksum.
        </small>
      </header>
      <div className="agent-skill-pills">
        {catalog.length === 0 && <span className="agent-skill-empty">Katalog skill belum termuat.</span>}
        {catalog.map((skill) => {
          const pinned = skills.some((item) => item.id === skill.id);
          return (
            <button
              key={skill.id}
              type="button"
              className={`agent-skill-pill ${pinned ? 'is-active' : ''}`}
              onClick={() => onPin(skill.id)}
              aria-pressed={pinned}
              title={skill.description}
            >
              {pinned ? <Check size={11} /> : <Sparkles size={11} />}
              {skill.name}
            </button>
          );
        })}
      </div>
      {skills.length > 0 && (
        <ul className="agent-skill-log">
          {skills.map((skill) => (
            <li key={`${skill.id}-${skill.resource || ''}`}>
              <b>{skill.id}</b>
              {skill.resource ? ` · ${skill.resource}` : ''}
              <small>dimuat {shortTime(skill.at)}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AgentPage() {
  const { user } = useAuth();
  const stored = useMemo(loadStoredThread, []);
  const [messages, setMessages] = useState(stored.messages);
  const [steps, setSteps] = useState([]);
  const [skills, setSkills] = useState(stored.skills || []);
  const [skillCatalog, setSkillCatalog] = useState([]);
  const [pinnedSkill, setPinnedSkill] = useState('');
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [modelItems, setModelItems] = useState([]);
  const [model, setModel] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [copiedId, setCopiedId] = useState('');
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const composerRef = useRef(null);

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kamu';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [items, catalogResult] = await Promise.all([fetchEnabledModelItems(), fetchAgentSkills()]);
      if (cancelled) return;
      setModelItems(items);
      if (catalogResult.ok && Array.isArray(catalogResult.data?.skills)) setSkillCatalog(catalogResult.data.skills);
      const resolved = resolveAgentModel(items, '');
      if (resolved.resolved) setModel(resolved.model);
      else if (!items.length) setError('Belum ada model chat aktif. Admin perlu mengaktifkan model di Admin Panel → Model.');
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        messages: messages.slice(-MAX_TURNS_KEPT * 2),
        skills: skills.slice(-6),
      }));
    } catch { /* kuota penuh: riwayat sesi tetap jalan di memori */ }
  }, [messages, skills]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, steps, running]);

  const activeModelMeta = useMemo(() => {
    const found = modelItems.find((item) => item.id === model);
    return { model, provider: found?.provider || 'unorouter' };
  }, [model, modelItems]);

  const send = useCallback(async (text) => {
    const content = String(text ?? '').trim();
    if (!content || running) return;
    if (!activeModelMeta.model) {
      setError('Pilih model terlebih dulu.');
      return;
    }

    setError('');
    setDraft('');
    setSteps([]);
    const userMessage = { id: `u-${Date.now()}`, role: 'user', content, at: new Date().toISOString() };
    const history = [...messages, userMessage].map(({ role, content: body }) => ({ role, content: body }));
    setMessages((current) => [...current, userMessage]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const liveSteps = [];
    const result = await runAgentTurn({
      messages: history,
      model: activeModelMeta.model,
      provider: activeModelMeta.provider,
      skill: pinnedSkill,
      blueprint: '',
      signal: controller.signal,
      onMeta: (meta) => {
        if (meta.fallback) setError(`Model utama sibuk, jawaban dialihkan ke ${meta.model}.`);
      },
      onStep: (step) => {
        const index = liveSteps.findIndex((item) => item.label === step.label && item.status === 'start');
        if (step.status === 'start') liveSteps.push(step);
        else if (index >= 0) liveSteps[index] = step;
        else liveSteps.push(step);
        setSteps([...liveSteps]);
      },
      onSkill: (skill) => {
        setSkills((current) => (current.some((item) => item.id === skill.id && (item.resource || '') === (skill.resource || ''))
          ? current
          : [...current, { id: skill.id, resource: skill.resource || '', at: new Date().toISOString() }]));
      },
      onDelta: () => { /* teks final ditambahkan dari onDone agar tidak dobel */ },
    });

    abortRef.current = null;
    setRunning(false);

    if (result.aborted) {
      setSteps([]);
      return;
    }
    if (!result.ok) {
      setError(result.data?.error || 'Agen gagal menyelesaikan giliran ini.');
      setSteps([]);
      return;
    }

    setMessages((current) => [...current, {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: result.data.reply || '',
      actions: result.data.actions || [],
      model: result.data.model,
      stopReason: result.data.stopReason,
      at: new Date().toISOString(),
    }]);
    setSteps([]);
  }, [activeModelMeta, messages, pinnedSkill, running]);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }

  function onSubmit(event) {
    event.preventDefault();
    send(draft);
  }

  function clearThread() {
    if (running) stop();
    setMessages([]);
    setSteps([]);
    setSkills([]);
    setError('');
    setPinnedSkill('');
  }

  function copy(message) {
    const text = String(message.content || '');
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => (current === message.id ? '' : current)), 1800);
    }).catch(() => {});
  }

  function togglePin(skillId) {
    setPinnedSkill((current) => (current === skillId ? '' : skillId));
  }

  return (
    <DropXLayout
      title="Agen"
      description="Satu agen untuk mengerjakan tugas: menulis, menganalisis, menelusuri sumber, dan memuat panduan skill."
      actions={(
        <div className="agent-head-actions">
          <span className="agent-model-note"><Cpu size={12} /> {activeModelMeta.model || 'belum ada model'}</span>
          <button type="button" className="agent-ghost-btn" onClick={clearThread} disabled={!messages.length && !running}>
            <Trash2 size={13} /> Bersihkan
          </button>
        </div>
      )}
    >
      <div className="agent-layout">
        <main className="agent-panel">
          <div className="agent-thread">
            {!messages.length && !running && (
              <div className="agent-intro">
                <h2>Apa yang mau dikerjakan?</h2>
                <p>
                  Agen ini memakai model chat yang sama dengan AI Studio, ditambah tiga alat di server: pencarian web, pembacaan URL,
                  dan pemuatan panduan skill. Setiap langkah alat tampil di bawah balasannya, jadi kamu bisa memeriksa apa yang benar-benar terjadi.
                </p>
                <div className="agent-samples">
                  {SAMPLE_TASKS.map((task) => (
                    <button key={task} type="button" onClick={() => { setDraft(task); composerRef.current?.focus(); }}>
                      {task}
                      <ArrowUpRight size={12} />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <article className={`agent-message from-${message.role}`} key={message.id}>
                <header>
                  <b>{message.role === 'user' ? fullName : 'BLEA Agent'}</b>
                  <time>{shortTime(message.at)}</time>
                  {message.role === 'assistant' && message.model && <span className="agent-message-model">{message.model}</span>}
                  {message.role === 'assistant' && (
                    <button type="button" className="agent-copy" onClick={() => copy(message)} aria-label="Salin balasan">
                      {copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}
                    </button>
                  )}
                </header>
                {message.role === 'assistant' ? (
                  <StudioMessageBody content={message.content} isTyping={false} copiedCodeKey="" onCopyCode={() => {}} />
                ) : (
                  <p className="agent-user-text">{message.content}</p>
                )}
                {message.actions?.length > 0 && (
                  <div className="agent-action-row">
                    {message.actions.map((action, index) => (
                      <span className={`agent-action ${action.ok ? 'is-ok' : 'is-fail'}`} key={`${action.tool}-${index}`}>
                        <Wrench size={10} /> {action.tool}: {action.summary}
                      </span>
                    ))}
                  </div>
                )}
                {message.stopReason === 'tool_budget' && (
                  <p className="agent-note"><CircleAlert size={12} /> Batas alat tercapai sebelum jawaban final.</p>
                )}
              </article>
            ))}

            {running && (
              <article className="agent-message from-assistant is-live">
                <header><b>BLEA Agent</b><time>berjalan</time></header>
                <StepFeed steps={steps} running />
              </article>
            )}
            <div ref={endRef} />
          </div>

          {error && (
            <div className="agent-error" role="alert">
              <CircleAlert size={13} />
              <span>{error}</span>
              <button type="button" onClick={() => setError('')} aria-label="Tutup pesan galat"><X size={12} /></button>
            </div>
          )}

          <form className="agent-composer" onSubmit={onSubmit}>
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send(draft);
                }
              }}
              placeholder="Tulis tugasnya. Enter mengirim, Shift+Enter baris baru."
              rows={2}
              maxLength={8000}
              aria-label="Tulis tugas untuk agen"
            />
            <div className="agent-composer-bar">
              <div className="agent-model-wrap">
                <button
                  type="button"
                  className={`agent-model-btn ${modelOpen ? 'is-open' : ''}`}
                  onClick={() => setModelOpen((open) => !open)}
                  aria-expanded={modelOpen}
                  aria-label="Pilih model"
                  disabled={!modelItems.length}
                >
                  <Cpu size={12} />
                  <span>{model || 'pilih model'}</span>
                  <ChevronDown size={11} />
                </button>
                {modelOpen && (
                  <div className="agent-model-menu" role="listbox" aria-label="Model">
                    {modelItems.map((item) => (
                      <button
                        key={`${item.provider}:${item.id}`}
                        type="button"
                        role="option"
                        aria-selected={item.id === model}
                        className={item.id === model ? 'is-selected' : ''}
                        onClick={() => { setModel(item.id); setModelOpen(false); }}
                      >
                        <span>{item.id}</span>
                        {item.provider && item.provider !== 'unorouter' && <small>{item.provider}</small>}
                        {item.id === model && <Check size={11} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="agent-composer-hint">
                <Globe size={11} /> pencarian web · <BookOpen size={11} /> skill · <ListChecks size={11} /> langkah
              </span>
              {running ? (
                <button type="button" className="agent-stop" onClick={stop}><Square size={11} /> Hentikan</button>
              ) : (
                <button type="submit" className="agent-send" disabled={!draft.trim()}><span>Kerjakan</span><Send size={13} /></button>
              )}
            </div>
          </form>
        </main>

        <aside className="agent-rail">
          <SkillCard skills={skills} catalog={skillCatalog} onPin={togglePin} />
          <section className="agent-rail-note">
            <h3>Batas yang perlu kamu tahu</h3>
            <ul>
              <li>Tidak ada eksekusi kode, shell, atau akses berkas di perangkatmu.</li>
              <li>Agen tidak mengubah data akun, kredit, atau repository GitHub.</li>
              <li>Panduan skill adalah teks pihak ketiga (Apache-2.0), bukan fitur Anthropic dan tidak disponsori Anthropic.</li>
              <li>Hasil pencarian bisa usang atau salah; periksa tautan sebelum dipakai.</li>
            </ul>
            <Link to="/studio" className="agent-rail-link">Butuh obrolan panjang dengan riwayat? Buka AI Studio <ArrowUpRight size={11} /></Link>
          </section>
        </aside>
      </div>
    </DropXLayout>
  );
}
