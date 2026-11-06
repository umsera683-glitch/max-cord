'use strict';
(function () {
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function loadUserId() {
    try {
      let id = localStorage.getItem('sh_userid');
      if (!id) { id = 'u_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('sh_userid', id); }
      return id;
    } catch (_) { return 'u_' + Math.random().toString(36).slice(2); }
  }
  function loadName() { try { return localStorage.getItem('sh_username') || ''; } catch (_) { return ''; } }
  function loadPhoto() { try { return localStorage.getItem('sh_photo') || ''; } catch (_) { return ''; } }
  async function compress(file) {
    if (window.compressImageFile) return window.compressImageFile(file, 400000, 256);
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  async function ask(title, placeholder, def) {
    if (window.mcPrompt) return window.mcPrompt(title, placeholder, def);
    return prompt(title + (placeholder ? '\n' + placeholder : ''), def || '');
  }
  async function confirmIn(title, msg) {
    if (window.mcConfirm) return window.mcConfirm(title, msg);
    return confirm(msg || title);
  }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'info'); }
  function beep(kind) { if (window.playNotifySound) window.playNotifySound(kind || 'join'); }

  const myUserId = loadUserId();
  let servers = [], online = [];
  let mode = 'dms', activeServerId = null, activeChannelId = null, activeChannelType = null;
  let activeDmPeerId = null, inviteCode = null, seen = new Set(), mounted = false;

  const voicePcs = new Map(), voicePendingIce = new Map(), voiceVolumes = new Map();
  let voiceLocal = null, voiceCam = null, voiceScreen = null, voiceChannelId = null;
  let voiceMicOn = true, voiceCamOn = false, voiceScreenOn = false, voicePeopleMuted = false;
  let voiceQuality = localStorage.getItem('mc_voice_quality') || 'medium';
  const SOFT = 0.82;
  // Mesmos STUN/TURN do app principal — sem TURN muitos desktops/NATs falham
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
  const QUALITY = {
    high: { width: 1280, height: 720, frameRate: 30, bitrate: 1800000 },
    medium: { width: 960, height: 540, frameRate: 24, bitrate: 1000000 },
    low: { width: 640, height: 360, frameRate: 15, bitrate: 500000 }
  };

  function sock() { return window.socket || null; }
  function ensureSocket(cb) {
    if (typeof window.connectSocket === 'function') window.connectSocket().then(() => cb(sock())).catch(() => cb(sock()));
    else cb(sock());
  }

  function mountUI() {
    const root = $('community-view');
    if (!root || mounted) return;
    mounted = true;
    root.innerHTML = `
<style>
.community-view{position:fixed;inset:0;z-index:90;background:#0a0a12;color:#e8e8f0}
.cv-layout{display:grid;grid-template-columns:72px 260px 1fr 220px;height:100%}
.cv-rail{background:#05050a;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 0;border-right:1px solid rgba(255,255,255,.06);overflow:auto}
.cv-btn{width:48px;height:48px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:#141422;color:#fff;font-weight:800;cursor:pointer;display:grid;place-items:center;overflow:hidden;padding:0}
.cv-btn.active{background:linear-gradient(135deg,#7c3aed,#4f46e5);border-color:transparent}
.cv-btn img{width:100%;height:100%;object-fit:cover}
.cv-side{background:#0e0e18;border-right:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;min-width:0}
.cv-side-h{padding:14px 12px;border-bottom:1px solid rgba(255,255,255,.06)}
.cv-side-title{font-weight:800;font-size:15px;cursor:pointer}
.cv-side-title:hover{color:#c4b5fd}
.cv-sub{font-size:11px;color:#6b7280;margin-top:2px}
.cv-search{width:100%;margin-top:10px;background:#151522;border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#fff;padding:10px 12px;font-size:13px;outline:none}
.cv-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.cv-mini{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);color:#ddd;border-radius:8px;padding:7px 10px;font-size:11px;font-weight:700;cursor:pointer}
.cv-list{flex:1;overflow:auto;padding:8px}
.cv-sec{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;padding:10px 8px 6px}
.cv-item{display:flex;gap:8px;align-items:center;padding:10px;border-radius:10px;cursor:pointer;color:#b8b8c8;font-size:13px;border:1px solid transparent;min-height:42px}
.cv-item:hover,.cv-item.active{background:rgba(124,58,237,.18);border-color:rgba(124,58,237,.3);color:#fff}
.cv-item.in-voice{color:#86efac}
.cv-main{display:flex;flex-direction:column;min-width:0;background:#0a0a12}
.cv-head{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.06);min-height:56px}
.cv-msgs{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
.cv-empty{margin:auto;color:#6b7280;text-align:center;padding:28px;max-width:340px;line-height:1.45}
.cv-msg{display:grid;grid-template-columns:42px 1fr;gap:12px}
.cv-av{width:42px;height:42px;border-radius:12px;background:#1c1c2e;display:grid;place-items:center;font-weight:800;overflow:hidden}
.cv-av img{width:100%;height:100%;object-fit:cover}
.cv-input-row{display:flex;gap:8px;padding:12px 16px 16px;border-top:1px solid rgba(255,255,255,.06)}
.cv-input{flex:1;background:#151522;border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;padding:14px 16px;font-size:14px;outline:none}
.cv-members{background:#0e0e18;border-left:1px solid rgba(255,255,255,.06);padding:14px 10px;overflow:auto}
.cv-voice{flex:1;display:flex;flex-direction:column;min-height:0}
.cv-voice-grid{flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:16px;overflow:auto;align-content:start}
.cv-tile{position:relative;background:#12121e;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;min-height:170px}
.cv-tile.is-speaking{box-shadow:0 0 0 2px #22c55e,0 0 20px rgba(34,197,94,.25)}
.cv-tile video{width:100%;height:150px;object-fit:cover;background:#000;display:block}
.cv-tile .fallback{height:150px;display:grid;place-items:center;background:linear-gradient(135deg,#1a1a2e,#12121e)}
.cv-tile .fallback .big-av{width:72px;height:72px;border-radius:18px;overflow:hidden;display:grid;place-items:center;font-size:28px;font-weight:800;background:#2a2a40}
.cv-tile .fallback .big-av img{width:100%;height:100%;object-fit:cover}
.cv-tile-meta{padding:8px 10px;display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700}
.cv-tile-meta .mic-ind{width:22px;height:22px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.06);font-size:12px}
.cv-tile.is-speaking .mic-ind{background:#22c55e;color:#052e16}
.cv-voice-bar{display:flex;justify-content:center;align-items:center;gap:10px;padding:14px;border-top:1px solid rgba(255,255,255,.06);background:#0c0c14;flex-wrap:wrap}
.cv-vbtn{width:48px;height:48px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:#181826;cursor:pointer;font-size:18px}
.cv-vbtn.active{background:#6d28d9;border-color:#6d28d9}
.cv-vbtn.danger{background:#7f1d1d}
.cv-qsel{background:#151522;border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:10px;padding:10px;font-size:12px}
.cv-modal{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px}
.cv-modal.hidden{display:none!important}
.cv-modal-box{background:#12121e;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:20px;width:min(92vw,400px)}
.cv-modal-box h3{margin:0 0 12px;font-size:18px}
.cv-modal-box input,.cv-modal-box select{width:100%;margin:0 0 10px;background:#151522;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#fff;padding:12px}
.cv-modal-actions{display:flex;gap:8px;margin-top:8px}
.cv-modal-actions button{flex:1;padding:12px;border-radius:10px;border:none;font-weight:700;cursor:pointer}
.cv-btn-primary{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff}
.cv-btn-secondary{background:rgba(255,255,255,.08);color:#ddd}
@media(max-width:900px){.cv-layout{grid-template-columns:56px 1fr}.cv-members{display:none}.cv-side{display:none}}
</style>
<div class="cv-layout">
  <aside class="cv-rail">
    <button type="button" class="cv-btn" id="cv-home" title="Início">⌂</button>
    <button type="button" class="cv-btn active" id="cv-dms" title="DMs">DM</button>
    <div style="width:28px;height:2px;background:rgba(255,255,255,.08)"></div>
    <div id="cv-servers"></div>
    <button type="button" class="cv-btn" id="cv-add-server" title="Criar servidor">＋</button>
  </aside>
  <aside class="cv-side">
    <div class="cv-side-h">
      <div class="cv-side-title" id="cv-side-title">Mensagens diretas</div>
      <div class="cv-sub" id="cv-side-sub">Pesquise ou escolha alguém</div>
      <input class="cv-search" id="cv-search" placeholder="Pesquisar usuário..." maxlength="40">
      <div class="cv-actions" id="cv-side-actions"></div>
    </div>
    <div class="cv-list" id="cv-channels"></div>
  </aside>
  <main class="cv-main">
    <div class="cv-head">
      <span id="cv-main-title" style="font-weight:800">Mensagens diretas</span>
      <button type="button" class="cv-mini hidden" id="cv-invite">🔗 Convite</button>
    </div>
    <div id="cv-text" style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div class="cv-msgs" id="cv-messages"><div class="cv-empty">Escolha um canal ou pesquise alguém para DM.</div></div>
      <div class="cv-input-row">
        <input class="cv-input" id="cv-input" placeholder="Mensagem..." maxlength="1000" disabled>
        <button type="button" class="cv-mini" id="cv-send" disabled>Enviar</button>
      </div>
    </div>
    <div id="cv-voice" class="cv-voice" style="display:none">
      <div class="cv-voice-grid" id="cv-voice-grid"><div class="cv-empty">Canal de voz</div></div>
      <div class="cv-voice-bar">
        <button type="button" class="cv-vbtn active" id="cv-mic" title="Microfone">🎤</button>
        <button type="button" class="cv-vbtn" id="cv-cam" title="Câmera">📷</button>
        <button type="button" class="cv-vbtn" id="cv-screen" title="Tela">🖥️</button>
        <button type="button" class="cv-vbtn" id="cv-noise" title="Supressão de ruídos">🎧</button>
        <button type="button" class="cv-vbtn" id="cv-people-mute" title="Silenciar pessoas">🔇</button>
        <select class="cv-qsel" id="cv-quality"><option value="high">Alta</option><option value="medium" selected>Média</option><option value="low">Baixa</option></select>
        <button type="button" class="cv-vbtn danger" id="cv-leave-voice" title="Sair">⏏</button>
      </div>
    </div>
  </main>
  <aside class="cv-members">
    <div class="cv-sub" style="margin-bottom:8px">Online — <span id="cv-online-count">0</span></div>
    <div id="cv-online"></div>
  </aside>
</div>
<div class="cv-modal hidden" id="cv-server-settings">
  <div class="cv-modal-box">
    <h3>Configurações do servidor</h3>
    <input id="cv-set-name" placeholder="Nome do servidor" maxlength="40">
    <input id="cv-set-icon" placeholder="Emoji / iniciais" maxlength="4">
    <input id="cv-set-icon-url" placeholder="URL da imagem (opcional)" maxlength="2000">
    <label style="font-size:12px;color:#9ca3af;display:block;margin-bottom:6px">Ou envie imagem/GIF (será otimizada)</label>
    <input type="file" id="cv-set-icon-file" accept="image/*,.gif" style="margin-bottom:10px;color:#aaa;font-size:12px">
    <div class="cv-modal-actions">
      <button type="button" class="cv-btn-secondary" id="cv-set-cancel">Cancelar</button>
      <button type="button" class="cv-btn-primary" id="cv-set-save">Salvar</button>
    </div>
  </div>
</div>
<div class="cv-modal hidden" id="cv-create-server">
  <div class="cv-modal-box">
    <h3>Criar servidor</h3>
    <input id="cv-create-name" placeholder="Nome do servidor" maxlength="40">
    <label style="font-size:12px;color:#9ca3af;display:block;margin-bottom:6px">Imagem do servidor (opcional)</label>
    <input type="file" id="cv-create-icon-file" accept="image/*,.gif" style="margin-bottom:10px;color:#aaa;font-size:12px">
    <input id="cv-create-icon-url" type="hidden">
    <div class="cv-modal-actions">
      <button type="button" class="cv-btn-secondary" id="cv-create-cancel">Cancelar</button>
      <button type="button" class="cv-btn-primary" id="cv-create-ok">Criar</button>
    </div>
  </div>
</div>`;

    on($('cv-home'), 'click', closeCommunity);
    on($('cv-dms'), 'click', openDms);
    on($('cv-add-server'), 'click', () => { $('cv-create-name').value = ''; $('cv-create-icon-url').value = ''; $('cv-create-server').classList.remove('hidden'); setTimeout(() => $('cv-create-name').focus(), 30); });
    on($('cv-create-cancel'), 'click', () => $('cv-create-server').classList.add('hidden'));
    on($('cv-create-ok'), 'click', createServerFromModal);
    on($('cv-create-icon-file'), 'change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const data = await compress(file);
        $('cv-create-icon-url').value = data;
        toast('Imagem pronta', 'success');
      } catch (_) { toast('Falha ao processar imagem', 'error'); }
    });
    on($('cv-send'), 'click', sendMessage);
    on($('cv-input'), 'keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } });
    on($('cv-search'), 'input', onSearch);
    on($('cv-mic'), 'click', toggleMic);
    on($('cv-cam'), 'click', toggleCam);
    on($('cv-screen'), 'click', toggleScreen);
    on($('cv-noise'), 'click', () => {
      if (window.NoiseSuppression) window.NoiseSuppression.toggle();
      updateNoiseBtn();
    });
    on($('cv-people-mute'), 'click', togglePeopleMute);
    on($('cv-leave-voice'), 'click', () => { leaveVoice(true); showText(); $('cv-main-title').textContent = 'Selecione um canal'; });
    on($('cv-invite'), 'click', copyInvite);
    on($('cv-side-title'), 'click', openServerSettings);
    on($('cv-set-cancel'), 'click', () => $('cv-server-settings').classList.add('hidden'));
    on($('cv-set-save'), 'click', saveServerSettings);
    on($('cv-set-icon-file'), 'change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const data = await compress(file);
        $('cv-set-icon-url').value = data;
        toast('Imagem otimizada', 'success');
      } catch (_) { toast('Falha ao processar imagem', 'error'); }
    });
    on($('cv-quality'), 'change', (e) => {
      voiceQuality = e.target.value;
      try { localStorage.setItem('mc_voice_quality', voiceQuality); } catch (_) {}
      applyVoiceQuality();
    });
    if ($('cv-quality')) $('cv-quality').value = voiceQuality;
    updateNoiseBtn();
    window.addEventListener('mc-noise-toggle', updateNoiseBtn);
  }

  function updateNoiseBtn() {
    const btn = $('cv-noise');
    if (!btn) return;
    const onN = window.NoiseSuppression ? window.NoiseSuppression.isEnabled() : true;
    btn.classList.toggle('active', !!onN);
    btn.title = onN ? 'Supressão de ruídos ativa' : 'Supressão desativada';
  }

  function openCommunity() {
    try {
      mountUI();
      const root = $('community-view');
      root.classList.remove('hidden');
      root.style.display = 'block';
      const lobby = $('lobby-view');
      if (lobby) lobby.classList.add('hidden');
      $('tab-community') && $('tab-community').classList.add('active');
      $('tab-stream') && $('tab-stream').classList.remove('active');
      ensureSocket((s) => { bindSocket(s); register(); });
    } catch (e) { console.error(e); toast('Erro ao abrir comunidade', 'error'); }
  }
  function closeCommunity() {
    const root = $('community-view');
    if (root) { root.classList.add('hidden'); root.style.display = 'none'; }
    const lobby = $('lobby-view');
    if (lobby) lobby.classList.remove('hidden');
    $('tab-stream') && $('tab-stream').classList.add('active');
    $('tab-community') && $('tab-community').classList.remove('active');
  }

  function register() {
    const s = sock();
    if (!s || !s.connected) return;
    s.emit('community-register', { userId: myUserId, name: loadName() || 'Anônimo', photoUrl: loadPhoto() || '' }, (res) => {
      if (!res || !res.success) return;
      servers = res.servers || [];
      online = res.online || [];
      s.emit('community-list-servers', (list) => {
        if (list && list.servers) {
          const map = new Map(servers.map(x => [x.id, x]));
          list.servers.forEach(x => map.set(x.id, x));
          servers = Array.from(map.values());
        }
        if (list && list.online) online = list.online;
        renderServers(); renderOnline(); openDms();
        try {
          const inv = new URLSearchParams(location.search).get('invite');
          if (inv) joinInvite(inv);
        } catch (_) {}
      });
    });
  }

  function bindSocket(s) {
    if (!s || s.__cvBound3) return;
    s.__cvBound3 = true;
    s.on('community-online', (d) => { online = (d && d.users) || []; renderOnline(); });
    s.on('community-channel-message', (d) => {
      if (mode === 'server' && d.serverId === activeServerId && d.channelId === activeChannelId) {
        appendMsg(d.message);
        if (d.message && d.message.userId !== myUserId) beep('message');
      }
    });
    s.on('community-dm-message', (d) => {
      if (mode === 'dms' && activeDmPeerId && d.message) {
        const m = d.message;
        if (m.fromId === activeDmPeerId || m.toId === activeDmPeerId || d.peerId === activeDmPeerId) {
          appendMsg(m);
          if (m.fromId !== myUserId) beep('message');
        }
      }
    });
    s.on('community-server-deleted', (d) => {
      servers = servers.filter(x => x.id !== d.serverId);
      if (activeServerId === d.serverId) { leaveVoice(true); openDms(); }
      renderServers();
    });
    s.on('community-server-updated', (d) => {
      if (!d || !d.server) return;
      const i = servers.findIndex(x => x.id === d.server.id);
      if (i >= 0) servers[i] = d.server; else servers.push(d.server);
      renderServers();
      if (activeServerId === d.server.id) $('cv-side-title').textContent = d.server.name;
    });
    s.on('community-channel-created', (d) => {
      const srv = servers.find(x => x.id === d.serverId);
      if (srv) {
        srv.channels = srv.channels || [];
        if (!srv.channels.some(c => c.id === d.channel.id)) srv.channels.push(d.channel);
        if (activeServerId === d.serverId) openServer(d.serverId);
      }
    });
    s.on('voice-user-joined', (d) => {
      if (!d || d.channelId !== voiceChannelId || !d.peer) return;
      beep('join');
      renderVoiceTile(d.peer.socketId, null, d.peer);
    });
    s.on('voice-user-left', (d) => {
      if (!d || d.channelId !== voiceChannelId) return;
      const pc = voicePcs.get(d.socketId);
      if (pc) { try { pc.close(); } catch (_) {} voicePcs.delete(d.socketId); }
      const el = document.getElementById('vtile-' + d.socketId);
      if (el) el.remove();
    });
    s.on('voice-state', (d) => {
      if (!d || d.channelId !== voiceChannelId) return;
      const tile = document.getElementById('vtile-' + d.socketId);
      if (tile) tile.classList.toggle('is-speaking', !!d.speaking && !d.muted);
    });
    s.on('voice-offer', async (d) => {
      if (!d || !d.fromId || !d.sdp || !voiceChannelId) return;
      const pc = await createPc(d.fromId, false);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        for (const c of (voicePendingIce.get(d.fromId) || [])) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {} }
        voicePendingIce.delete(d.fromId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        s.emit('voice-answer', { targetId: d.fromId, sdp: pc.localDescription });
      } catch (_) {}
    });
    s.on('voice-answer', async (d) => {
      const pc = voicePcs.get(d.fromId);
      if (!pc || !d.sdp) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        for (const c of (voicePendingIce.get(d.fromId) || [])) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {} }
        voicePendingIce.delete(d.fromId);
      } catch (_) {}
    });
    s.on('voice-ice', async (d) => {
      if (!d || !d.fromId || !d.candidate) return;
      const pc = voicePcs.get(d.fromId);
      if (!pc || !pc.remoteDescription) {
        if (!voicePendingIce.has(d.fromId)) voicePendingIce.set(d.fromId, []);
        voicePendingIce.get(d.fromId).push(d.candidate);
        return;
      }
      try { await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch (_) {}
    });
  }

  function createServerFromModal() {
    const name = ($('cv-create-name').value || '').trim();
    if (!name) return toast('Digite o nome do servidor', 'error');
    const iconUrl = ($('cv-create-icon-url').value || '').trim();
    $('cv-create-server').classList.add('hidden');
    ensureSocket((s) => {
      register();
      s.emit('community-create-server', { name, iconUrl }, (res) => {
        if (!res || !res.success) return toast((res && res.message) || 'Erro', 'error');
        if (!servers.some(x => x.id === res.server.id)) servers.push(res.server);
        renderServers(); openServer(res.server.id);
      });
    });
  }

  function renderServers() {
    const box = $('cv-servers');
    if (!box) return;
    box.innerHTML = '';
    servers.forEach(s => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cv-btn' + (activeServerId === s.id ? ' active' : '');
      b.title = s.name;
      if (s.iconUrl) b.innerHTML = `<img src="${esc(s.iconUrl)}" alt="" onerror="this.remove()">`;
      else b.textContent = (s.icon || s.name.slice(0, 2)).slice(0, 2);
      b.onclick = () => openServer(s.id);
      box.appendChild(b);
    });
  }
  function renderOnline() {
    const box = $('cv-online');
    const count = $('cv-online-count');
    if (count) count.textContent = String(online.length);
    if (!box) return;
    box.innerHTML = '';
    online.forEach(u => {
      const row = document.createElement('div');
      row.className = 'cv-item';
      const initial = (u.name || '?').slice(0, 1).toUpperCase();
      const av = u.photoUrl
        ? `<div class="cv-av"><img src="${esc(u.photoUrl)}" alt="" onerror="this.parentElement.textContent='${initial}'"></div>`
        : `<div class="cv-av">${initial}</div>`;
      row.innerHTML = `${av}<span>${esc(u.name)}</span>`;
      if (u.userId !== myUserId) row.onclick = () => openDm(u.userId, u.name);
      box.appendChild(row);
    });
  }

  function openDms() {
    mode = 'dms'; activeServerId = null; activeChannelId = null; activeChannelType = null; activeDmPeerId = null; inviteCode = null;
    $('cv-dms').classList.add('active');
    document.querySelectorAll('#cv-servers .cv-btn').forEach(b => b.classList.remove('active'));
    $('cv-side-title').textContent = 'Mensagens diretas';
    $('cv-side-sub').textContent = 'Pesquise ou escolha alguém';
    $('cv-side-actions').innerHTML = '';
    $('cv-invite').classList.add('hidden');
    const list = $('cv-channels');
    list.innerHTML = '';
    online.filter(u => u.userId !== myUserId).forEach(u => {
      const row = document.createElement('div');
      row.className = 'cv-item';
      row.innerHTML = `<span>💬</span><span>${esc(u.name)}</span>`;
      row.onclick = () => openDm(u.userId, u.name);
      list.appendChild(row);
    });
    showText();
    $('cv-main-title').textContent = 'Mensagens diretas';
    setInput(false);
    $('cv-messages').innerHTML = '<div class="cv-empty">Pesquise um usuário ou clique em alguém online para DM.</div>';
  }

  function onSearch() {
    const q = ($('cv-search').value || '').trim();
    const s = sock();
    if (!s || !q) return;
    s.emit('community-search-users', { query: q }, (res) => {
      const list = $('cv-channels');
      list.innerHTML = '';
      const users = (res && res.users) || [];
      if (!users.length) {
        list.innerHTML = '<div class="cv-empty" style="padding:8px;font-size:12px">Ninguém online com esse nome</div>';
        return;
      }
      users.filter(u => u.userId !== myUserId).forEach(u => {
        const row = document.createElement('div');
        row.className = 'cv-item';
        row.innerHTML = `<span>🔎</span><span>${esc(u.name)}</span>`;
        row.onclick = () => openDm(u.userId, u.name);
        list.appendChild(row);
      });
    });
  }

  function openServer(serverId) {
    const s = sock();
    if (!s) return;
    s.emit('community-join-server', { serverId }, (res) => {
      if (res && res.success && res.server) {
        const i = servers.findIndex(x => x.id === res.server.id);
        if (i >= 0) servers[i] = res.server; else servers.push(res.server);
      }
      const srv = servers.find(x => x.id === serverId);
      if (!srv) return;
      mode = 'server'; activeServerId = serverId; activeDmPeerId = null; inviteCode = srv.inviteCode || null;
      renderServers();
      $('cv-dms').classList.remove('active');
      $('cv-side-title').textContent = srv.name;
      $('cv-side-sub').textContent = (srv.memberCount || 1) + ' membros · clique no nome p/ config';
      const actions = $('cv-side-actions');
      actions.innerHTML = '';
      if (srv.ownerId === myUserId) {
        actions.innerHTML = `<button type="button" class="cv-mini" id="cv-add-ch">＋ Canal</button>
          <button type="button" class="cv-mini" id="cv-del-srv">🗑 Deletar</button>`;
        on($('cv-add-ch'), 'click', addChannelPrompt);
        on($('cv-del-srv'), 'click', async () => {
          if (!(await confirmIn('Deletar servidor', 'Tem certeza que deseja deletar este servidor?'))) return;
          s.emit('community-delete-server', { serverId }, (r) => {
            if (!r || !r.success) return toast((r && r.message) || 'Erro', 'error');
            servers = servers.filter(x => x.id !== serverId);
            leaveVoice(true); renderServers(); openDms();
          });
        });
      }
      if (inviteCode) $('cv-invite').classList.remove('hidden');
      else $('cv-invite').classList.add('hidden');
      const list = $('cv-channels');
      list.innerHTML = '<div class="cv-sec">Texto</div>';
      (srv.channels || []).filter(c => c.type !== 'voice').forEach(ch => {
        const row = document.createElement('div');
        row.className = 'cv-item' + (activeChannelId === ch.id ? ' active' : '');
        row.innerHTML = `<span>#</span><span>${esc(ch.name)}</span>`;
        row.onclick = () => openTextChannel(serverId, ch.id, ch.name);
        list.appendChild(row);
      });
      list.appendChild(Object.assign(document.createElement('div'), { className: 'cv-sec', textContent: 'Voz' }));
      (srv.channels || []).filter(c => c.type === 'voice').forEach(ch => {
        const row = document.createElement('div');
        const inHere = voiceChannelId === ch.id;
        row.className = 'cv-item' + (inHere ? ' in-voice active' : '');
        row.innerHTML = `<span>🔊</span><span>${esc(ch.name)}</span>${inHere ? '<span style="margin-left:auto;font-size:10px;color:#86efac">você</span>' : ''}`;
        row.onclick = () => joinVoice(serverId, ch.id, ch.name);
        list.appendChild(row);
      });
      if (voiceChannelId && (srv.channels || []).some(c => c.id === voiceChannelId)) showVoice();
      else {
        const first = (srv.channels || []).find(c => c.type !== 'voice');
        if (first) openTextChannel(serverId, first.id, first.name);
      }
    });
  }

  function openServerSettings() {
    if (mode !== 'server' || !activeServerId) return;
    const srv = servers.find(x => x.id === activeServerId);
    if (!srv || srv.ownerId !== myUserId) { toast('Só o dono configura o servidor', 'info'); return; }
    $('cv-set-name').value = srv.name || '';
    $('cv-set-icon').value = srv.icon || '';
    $('cv-set-icon-url').value = srv.iconUrl || '';
    $('cv-server-settings').classList.remove('hidden');
  }
  function saveServerSettings() {
    const s = sock();
    if (!s || !activeServerId) return;
    s.emit('community-update-server', {
      serverId: activeServerId,
      name: $('cv-set-name').value.trim(),
      icon: $('cv-set-icon').value.trim(),
      iconUrl: $('cv-set-icon-url').value.trim()
    }, (res) => {
      if (!res || !res.success) return toast((res && res.message) || 'Erro', 'error');
      $('cv-server-settings').classList.add('hidden');
      const i = servers.findIndex(x => x.id === res.server.id);
      if (i >= 0) servers[i] = res.server;
      renderServers();
      $('cv-side-title').textContent = res.server.name;
      toast('Servidor atualizado', 'success');
    });
  }

  function showText() { $('cv-text').style.display = 'flex'; $('cv-voice').style.display = 'none'; }
  function showVoice() { $('cv-text').style.display = 'none'; $('cv-voice').style.display = 'flex'; }
  function setInput(on) { $('cv-input').disabled = !on; $('cv-send').disabled = !on; }

  function openTextChannel(serverId, channelId, name) {
    mode = 'server'; activeServerId = serverId; activeChannelId = channelId; activeChannelType = 'text'; activeDmPeerId = null;
    $('cv-main-title').textContent = '# ' + name;
    showText(); setInput(true); seen = new Set();
    const s = sock();
    if (!s) return;
    s.emit('community-open-channel', { serverId, channelId }, (res) => {
      const box = $('cv-messages');
      box.innerHTML = '';
      if (!res || !res.success) { box.innerHTML = `<div class="cv-empty">${esc((res && res.message) || 'Erro')}</div>`; return; }
      (res.messages || []).forEach(appendMsg);
      box.scrollTop = box.scrollHeight;
    });
  }
  function openDm(peerId, peerName) {
    mode = 'dms'; activeDmPeerId = peerId; activeServerId = null; activeChannelId = null;
    $('cv-main-title').textContent = '@ ' + (peerName || 'usuário');
    showText(); setInput(true); seen = new Set();
    const s = sock();
    if (!s) return;
    s.emit('community-open-dm', { peerId }, (res) => {
      const box = $('cv-messages');
      box.innerHTML = '';
      if (!res || !res.success) { box.innerHTML = `<div class="cv-empty">${esc((res && res.message) || 'Erro')}</div>`; return; }
      (res.messages || []).forEach(appendMsg);
      box.scrollTop = box.scrollHeight;
    });
  }
  function appendMsg(m) {
    if (!m || (m.id && seen.has(m.id))) return;
    if (m.id) seen.add(m.id);
    const box = $('cv-messages');
    if (!box) return;
    const empty = box.querySelector('.cv-empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'cv-msg';
    const time = new Date(m.time || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const initial = (m.name || '?').slice(0, 1).toUpperCase();
    const av = m.photoUrl
      ? `<div class="cv-av"><img src="${esc(m.photoUrl)}" alt="" onerror="this.parentElement.textContent='${initial}'"></div>`
      : `<div class="cv-av">${initial}</div>`;
    div.innerHTML = `${av}<div><div style="display:flex;gap:8px;align-items:baseline"><strong>${esc(m.name || '')}</strong><span style="font-size:11px;color:#6b7280">${time}</span></div><div style="color:#d1d5db;line-height:1.45;word-break:break-word">${esc(m.text || '')}</div></div>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }
  function sendMessage() {
    const input = $('cv-input');
    if (!input || input.disabled) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const s = sock();
    if (!s) return;
    if (mode === 'server' && activeServerId && activeChannelId && activeChannelType === 'text') {
      s.emit('community-channel-message', { serverId: activeServerId, channelId: activeChannelId, text });
    } else if (mode === 'dms' && activeDmPeerId) {
      s.emit('community-dm-message', { peerId: activeDmPeerId, text });
    }
  }
  async function addChannelPrompt() {
    if (!activeServerId) return;
    const name = await ask('Nome do canal', 'ex: geral, jogos...');
    if (!name || !name.trim()) return;
    const isVoice = await confirmIn('Tipo de canal', 'OK = canal de VOZ\nCancelar = canal de TEXTO');
    const s = sock();
    s.emit('community-create-channel', { serverId: activeServerId, name: name.trim(), type: isVoice ? 'voice' : 'text' }, (res) => {
      if (!res || !res.success) return toast((res && res.message) || 'Erro', 'error');
      const srv = servers.find(x => x.id === activeServerId);
      if (srv) {
        srv.channels = srv.channels || [];
        if (!srv.channels.some(c => c.id === res.channel.id)) srv.channels.push(res.channel);
        openServer(activeServerId);
      }
    });
  }
  function copyInvite() {
    if (!inviteCode) return;
    const url = location.origin + location.pathname + '?invite=' + inviteCode;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => toast('Convite copiado!', 'success')).catch(() => toast(url, 'info'));
    } else toast(url, 'info');
  }
  function joinInvite(code) {
    const s = sock();
    if (!s) return;
    s.emit('community-join-invite', { code }, (res) => {
      if (!res || !res.success) return toast((res && res.message) || 'Convite inválido', 'error');
      if (!servers.some(x => x.id === res.server.id)) servers.push(res.server);
      else { const i = servers.findIndex(x => x.id === res.server.id); servers[i] = res.server; }
      renderServers(); openServer(res.server.id);
      try { const u = new URL(location.href); u.searchParams.delete('invite'); history.replaceState({}, '', u.pathname + u.search); } catch (_) {}
    });
  }

  async function ensureMic() {
    if (voiceLocal) return voiceLocal;
    const constraints = window.NoiseSuppression ? window.NoiseSuppression.getConstraints() : { audio: true, video: false };
    let raw = await navigator.mediaDevices.getUserMedia(constraints);
    if (window.NoiseSuppression && window.NoiseSuppression.isEnabled()) {
      try { raw = await window.NoiseSuppression.processStream(raw); } catch (_) {}
    }
    voiceLocal = raw;
    voiceMicOn = true;
    $('cv-mic').classList.add('active');
    return voiceLocal;
  }
  function outboundTracks() {
    const tracks = [];
    if (voiceLocal && voiceMicOn) voiceLocal.getAudioTracks().forEach(t => tracks.push(t));
    if (voiceCam && voiceCamOn) voiceCam.getVideoTracks().forEach(t => tracks.push(t));
    if (voiceScreen && voiceScreenOn) {
      voiceScreen.getVideoTracks().forEach(t => tracks.push(t));
      voiceScreen.getAudioTracks().forEach(t => tracks.push(t));
    }
    return tracks;
  }
  function renderVoiceTile(id, stream, meta) {
    const grid = $('cv-voice-grid');
    if (!grid) return;
    const empty = grid.querySelector('.cv-empty');
    if (empty) empty.remove();
    let tile = document.getElementById('vtile-' + id);
    const name = (meta && meta.name) || id.slice(0, 6);
    const photo = (meta && meta.photoUrl) || '';
    const initial = (name || '?').slice(0, 1).toUpperCase();
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'cv-tile';
      tile.id = 'vtile-' + id;
      tile.dataset.peer = id;
      tile.innerHTML = `<video autoplay playsinline ${id === (sock() && sock().id) ? 'muted' : ''}></video>
        <div class="fallback"><div class="big-av">${photo ? `<img src="${esc(photo)}" alt="" onerror="this.remove();this.parentElement.textContent='${initial}'">` : initial}</div></div>
        <div class="cv-tile-meta"><span>${esc(name)}</span><span class="mic-ind">🎤</span></div>`;
      grid.appendChild(tile);
      tile.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const video = tile.querySelector('video');
        const target = (video && video.style.display !== 'none') ? video : tile;
        const req = target.requestFullscreen || target.webkitRequestFullscreen;
        if (req) req.call(target).catch(() => {});
      });
      let lastTap = 0;
      tile.addEventListener('touchend', (e) => {
        const n = Date.now();
        if (n - lastTap < 280) {
          e.preventDefault();
          const video = tile.querySelector('video');
          const target = (video && video.style.display !== 'none') ? video : tile;
          const req = target.requestFullscreen || target.webkitRequestFullscreen;
          if (req) req.call(target).catch(() => {});
          lastTap = 0;
        } else lastTap = n;
      }, { passive: false });
    }
    const video = tile.querySelector('video');
    const fallback = tile.querySelector('.fallback');
    if (stream && video) {
      video.srcObject = stream;
      video.play && video.play().catch(() => {});
      const hasVideo = stream.getVideoTracks().some(t => t.readyState === 'live' && t.enabled);
      if (hasVideo) { video.style.display = 'block'; fallback.style.display = 'none'; }
      else { video.style.display = 'none'; fallback.style.display = 'grid'; }
      const vol = voiceVolumes.has(id) ? voiceVolumes.get(id) : 1;
      const isScreen = tile.dataset.hasScreen === '1';
      video.volume = (voicePeopleMuted && !isScreen) ? 0 : vol * SOFT;
      video.muted = id === (sock() && sock().id) || vol <= 0 || (voicePeopleMuted && !isScreen);
    }
  }
  async function createPc(remoteId, initiator) {
    if (voicePcs.has(remoteId)) return voicePcs.get(remoteId);
    const s = sock();
    const pc = new RTCPeerConnection({ iceServers });
    voicePcs.set(remoteId, pc);
    pc.onicecandidate = (ev) => { if (ev.candidate) s.emit('voice-ice', { targetId: remoteId, candidate: ev.candidate }); };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      renderVoiceTile(remoteId, stream, { name: remoteId.slice(0, 6) });
    };
    try { await ensureMic(); } catch (_) {}
    outboundTracks().forEach(t => { try { pc.addTrack(t, new MediaStream([t])); } catch (_) {} });
    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        s.emit('voice-offer', { targetId: remoteId, sdp: pc.localDescription });
      } catch (_) {}
    }
    return pc;
  }
  async function applyVoiceQuality() {
    const q = QUALITY[voiceQuality] || QUALITY.medium;
    const tracks = [];
    if (voiceCam) tracks.push(...voiceCam.getVideoTracks());
    if (voiceScreen) tracks.push(...voiceScreen.getVideoTracks());
    for (const t of tracks) {
      try { await t.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } }); } catch (_) {}
    }
    for (const [, pc] of voicePcs) {
      for (const sender of pc.getSenders()) {
        if (!sender.track || sender.track.kind !== 'video') continue;
        try {
          const params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = q.bitrate;
          params.encodings[0].maxFramerate = q.frameRate;
          await sender.setParameters(params);
        } catch (_) {}
      }
    }
  }
  async function joinVoice(serverId, channelId, name) {
    if (voiceChannelId === channelId) {
      activeServerId = serverId;
      $('cv-main-title').textContent = '🔊 ' + name;
      showVoice();
      return;
    }
    activeServerId = serverId; activeChannelId = channelId; activeChannelType = 'voice';
    $('cv-main-title').textContent = '🔊 ' + name;
    showVoice(); setInput(false);
    try { await ensureMic(); } catch (_) { toast('Microfone necessário', 'error'); return; }
    const s = sock();
    s.emit('voice-join', { serverId, channelId, muted: !voiceMicOn }, async (res) => {
      if (!res || !res.success) return toast((res && res.message) || 'Erro na call', 'error');
      voiceChannelId = channelId;
      const grid = $('cv-voice-grid');
      grid.innerHTML = '';
      renderVoiceTile(s.id, new MediaStream(outboundTracks()), { name: loadName() || 'Você', photoUrl: loadPhoto() });
      for (const p of (res.peers || [])) {
        renderVoiceTile(p.socketId, null, p);
        await createPc(p.socketId, true);
      }
      if (activeServerId) openServer(activeServerId);
    });
  }
  function leaveVoice(explicit) {
    if (!explicit && voiceChannelId) return;
    const s = sock();
    if (s && s.connected) s.emit('voice-leave');
    for (const pc of voicePcs.values()) { try { pc.close(); } catch (_) {} }
    voicePcs.clear(); voicePendingIce.clear();
    voiceChannelId = null;
    if (voiceCam) { voiceCam.getTracks().forEach(t => t.stop()); voiceCam = null; voiceCamOn = false; }
    if (voiceScreen) { voiceScreen.getTracks().forEach(t => t.stop()); voiceScreen = null; voiceScreenOn = false; }
    $('cv-cam') && $('cv-cam').classList.remove('active');
    $('cv-screen') && $('cv-screen').classList.remove('active');
    const grid = $('cv-voice-grid');
    if (grid) grid.innerHTML = '<div class="cv-empty">Você saiu do canal de voz.</div>';
    if (activeServerId) openServer(activeServerId);
  }
  async function toggleMic() {
    try { await ensureMic(); } catch (_) { return; }
    voiceMicOn = !voiceMicOn;
    voiceLocal.getAudioTracks().forEach(t => { t.enabled = voiceMicOn; });
    $('cv-mic').classList.toggle('active', voiceMicOn);
    const s = sock(); if (s) s.emit('voice-state', { muted: !voiceMicOn });
  }
  async function toggleCam() {
    if (voiceCamOn) {
      if (voiceCam) voiceCam.getTracks().forEach(t => t.stop());
      voiceCam = null; voiceCamOn = false; $('cv-cam').classList.remove('active');
      const s = sock(); if (s) s.emit('voice-state', { camera: false });
      return;
    }
    try {
      const q = QUALITY[voiceQuality] || QUALITY.medium;
      voiceCam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } }, audio: false });
      voiceCamOn = true; $('cv-cam').classList.add('active');
      for (const [id, pc] of voicePcs) {
        voiceCam.getVideoTracks().forEach(t => { try { pc.addTrack(t, voiceCam); } catch (_) {} });
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sock().emit('voice-offer', { targetId: id, sdp: pc.localDescription });
        } catch (_) {}
      }
      const sid = sock() && sock().id;
      if (sid) renderVoiceTile(sid, new MediaStream(outboundTracks()), { name: loadName() || 'Você', photoUrl: loadPhoto() });
      await applyVoiceQuality();
      const s = sock(); if (s) s.emit('voice-state', { camera: true });
    } catch (_) { toast('Câmera indisponível', 'error'); }
  }
  async function toggleScreen() {
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) { toast('Tela desativada no celular por enquanto', 'info'); return; }
    if (voiceScreenOn) {
      if (voiceScreen) voiceScreen.getTracks().forEach(t => t.stop());
      voiceScreen = null; voiceScreenOn = false; $('cv-screen').classList.remove('active');
      const s = sock(); if (s) s.emit('voice-state', { screen: false });
      return;
    }
    try {
      voiceScreen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      voiceScreenOn = true; $('cv-screen').classList.add('active');
      voiceScreen.getVideoTracks()[0].onended = () => {
        voiceScreen = null; voiceScreenOn = false; $('cv-screen').classList.remove('active');
        const s = sock(); if (s) s.emit('voice-state', { screen: false });
      };
      for (const [id, pc] of voicePcs) {
        voiceScreen.getTracks().forEach(t => { try { pc.addTrack(t, voiceScreen); } catch (_) {} });
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sock().emit('voice-offer', { targetId: id, sdp: pc.localDescription });
        } catch (_) {}
      }
      const sid = sock() && sock().id;
      if (sid) {
        const tile = document.getElementById('vtile-' + sid);
        if (tile) tile.dataset.hasScreen = '1';
        renderVoiceTile(sid, new MediaStream(outboundTracks()), { name: loadName() || 'Você', photoUrl: loadPhoto(), screen: true });
      }
      await applyVoiceQuality();
      const s = sock(); if (s) s.emit('voice-state', { screen: true });
    } catch (_) {}
  }
  function togglePeopleMute() {
    voicePeopleMuted = !voicePeopleMuted;
    $('cv-people-mute').classList.toggle('active', voicePeopleMuted);
    document.querySelectorAll('.cv-tile video').forEach(v => {
      const tile = v.closest('.cv-tile');
      const id = tile && tile.dataset.peer;
      const vol = id && voiceVolumes.has(id) ? voiceVolumes.get(id) : 1;
      const isScreen = tile && tile.dataset.hasScreen === '1';
      v.volume = (voicePeopleMuted && !isScreen) ? 0 : vol * SOFT;
      v.muted = vol <= 0 || (voicePeopleMuted && !isScreen) || (id === (sock() && sock().id));
    });
    toast(voicePeopleMuted ? 'Pessoas silenciadas (telas continuam)' : 'Áudio das pessoas ativado', 'info');
  }

  // ==================== HWD / Acesso restrito à aba Comunidade ====================
  // Só o PC do dono (desbloqueado uma vez) consegue abrir. Demais dispositivos: aba bloqueada.
  // Criar/entrar em sala NÃO depende disso — funciona para todos.

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function getHardwareId() {
    try {
      const parts = [
        navigator.platform || '',
        navigator.hardwareConcurrency || '',
        navigator.deviceMemory || '',
        navigator.language || '',
        (screen && screen.width) || '',
        (screen && screen.height) || '',
        (screen && screen.colorDepth) || '',
        Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        navigator.maxTouchPoints || 0
      ];
      try {
        const c = document.createElement('canvas');
        c.width = 200; c.height = 50;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.textBaseline = 'top';
          ctx.font = '14px Arial';
          ctx.fillStyle = '#f60';
          ctx.fillRect(0, 0, 200, 50);
          ctx.fillStyle = '#069';
          ctx.fillText('MaxCord-HWD', 4, 12);
          ctx.fillStyle = 'rgba(102,204,0,0.7)';
          ctx.fillText('MaxCord-HWD', 6, 28);
          parts.push(c.toDataURL().slice(-48));
        }
      } catch (_) {}
      try {
        const cgl = document.createElement('canvas');
        const gl = cgl.getContext('webgl') || cgl.getContext('experimental-webgl');
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) parts.push(String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''));
        }
      } catch (_) {}
      return 'hwd_' + simpleHash(parts.join('|'));
    } catch (_) {
      return 'hwd_unknown';
    }
  }

  function persistOwnerUnlock(hwd) {
    try {
      localStorage.setItem('mc_community_unlocked', '1');
      localStorage.setItem('mc_allowed_hwds', hwd);
      localStorage.setItem('mc_owner_hwd', hwd);
    } catch (_) {}
  }

  function isCommunityAllowed() {
    const hwd = getHardwareId();
    try {
      const unlocked = localStorage.getItem('mc_community_unlocked');
      if (unlocked === '1' || unlocked === hwd) return true;
      const ownerHwd = localStorage.getItem('mc_owner_hwd');
      if (ownerHwd && ownerHwd === hwd) return true;
      const allowed = (localStorage.getItem('mc_allowed_hwds') || '').split(',').filter(Boolean);
      if (allowed.includes(hwd)) return true;
    } catch (_) {}
    // URL secreta: ?unlock_community=maxcord-owner  (libera neste PC para sempre)
    try {
      const params = new URLSearchParams(location.search);
      const code = params.get('unlock_community');
      if (code === 'maxcord-owner' || code === 'exibido') {
        persistOwnerUnlock(hwd);
        try {
          const u = new URL(location.href);
          u.searchParams.delete('unlock_community');
          history.replaceState({}, '', u.pathname + u.search + u.hash);
        } catch (_) {}
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function tryOwnerUnlockPrompt() {
    const code = await ask(
      'Comunidade — acesso do administrador',
      'Digite o código de dono para liberar neste PC',
      ''
    );
    if (!code) return false;
    const ok = String(code).trim().toLowerCase() === 'maxcord-owner' ||
               String(code).trim().toLowerCase() === 'exibido';
    if (ok) {
      persistOwnerUnlock(getHardwareId());
      toast('Comunidade liberada neste PC', 'success');
      return true;
    }
    toast('Código incorreto', 'error');
    return false;
  }

  function lockCommunityTab() {
    const tab = $('tab-community');
    if (!tab) return;
    tab.classList.add('lobby-tab-locked');
    tab.setAttribute('aria-disabled', 'true');
    tab.title = 'Comunidade — apenas o PC do administrador';
    const clone = tab.cloneNode(true);
    tab.parentNode.replaceChild(clone, tab);
    clone.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Clique na aba bloqueada → pede código do dono (só libera neste navegador/PC)
      const ok = await tryOwnerUnlockPrompt();
      if (ok) {
        unlockCommunityTab();
        on($('tab-community'), 'click', (ev) => { ev.preventDefault(); openCommunity(); });
        openCommunity();
      } else {
        toast('Aba Comunidade bloqueada neste dispositivo', 'info');
      }
    });
  }

  function unlockCommunityTab() {
    const tab = $('tab-community');
    if (!tab) return;
    tab.classList.remove('lobby-tab-locked');
    tab.removeAttribute('aria-disabled');
    tab.title = 'Comunidade';
  }

  function boot() {
    const allowed = isCommunityAllowed();
    if (allowed) {
      unlockCommunityTab();
      on($('tab-community'), 'click', (e) => { e.preventDefault(); openCommunity(); });
      try { if (new URLSearchParams(location.search).get('invite')) openCommunity(); } catch (_) {}
    } else {
      lockCommunityTab();
    }
    on($('tab-stream'), 'click', (e) => { e.preventDefault(); closeCommunity(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
