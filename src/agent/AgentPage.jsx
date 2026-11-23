import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight, BookOpen, Check, ChevronDown, CircleAlert, Coins, Copy, Cpu, FileText,
  Clapperboard, Globe, Image as ImageIcon, ListChecks, Loader2, Music, Paperclip, Send, Sparkles,
  Square, Trash2, Video, Wrench, X,
} from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { fetchEnabledModelItems } from '../api/unorouter';
import { fetchAgentSkills, runAgentTurn } from '../agent/agentClient';
import { resolveAgentModel } from '../agent/modelRouting';
import { StudioMessageBody } from '../auth/AIStudio';
import { supabase } from '../lib/supabase';
import { analyzeVideo, isAnalysisSupported } from '../lib/videoAnalysis';
import { ClipPlanPanel } from './ClipPlanPanel';
import { useAuth } from '../auth/AuthProvider';
import {
  MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, UPLOAD_ACCEPT, formatBytes, oversizeMessage,
  partitionBySize, uploadAttachments,
} from '../lib/uploads';
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

function StepFeed({ steps, running, tickCount = 0 }) {
  if (!steps.length && !running) return null;
  const waitingOnModel = running && steps.length > 0 && steps[steps.length - 1].status === 'start';
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
      {waitingOnModel && (
        <li className="agent-feed-item is-running">
          <span className="agent-feed-mark" aria-hidden="true"><Loader2 size={11} className="agent-spin" /></span>
          <span className="agent-feed-text">
            <b>Model sedang memproses</b>
            {tickCount > 0 && <small>{(tickCount * 2.5).toFixed(0)} detik berjalan · panggilan model bisa memakan waktu</small>}
          </span>
        </li>
      )}
      {running && !waitingOnModel && (
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

const KIND_ICON = { image: ImageIcon, video: Video, audio: Music, file: FileText };

function AttachmentChip({ attachment, onRemove, compact = false }) {
  const Icon = KIND_ICON[attachment.kind] || FileText;
  return (
    <div className={`agent-attachment ${compact ? 'is-compact' : ''}`}>
      {attachment.kind === 'image' ? (
        <img src={attachment.url} alt="" />
      ) : (
        <span className="agent-attachment-icon"><Icon size={13} /></span>
      )}
      <span className="agent-attachment-name">
        <b>{attachment.name}</b>
        <small>{attachment.kind} · {formatBytes(attachment.size)}</small>
      </span>
      {onRemove && (
        <button type="button" onClick={() => onRemove(attachment.id)} aria-label={`Hapus ${attachment.name}`}>
          <X size={11} />
        </button>
      )}
    </div>
  );
}

export function AgentPage() {
  const { user } = useAuth();
  const stored = useMemo(loadStoredThread, []);
  const [messages, setMessages] = useState(stored.messages);
  const [steps, setSteps] = useState([]);
  const [tickCount, setTickCount] = useState(0);
  const [lastCredits, setLastCredits] = useState(0);
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
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const fileInputRef = useRef(null);
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

  // Digest analisis hanya valid untuk video yang sedang dilampirkan.
  const attachedVideo = attachments.find((attachment) => attachment.kind === 'video');
  useEffect(() => {
    if (!attachedVideo || (analysis && analysis.url !== attachedVideo.url)) setAnalysis(null);
  }, [attachedVideo, analysis]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, steps, running]);

  const activeModelMeta = useMemo(() => {
    const found = modelItems.find((item) => item.id === model);
    return { model, provider: found?.provider || 'unorouter' };
  }, [model, modelItems]);

  const send = useCallback(async (text) => {
    const content = String(text ?? '').trim();
    if ((!content && !attachments.length) || running) return;
    if (!activeModelMeta.model) {
      setError('Pilih model terlebih dulu.');
      return;
    }
    if (uploading) {
      setError('Tunggu unggahan selesai sebelum mengirim.');
      return;
    }

    setError('');
    setDraft('');
    setSteps([]);
    setTickCount(0);
    const sentAttachments = attachments;
    const sentAnalysis = analysis;
    const userMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content,
      attachments: sentAttachments,
      at: new Date().toISOString(),
    };
    const history = [...messages, userMessage].map(({ role, content: body }) => ({ role, content: body }));
    setMessages((current) => [...current, userMessage]);
    setAttachments([]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const liveSteps = [];
    let pendingClipPlan = null;
    const result = await runAgentTurn({
      messages: history,
      model: activeModelMeta.model,
      provider: activeModelMeta.provider,
      skill: pinnedSkill,
      blueprint: '',
      attachments: sentAttachments.map(({ url, name, kind, type, size }) => ({ url, name, kind, type, size })),
      videoAnalysis: sentAnalysis
        ? {
          durationSec: sentAnalysis.durationSec,
          width: sentAnalysis.width,
          height: sentAnalysis.height,
          truncated: sentAnalysis.truncated,
          sceneCuts: sentAnalysis.sceneCuts,
          audio: sentAnalysis.audio,
        }
        : null,
      signal: controller.signal,
      onMeta: (meta) => {
        if (meta.fallback) setError(`Model utama sibuk, jawaban dialihkan ke ${meta.model}.`);
        if (Number(meta.credits) > 0) setLastCredits(Number(meta.credits));
      },
      onStep: (step) => {
        // `progress` menandai model masih memproses, bukan langkah baru: ia
        // hanya menyalakan indikator di langkah yang sedang berjalan.
        if (step.progress) { setTickCount((count) => count + 1); return; }
        const index = liveSteps.findIndex((item) => item.label === step.label && item.status === 'start');
        if (step.status === 'start') liveSteps.push(step);
        else if (index >= 0) liveSteps[index] = step;
        else liveSteps.push(step);
        setSteps([...liveSteps]);
        setTickCount(0);
      },
      onSkill: (skill) => {
        setSkills((current) => (current.some((item) => item.id === skill.id && (item.resource || '') === (skill.resource || ''))
          ? current
          : [...current, { id: skill.id, resource: skill.resource || '', at: new Date().toISOString() }]));
      },
      onClips: (event) => { pendingClipPlan = event; },
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
      credits: Number(result.data.credits) || 0,
      clipPlan: pendingClipPlan,
      model: result.data.model,
      stopReason: result.data.stopReason,
      at: new Date().toISOString(),
    }]);
    setSteps([]);
  }, [activeModelMeta, attachments, messages, pinnedSkill, running, uploading]);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }

  async function analyzeAttachedVideo() {
    if (!attachedVideo || analyzing) return;
    if (!isAnalysisSupported()) {
      setError('Analisis video hanya bisa dijalankan di browser.');
      return;
    }
    setAnalyzing(true);
    setAnalyzeProgress(0);
    setError('');
    try {
      const result = await analyzeVideo(attachedVideo.url, { onProgress: setAnalyzeProgress });
      setAnalysis({ ...result, url: attachedVideo.url, name: attachedVideo.name });
    } catch (err) {
      // Gagal analisis bukan kegagalan fatal: pengguna masih bisa bertanya
      // tentang video tanpa digest sinyal.
      setError(`Analisis video gagal: ${err?.message || err}. Kamu masih bisa mengirim video tanpa analisis.`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function onFilesPicked(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length || !user?.id) return;
    setError('');

    const room = Math.max(0, 6 - attachments.length);
    if (!room) {
      setError('Maksimal 6 lampiran per pesan.');
      return;
    }
    const { accepted, rejected } = partitionBySize(files.slice(0, room), MAX_UPLOAD_BYTES);
    if (rejected.length) setError(oversizeMessage(rejected, MAX_UPLOAD_BYTES));
    if (!accepted.length) return;

    setUploading(true);
    try {
      const { uploaded, failures } = await uploadAttachments({ client: supabase, files: accepted, userId: user.id, folder: 'agent' });
      if (uploaded.length) setAttachments((current) => [...current, ...uploaded].slice(0, 6));
      if (failures.length) setError(`Gagal mengunggah ${failures.map((item) => item.name).join(', ')}: ${failures[0].error}`);
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function onSubmit(event) {
    event.preventDefault();
    // Dengan lampiran tapi tanpa teks, tetap beri instruksi minimal supaya
    // model tahu apa yang harus dilakukan terhadap berkasnya.
    send(draft.trim() || (attachments.length ? 'Tolong periksa lampiran ini.' : ''));
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
          <span className="agent-model-note">
            <Cpu size={12} /> {activeModelMeta.model || 'belum ada model'}
            {lastCredits > 0 && <em> · {lastCredits} kredit/giliran</em>}
          </span>
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
                  <>
                    <p className="agent-user-text">{message.content}</p>
                    {message.attachments?.length > 0 && (
                      <div className="agent-message-attachments">
                        {message.attachments.map((attachment) => (
                          <AttachmentChip key={attachment.id || attachment.url} attachment={attachment} compact />
                        ))}
                      </div>
                    )}
                  </>
                )}
                {Number(message.credits) > 0 && (
                  <div className="agent-action-row">
                    <span className="agent-action is-cost"><Coins size={10} /> {message.credits} kredit untuk giliran ini</span>
                  </div>
                )}
                {message.clipPlan?.clips?.length > 0 && (
                  <ClipPlanPanel
                    plan={message.clipPlan}
                    client={supabase}
                    userId={user?.id}
                    videoName={message.clipPlan.sourceUrl?.split('/').pop()}
                  />
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
                <StepFeed steps={steps} running tickCount={tickCount} />
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
            {attachedVideo && (
              <div className="agent-analysis">
                {analyzing ? (
                  <span className="agent-analysis-status">
                    <Loader2 size={12} className="agent-spin" /> Menganalisis video… {Math.round(analyzeProgress * 100)}%
                    <small>diproses di browser, video tidak diunggah ke server analisis</small>
                  </span>
                ) : analysis ? (
                  <span className="agent-analysis-status is-done">
                    <Check size={12} /> Teranalisis · {analysis.sceneCuts.length} scene cut
                    {analysis.audio ? ` · ${analysis.audio.peaks.length} lonjakan audio` : ' · audio tidak terbaca'}
                  </span>
                ) : (
                  <button type="button" className="agent-analysis-trigger" onClick={analyzeAttachedVideo}>
                    <Clapperboard size={12} /> Analisis video untuk cari hook
                  </button>
                )}
              </div>
            )}
            {(attachments.length > 0 || uploading) && (
              <div className="agent-attachments">
                {attachments.map((attachment) => (
                  <AttachmentChip key={attachment.id} attachment={attachment} onRemove={removeAttachment} />
                ))}
                {uploading && (
                  <div className="agent-attachment is-uploading">
                    <span className="agent-attachment-icon"><Loader2 size={13} className="agent-spin" /></span>
                    <span className="agent-attachment-name"><b>Mengunggah…</b><small>mohon tunggu</small></span>
                  </div>
                )}
              </div>
            )}
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
              <button
                type="button"
                className="agent-upload"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || uploading}
                aria-label="Unggah foto, video, audio, atau berkas"
                title={`Unggah berkas (maks ${MAX_UPLOAD_LABEL} per berkas)`}
              >
                <Paperclip size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="agent-file-input"
                accept={UPLOAD_ACCEPT}
                onChange={onFilesPicked}
              />
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
                <Paperclip size={11} /> maks {MAX_UPLOAD_LABEL} · <Globe size={11} /> pencarian web · <ListChecks size={11} /> langkah
              </span>
              {running ? (
                <button type="button" className="agent-stop" onClick={stop}><Square size={11} /> Hentikan</button>
              ) : (
                <button type="submit" className="agent-send" disabled={(!draft.trim() && !attachments.length) || uploading}><span>Kerjakan</span><Send size={13} /></button>
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
