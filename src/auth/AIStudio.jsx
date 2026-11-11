import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, Command, FolderOpen, Layers3, LogOut, MessageSquarePlus, MoreHorizontal, Plus, Send, Settings2, ShieldCheck, Sparkles, Trash2, WandSparkles, X } from 'lucide-react';
import { Brand } from '../components/Brand';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

const prompts = [
  'Bantu aku mencari arah untuk ide baru',
  'Buat kerangka konten yang terasa personal',
  'Pecah proyek besar jadi langkah kecil',
];

function shortTitle(text) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > 54 ? `${normalized.slice(0, 51)}…` : normalized;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export function AIStudio() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [draft, setDraft] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const endOfMessages = useRef(null);
  const draftRef = useRef(null);
  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === activeId) || null, [conversations, activeId]);
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const isAdmin = user?.app_metadata?.role === 'admin';

  const loadSidebarData = useCallback(async () => {
    if (!user?.id) return;
    setLoadingHistory(true);
    const [conversationResult, projectResult] = await Promise.all([
      supabase.from('ai_conversations').select('id,user_id,project_id,title,created_at,updated_at').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(100),
      supabase.from('projects').select('id,name').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(100),
    ]);
    if (conversationResult.error || projectResult.error) {
      console.error('Loading AI Studio sidebar failed:', conversationResult.error || projectResult.error);
      setError('Riwayat atau proyek belum bisa dimuat. Coba muat ulang.');
    } else {
      setConversations(conversationResult.data ?? []);
      setProjects(projectResult.data ?? []);
    }
    setLoadingHistory(false);
  }, [user?.id]);

  const loadMessages = useCallback(async (conversationId) => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setLoadingMessages(true);
    setError('');
    const { data, error: queryError } = await supabase
      .from('ai_messages')
      .select('id,conversation_id,user_id,role,content,created_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(500);
    if (queryError) {
      console.error('Loading conversation failed:', queryError);
      setError('Percakapan belum bisa dibuka. Coba lagi.');
    } else {
      setMessages(data ?? []);
    }
    setLoadingMessages(false);
  }, [user?.id]);

  useEffect(() => { loadSidebarData(); }, [loadSidebarData]);

  useEffect(() => {
    loadMessages(activeId);
    if (activeId) {
      const conversation = conversations.find((item) => item.id === activeId);
      setSelectedProject(conversation?.project_id || '');
    }
  }, [activeId, conversations, loadMessages]);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loadingMessages]);

  function startNewConversation() {
    setActiveId(null);
    setMessages([]);
    setDraft('');
    setSelectedProject('');
    setError('');
    draftRef.current?.focus();
  }

  async function saveMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError('');

    try {
      let conversation = activeConversation;
      if (!conversation) {
        const { data, error: createError } = await supabase
          .from('ai_conversations')
          .insert({ user_id: user.id, project_id: selectedProject || null, title: shortTitle(content) || 'Percakapan baru' })
          .select('id,user_id,project_id,title,created_at,updated_at')
          .single();
        if (createError) throw createError;
        conversation = data;
        setConversations((current) => [data, ...current]);
        setActiveId(data.id);
      } else {
        const { error: updateError } = await supabase
          .from('ai_conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversation.id)
          .eq('user_id', user.id);
        if (updateError) throw updateError;
      }

      const { data: savedMessage, error: insertError } = await supabase
        .from('ai_messages')
        .insert({ conversation_id: conversation.id, user_id: user.id, role: 'user', content })
        .select('id,conversation_id,user_id,role,content,created_at')
        .single();
      if (insertError) throw insertError;

      setDraft('');
      setMessages((current) => [...current, savedMessage]);
      setConversations((current) => current.map((item) => item.id === conversation.id
        ? { ...item, title: item.title || shortTitle(content), updated_at: savedMessage.created_at }
        : item).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
    } catch (saveError) {
      console.error('Saving chat message failed:', saveError);
      setError('Pesan belum berhasil disimpan. Coba lagi sebentar.');
      await loadSidebarData();
    } finally {
      setSending(false);
    }
  }

  async function deleteConversation() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: deleteError } = await supabase.from('ai_conversations').delete().eq('id', deleteTarget.id).eq('user_id', user.id);
    if (deleteError) {
      console.error('Deleting conversation failed:', deleteError);
      setError('Percakapan belum berhasil dihapus. Coba lagi.');
    } else {
      if (activeId === deleteTarget.id) startNewConversation();
      setConversations((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    }
    setDeleting(false);
  }

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  function insertPrompt(prompt) {
    setDraft(prompt);
    draftRef.current?.focus();
  }

  return (
    <div className="studio-shell studio-ready">
      <aside className="studio-sidebar">
        <div className="studio-brand"><Brand /></div>
        <div className="studio-workspace"><span><Sparkles size={14} /></span><div><b>Ruang pribadi</b><small>AI Studio · Pratinjau</small></div></div>
        <button className="studio-new-chat" onClick={startNewConversation}><MessageSquarePlus size={15} /> Percakapan baru <Plus size={15} /></button>
        <nav className="studio-primary-nav" aria-label="Navigasi workspace"><Link to="/app"><Command size={15} /> Ringkasan</Link><Link to="/projects"><Layers3 size={15} /> Proyek</Link>{isAdmin && <Link to="/admin"><ShieldCheck size={15} /> Admin panel</Link>}</nav>
        <div className="studio-history-heading"><span>RIWAYAT</span><span>{conversations.length}</span></div>
        <div className="studio-history-list">
          {loadingHistory ? <div className="studio-history-loading">Memuat riwayat...</div> : conversations.length ? conversations.map((conversation) => <div key={conversation.id} className={`studio-history-item ${activeId === conversation.id ? 'active' : ''}`}><button className="studio-history-select" onClick={() => { setActiveId(conversation.id); setError(''); }}><span className="history-message-icon"><MessageSquarePlus size={14} /></span><span><b>{conversation.title}</b><small>{new Date(conversation.updated_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</small></span></button><button className="studio-history-delete" onClick={() => setDeleteTarget(conversation)} aria-label={`Hapus percakapan ${conversation.title}`}><Trash2 size={13} /></button></div>) : <p className="studio-history-empty">Percakapan yang kamu simpan akan muncul di sini.</p>}
        </div>
        <div className="studio-sidebar-bottom">
          <Link to="/settings"><Settings2 size={14} /> Pengaturan akun</Link>
          <button className="studio-profile-button" onClick={() => setProfileMenu(!profileMenu)} aria-expanded={profileMenu}><i>{initials}</i><span><b>{fullName}</b><small>{user?.email}</small></span><MoreHorizontal size={16} /></button>
          {profileMenu && <div className="studio-profile-menu"><div>{user?.email}</div><button onClick={signOut} disabled={signingOut}><LogOut size={13} /> {signingOut ? 'Keluar...' : 'Keluar akun'}</button></div>}
        </div>
      </aside>

      <main className="studio-main">
        <header className="studio-topbar"><div className="studio-breadcrumb"><span>BLEA AI</span><span>/</span><b>AI Studio</b>{activeConversation && <><span>/</span><b className="studio-current-title">{activeConversation.title}</b></>}</div><div className="studio-top-actions"><span className="preview-status"><i /> MODE PRATINJAU · MODEL BELUM TERHUBUNG</span><Link to="/app" aria-label="Kembali ke dashboard"><ArrowUpRight size={15} /></Link></div></header>
        <div className="studio-content">
          <div className={`studio-conversation ${messages.length ? 'has-messages' : ''}`}>
            {messages.length === 0 && !loadingMessages ? <div className="studio-welcome"><div className="studio-welcome-icon"><WandSparkles size={22} /></div><span className="studio-eyebrow">BLEA AI STUDIO</span><h1>{activeConversation ? 'Lanjutkan idemu.' : <>Satu ruang untuk<br /><em>pikiran besarmu.</em></>}</h1><p>Catat prompt dan ide di sini. Riwayat tersimpan di akunmu; respons AI akan aktif setelah provider model dipilih.</p><div className="studio-prompt-chips">{prompts.map((prompt) => <button key={prompt} onClick={() => insertPrompt(prompt)}>{prompt}<ArrowUpRight size={13} /></button>)}</div></div> : <div className="studio-message-list">{loadingMessages && <div className="studio-message-loading">Memuat percakapan...</div>}{messages.map((message) => <article className={`studio-message ${message.role === 'user' ? 'from-user' : 'from-assistant'}`} key={message.id}><span className="studio-message-avatar">{message.role === 'user' ? initials.slice(0, 1) : <Sparkles size={13} />}</span><div className="studio-message-body"><div className="studio-message-meta"><b>{message.role === 'user' ? fullName : 'BLEA AI'}</b><time>{formatTime(message.created_at)}</time></div><p>{message.content}</p></div></article>)}<div ref={endOfMessages} /></div>}
          </div>
          {activeConversation && messages.length > 0 && <div className="studio-not-connected"><Sparkles size={14} /><span><b>Mode pratinjau.</b> Pesanmu tersimpan, tetapi AI belum membalas karena provider model belum dihubungkan.</span></div>}
          {error && <div className="studio-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Tutup pesan"><X size={13} /></button></div>}
          <div className="studio-composer-area">
            {!activeConversation && projects.length > 0 && <label className="studio-project-context"><FolderOpen size={14} /><span>Tambahkan ke proyek</span><select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}><option value="">Tanpa proyek</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={12} /></label>}
            {activeConversation?.project_id && <div className="studio-context-pill"><FolderOpen size={13} /> {projects.find((project) => project.id === activeConversation.project_id)?.name || 'Proyek terkait'}</div>}
            <form className="studio-composer" onSubmit={saveMessage}><textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Tulis ide atau prompt untuk disimpan..." rows={1} maxLength={20000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label="Tulis pesan" /><div className="studio-composer-bottom"><span><Sparkles size={12} /> Mode pratinjau — pesan disimpan, jawaban AI belum aktif</span><button type="submit" disabled={!draft.trim() || sending} aria-label="Simpan pesan">{sending ? <span className="studio-send-loader" /> : <><span>Simpan</span><Send size={14} /></>}</button></div></form>
            <div className="studio-privacy-note"><ShieldCheck size={12} /> Riwayat hanya dapat diakses oleh akunmu. <Link to="/projects">Kelola proyek <ArrowRight size={11} /></Link></div>
          </div>
        </div>
      </main>

      {deleteTarget && <div className="studio-modal-backdrop"><section className="studio-delete-modal" role="dialog" aria-modal="true" aria-labelledby="studio-delete-title"><span className="studio-delete-icon"><Trash2 size={18} /></span><h2 id="studio-delete-title">Hapus percakapan?</h2><p>“{deleteTarget.title}” dan seluruh riwayat pesan di dalamnya akan dihapus.</p><div><button className="studio-cancel-button" onClick={() => setDeleteTarget(null)}>Batal</button><button className="studio-delete-confirm" onClick={deleteConversation} disabled={deleting}>{deleting ? 'Menghapus...' : 'Hapus percakapan'}</button></div></section></div>}
    </div>
  );
}
