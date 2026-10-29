'use strict';
// =====================================================================
//  MaxCord — app.js
//  Mesh WebRTC com negociação perfeita (um offer por par) para
//  várias pessoas transmitirem tela ao mesmo tempo sem tela preta.
// =====================================================================

// ==================== ESTADO GLOBAL ====================

let socket = null;

let myId = null;
let myName = '';
let isOwner = false;

let currentRoomId = null;
let roomName = '';

let screenStream = null;
let cameraStream = null;
let micStream = null;

// Track de áudio que realmente enviamos aos peers (tela + mic mesclado, só tela, ou só mic).
// Quem entra depois PRECISA receber este mesmo track — getMicAudioTrack() sozinho não basta.
let outboundAudioTrack = null;
let outboundAudioStream = null; // mantém referência viva (merge/tela)

let isScreenSharing = false;
let isCameraOn = false;
let isMicOn = false;
let isAudioMuted = false;
let noiseSuppressionOn = true;   // supressão de ruído ligada por padrão
let currentFacingMode = 'user';  // câmera frontal por padrão
let streamQuality = 'high';      // qualidade padrão
let pendingStreamType = null;    // 'screen' | 'camera' — aguardando modal de qualidade

// Presets de qualidade da transmissão (definidos cedo para uso em getDisplayMedia / câmera)
const QUALITY_PRESETS = {
  high:   { width: 1920, height: 1080, frameRate: 30, bitrate: 2500000 },
  medium: { width: 1280, height: 720,  frameRate: 30, bitrate: 1200000 },
  low:    { width: 854,  height: 480,  frameRate: 15, bitrate:  500000 }
};

// Estado do chat
let chatUnread = 0;
let chatOpen = false;

// peerId -> { pc, streams, makingOffer, ignoreOffer, polite }
const peers = new Map();
const pendingIce = new Map();
let socketListenersBound = false;
let lastJoinPassword = '';
let screenShareBusy = false;

// id -> { name, isOwner, isBroadcasting, broadcastType, hasMic, micMuted }
const participants = new Map();

// tileId -> element
const tiles = new Map();

// Volume por peer (0–1 UI). Soft-max evita estouro. Persistido por apelido.
const peerVolumes = new Map();
const VOLUME_SOFT_MAX = 0.82;
let tileContextMenuEl = null;
function peerVolumeStorageKey(peerId) {
  const p = participants.get(peerId);
  const name = p && p.name ? String(p.name).trim().toLowerCase() : '';
  return name ? ('mc_peer_vol_v1_' + name) : null;
}
function loadSavedPeerVolume(peerId) {
  const key = peerVolumeStorageKey(peerId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return null;
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  } catch (_) {}
  return null;
}
function savePeerVolume(peerId, vol) {
  const key = peerVolumeStorageKey(peerId);
  if (!key) return;
  try { localStorage.setItem(key, String(vol)); } catch (_) {}
}
function uiVolToElement(vol) {
  return Math.max(0, Math.min(1, (Number(vol) || 0) * VOLUME_SOFT_MAX));
}

// Canvas compositor
let compositeCanvas = null;
let compositeCtx = null;
let compositeStream = null;
let compScreenEl = null;
let compCameraEl = null;
let compRAF = null;

// ==================== ICE CONFIG ====================
// STUN: descobre o IP público do usuário
// TURN: retransmite o mídia quando conexão direta falha (NAT/firewall)
// Múltiplos STUN + Open Relay (gratuito) para maximizar chance de conexão em qualquer rede/navegador

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

function shouldOffer(peerId) {
  const me = myId || (socket && socket.id) || '';
  return !!(me && peerId && me < peerId);
}

// ==================== UTILITÁRIOS ====================

function nameInitial(name) { return (name || '?').charAt(0).toUpperCase(); }

function nameColor(name) {
  const colors = ['#7c3aed','#2563eb','#0891b2','#059669','#d97706','#dc2626','#db2777','#0d9488'];
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return colors[h % colors.length];
}

function showToast(msg, type) {
  type = type || 'info';
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 3200);
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 640;
}

// Desbloqueia autoplay de áudio/vídeo após primeiro gesto do usuário (política de browsers desktop)
let audioUnlocked = false;
function unlockAudioPlayback() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    document.querySelectorAll('audio, video').forEach(el => {
      if (el.paused) el.play().catch(() => {});
    });
    if (typeof noiseCtx !== 'undefined' && noiseCtx && noiseCtx.state === 'suspended') {
      noiseCtx.resume().catch(() => {});
    }
    if (window._mergeAudioCtx && window._mergeAudioCtx.state === 'suspended') {
      window._mergeAudioCtx.resume().catch(() => {});
    }
  } catch (_) {}
}
['click', 'touchstart', 'keydown'].forEach(ev => {
  document.addEventListener(ev, unlockAudioPlayback, { once: true, passive: true });
});

function supportsScreenShare() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function saveName(n) { try { localStorage.setItem('sh_username', n); } catch (_) {} }
function loadName()  { try { return localStorage.getItem('sh_username') || ''; } catch (_) { return ''; } }
function savePhoto(url) { try { localStorage.setItem('sh_photo', url); } catch (_) {} }
function loadPhoto()    { try { return localStorage.getItem('sh_photo') || ''; } catch (_) { return ''; } }

/** HTML seguro do avatar (foto/GIF ou inicial). Usado em lista, chat e tiles. */
function avatarHtml(name, photoUrl, sizeClass) {
  const col = nameColor(name || '?');
  const init = nameInitial(name || '?');
  const cls = sizeClass || 'avatar-sm';
  if (photoUrl && typeof photoUrl === 'string' && photoUrl.length > 10) {
    // Escapa aspas no src para não quebrar o HTML
    const safeSrc = photoUrl.replace(/"/g, '&quot;');
    return `<div class="avatar ${cls}" style="background:transparent;padding:0;overflow:hidden">
      <img src="${safeSrc}" alt="${init}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block"
        onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,${col},${col}88)';this.parentElement.textContent='${init}';">
    </div>`;
  }
  return `<div class="avatar ${cls}" style="background:linear-gradient(135deg,${col},${col}88)">${init}</div>`;
}
function loadUserId() {
  try {
    let id = localStorage.getItem('sh_userid');
    if (!id) { id = 'u_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('sh_userid', id); }
    return id;
  } catch (_) { return 'u_' + Math.random().toString(36).slice(2); }
}
/** Comprime imagem/GIF para caber no socket (~400KB). GIF animado só se já for pequeno. */
function compressImageFile(file, maxBytes, maxDim) {
  maxBytes = maxBytes || 400000; maxDim = maxDim || 256;
  return new Promise((resolve, reject) => {
    if (file.type === 'image/gif' && file.size <= maxBytes) {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
      return;
    }
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h || 1));
        w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        let q = 0.9, data = canvas.toDataURL('image/jpeg', q);
        while (data.length > maxBytes && q > 0.35) { q -= 0.08; data = canvas.toDataURL('image/jpeg', q); }
        resolve(data);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
window.compressImageFile = compressImageFile;

/** Modal interno do site (substitui prompt/alert nativos) */
function mcPrompt(title, placeholder, defaultValue) {
  return new Promise((resolve) => {
    const old = document.getElementById('mc-site-modal');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'mc-site-modal';
    wrap.innerHTML = `<div class="mc-modal-backdrop"><div class="mc-modal-box" role="dialog">
      <h3 class="mc-modal-title"></h3>
      <input class="mc-modal-input" maxlength="80" />
      <div class="mc-modal-actions">
        <button type="button" class="mc-modal-cancel">Cancelar</button>
        <button type="button" class="mc-modal-ok">OK</button>
      </div>
    </div></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.mc-modal-title').textContent = title || 'Digite';
    const input = wrap.querySelector('.mc-modal-input');
    input.placeholder = placeholder || '';
    input.value = defaultValue || '';
    const close = (val) => { wrap.remove(); resolve(val); };
    wrap.querySelector('.mc-modal-cancel').onclick = () => close(null);
    wrap.querySelector('.mc-modal-ok').onclick = () => close(input.value);
    wrap.querySelector('.mc-modal-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) close(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      if (e.key === 'Escape') close(null);
    });
    setTimeout(() => input.focus(), 30);
  });
}
function mcConfirm(title, message) {
  return new Promise((resolve) => {
    const old = document.getElementById('mc-site-modal');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'mc-site-modal';
    wrap.innerHTML = `<div class="mc-modal-backdrop"><div class="mc-modal-box" role="dialog">
      <h3 class="mc-modal-title"></h3>
      <p class="mc-modal-msg"></p>
      <div class="mc-modal-actions">
        <button type="button" class="mc-modal-cancel">Cancelar</button>
        <button type="button" class="mc-modal-ok">OK</button>
      </div>
    </div></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.mc-modal-title').textContent = title || 'Confirmar';
    wrap.querySelector('.mc-modal-msg').textContent = message || '';
    const close = (val) => { wrap.remove(); resolve(val); };
    wrap.querySelector('.mc-modal-cancel').onclick = () => close(false);
    wrap.querySelector('.mc-modal-ok').onclick = () => close(true);
    wrap.querySelector('.mc-modal-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) close(false); });
  });
}
window.mcPrompt = mcPrompt;
window.mcConfirm = mcConfirm;

/** Som curto de notificação (join / mensagem) */
function playNotifySound(kind) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = kind === 'message' ? 880 : 660;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.start(t); o.stop(t + 0.2);
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 300);
  } catch (_) {}
}
window.playNotifySound = playNotifySound;


// ==================== SOCKET ====================

function getSocketUrl() {
  try {
    if (window.SOCKET_URL) return window.SOCKET_URL;
  } catch (_) {}
  return location.origin;
}

function connectSocket() {
  window.connectSocket = connectSocket;
  return new Promise((resolve) => {
    // Já conectado
    if (socket && socket.connected) {
      window.socket = socket;
      myId = socket.id;
      return resolve(true);
    }

    const url = getSocketUrl();

    // Cria o socket uma única vez (ou recria se estiver destruído)
    if (!socket) {
      socket = io(url, {
        // polling primeiro = mais estável no Render / proxies
        transports: ['polling', 'websocket'],
        upgrade: true,
        reconnection: true,
        reconnectionAttempts: 15,
        reconnectionDelay: 700,
        reconnectionDelayMax: 4000,
        timeout: 15000,
        autoConnect: true,
        forceNew: false
      });
      socketListenersBound = false;
      setupSocketListeners();
      setupChatListeners();
      window.socket = socket;
    } else if (!socket.connected) {
      // Tenta reconectar o socket existente
      try { socket.connect(); } catch (_) {}
    }

    if (socket.connected) {
      myId = socket.id;
      window.socket = socket;
      return resolve(true);
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.off('connect', onOk);
        socket.off('connect_error', onErr);
      } catch (_) {}
      resolve(!!ok);
    };

    const onOk = () => {
      myId = socket.id;
      window.socket = socket;
      finish(true);
    };
    const onErr = (err) => {
      console.warn('Socket connect_error:', err && err.message, 'url=', url);
    };

    socket.on('connect', onOk);
    socket.on('connect_error', onErr);

    // Aviso de hibernação do Render
    const wakeToast = setTimeout(() => {
      if (!settled && socket && !socket.connected) {
        showToast('Servidor iniciando... isso pode levar até 30s', 'info');
      }
    }, 3000);

    // Timeout final
    setTimeout(() => {
      clearTimeout(wakeToast);
      if (socket && socket.connected) finish(true);
      else {
        console.warn('Socket timeout:', url);
        finish(false);
      }
    }, 30000);
  });
}

/** Emite evento com callback e timeout (não trava em "Conectando...") */
function emitWithAck(event, data, timeoutMs) {
  timeoutMs = timeoutMs || 12000;
  return new Promise((resolve) => {
    if (!socket || !socket.connected) {
      resolve({ success: false, message: 'Sem conexão com o servidor.' });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ success: false, message: 'Servidor demorou para responder. Tente de novo.' });
    }, timeoutMs);
    try {
      socket.emit(event, data, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res || { success: false, message: 'Resposta vazia do servidor.' });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ success: false, message: 'Erro ao enviar: ' + (err && err.message) });
    }
  });
}

function safePhotoForEmit() {
  try {
    const p = loadPhoto();
    if (!p) return '';
    if (p.length > 450000) return ''; // evita travar o socket com foto gigante
    return p;
  } catch (_) { return ''; }
}

// ==================== LISTENERS DO SOCKET ====================

function setupSocketListeners() {
  if (!socket || socketListenersBound) return;
  socketListenersBound = true;

  socket.on('user-joined', (data) => {
    if (!data || !data.id || data.id === myId) return;
    // Garante myId atualizado
    if (socket && socket.id) myId = socket.id;
    participants.set(data.id, {
      name: data.name || 'Usuário',
      isOwner: !!data.isOwner,
      isBroadcasting: !!data.isBroadcasting,
      broadcastType: data.broadcastType || null,
      hasMic: !!data.hasMic,
      micMuted: data.micMuted !== false,
      photoUrl: data.photoUrl || ''
    });
    updateParticipantCount();
    renderParticipantsList();
    showToast(`${data.name || 'Alguém'} entrou na sala`, 'info');

    // Mesh bidirecional imediato + reforços
    ensureMeshWith(data.id);
    setTimeout(() => ensureMeshWith(data.id), 400);
    setTimeout(() => ensureMeshWith(data.id), 1500);
  });

  socket.on('user-left', (data) => {
    participants.delete(data.id);
    closePeer(data.id);
    removeTilesByPeer(data.id);
    updateParticipantCount();
    renderParticipantsList();
    showToast(`${data.name} saiu da sala`, 'info');
  });

  socket.on('stream-started', (data) => {
    const p = participants.get(data.id);
    if (p) { p.isBroadcasting = true; p.broadcastType = data.type; }
    renderParticipantsList();
  });

  socket.on('stream-stopped', (data) => {
    const p = participants.get(data.id);
    if (p) { p.isBroadcasting = false; p.broadcastType = null; }
    removeVideoTile(data.id);
    renderParticipantsList();
  });

  socket.on('mic-update', (data) => {
    const p = participants.get(data.id);
    if (p) { p.hasMic = data.hasMic; p.micMuted = data.micMuted; }
    renderParticipantsList();
    if (!data.hasMic) removeMicTile(data.id);
  });

  socket.on('room-deleted', (data) => {
    showToast(data.message, 'error');
    setTimeout(() => leaveRoom(false), 1500);
  });

  // Receber foto de perfil de outro participante
  socket.on('photo-share', (data) => {
    if (!data || !data.id) return;
    const p = participants.get(data.id);
    if (p && data.photoUrl) {
      p.photoUrl = data.photoUrl;
      renderParticipantsList();
      // Atualiza avatar nos tiles de vídeo/mic se já existirem
      const vTile = document.getElementById(data.id + '-video');
      if (vTile) {
        const type = p.broadcastType || 'screen';
        updateTileLabel(vTile, p.name, type, data.photoUrl);
      }
      const mTile = document.getElementById(data.id + '-mic');
      if (mTile) {
        const col = nameColor(p.name);
        const micAv = mTile.querySelector('.mic-avatar');
        if (micAv && data.photoUrl) {
          const safe = String(data.photoUrl).replace(/"/g, '&quot;');
          micAv.style.background = 'transparent';
          micAv.style.padding = '0';
          micAv.style.overflow = 'hidden';
          micAv.innerHTML = `<img src="${safe}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block"
            onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,${col},${col}88)';this.parentElement.textContent='🎙️';">`;
        }
      }
    }
  });

  // Atualização da lista de salas em tempo real (enviada pelo servidor)
  socket.on('room-list-update', (data) => {
    // Só atualiza se o usuário estiver no lobby (não dentro de uma sala)
    if (!currentRoomId) {
      renderRoomsList(data.rooms);
    }
  });

  socket.on('request-peer', ({ fromId }) => {
    if (fromId && fromId !== myId) {
      ensureMeshWith(fromId);
      setTimeout(() => ensureMeshWith(fromId), 300);
    }
  });

  // Lista oficial da sala — todos ficam com os mesmos participantes
  socket.on('room-sync', (data) => {
    if (!data || !Array.isArray(data.participants)) return;
    // Aceita sync se já estamos na sala OU se o roomId bate com o que acabamos de entrar
    const rid = data.roomId ? String(data.roomId).toUpperCase() : null;
    if (rid && currentRoomId && rid !== String(currentRoomId).toUpperCase()) return;
    // Se ainda não setamos currentRoomId mas o sync chegou (race do join), aplica mesmo assim
    // e marca a sala para não perder a lista
    if (!currentRoomId && rid) {
      currentRoomId = rid;
    }
    if (socket && socket.id) myId = socket.id;

    participants.clear();
    (data.participants || []).forEach(p => {
      if (!p || !p.id) return;
      participants.set(p.id, {
        name: p.name || 'Usuário',
        isOwner: !!p.isOwner,
        isBroadcasting: !!p.isBroadcasting,
        broadcastType: p.broadcastType || null,
        hasMic: !!p.hasMic,
        micMuted: p.micMuted !== false,
        photoUrl: p.photoUrl || ''
      });
    });
    updateParticipantCount();
    renderParticipantsList();

    // Conecta mesh com TODOS os outros (não só os novos)
    for (const [pid] of participants) {
      if (!pid || pid === myId) continue;
      ensureMeshWith(pid);
    }
    // Reforço após estabilizar signaling
    setTimeout(() => {
      for (const [pid] of participants) {
        if (!pid || pid === myId) continue;
        ensureMeshWith(pid);
      }
    }, 800);
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io client disconnect') return;
    // Não mostrar toast imediato — reconexão automática acontece em background
    // Só avisar se demorar mais de 3s sem reconectar
    const warnTimer = setTimeout(() => {
      if (!socket.connected) showToast('Conexão perdida. Reconectando...', 'error');
    }, 3000);
    socket.once('connect', () => clearTimeout(warnTimer));
  });

  socket.on('connect', () => {
    const previousId = myId;
    myId = socket.id;
    if (currentRoomId && previousId && previousId !== myId) {
      rejoinAfterReconnect();
    }
  });

  socket.on('offer',         async ({ fromId, sdp })       => handleOffer(fromId, sdp));
  socket.on('answer',        async ({ fromId, sdp })       => handleAnswer(fromId, sdp));
  socket.on('ice-candidate', async ({ fromId, candidate }) => handleIceCandidate(fromId, candidate));
}

// ==================== PEER CONNECTIONS ====================

function getPeerEntry(peerId) {
  if (!peers.has(peerId)) {
    peers.set(peerId, {
      pc: null,
      streams: new Map(),
      makingOffer: false,
      ignoreOffer: false
    });
  }
  return peers.get(peerId);
}

function pcIsUsable(pc) {
  if (!pc) return false;
  const cs = pc.connectionState;
  return cs !== 'closed' && cs !== 'failed' && pc.signalingState !== 'closed';
}

/**
 * Garante conexão mesh com um peer: cria PC se necessário, pede sinalização
 * e injeta tracks locais (mic/câmera/tela) para os dois lados se ouvirem e se verem.
 */
function ensureMeshWith(peerId) {
  if (!peerId || peerId === myId) return;
  if (socket && socket.id) myId = socket.id;
  if (peerId === myId) return;

  const pc = connectToPeer(peerId);
  if (socket) {
    try { socket.emit('request-peer', { targetId: peerId }); } catch (_) {}
  }
  if (!pc) return;

  addLocalTracksToPeer(pc);
  const outA = getOutboundAudioTrack();
  if (outA) replaceAudioTrackInPeer(pc, outA);
  const outV = getCurrentVideoTrack();
  if (outV) replaceVideoTrackInPeer(pc, outV);

  // Se somos o offerer e a conexão está estável, força offer para estabelecer canais
  const entry = peers.get(peerId);
  if (entry && entry.pc && shouldOffer(peerId) && entry.pc.signalingState === 'stable' && !entry.makingOffer) {
    try {
      entry.makingOffer = true;
      entry.pc.createOffer()
        .then(offer => entry.pc.setLocalDescription(offer))
        .then(() => {
          if (socket && entry.pc.localDescription) {
            socket.emit('offer', { targetId: peerId, sdp: entry.pc.localDescription });
          }
        })
        .catch(() => {})
        .finally(() => { entry.makingOffer = false; });
    } catch (_) {
      entry.makingOffer = false;
    }
  }
}

function connectToPeer(peerId) {
  if (!peerId || peerId === myId) return null;
  if (socket && socket.id && !myId) myId = socket.id;
  if (peerId === myId) return null;
  const entry = getPeerEntry(peerId);
  if (pcIsUsable(entry.pc)) {
    addLocalTracksToPeer(entry.pc);
    return entry.pc;
  }
  return createPeerConnection(peerId);
}

function createPeerConnection(peerId) {
  const entry = getPeerEntry(peerId);
  if (entry.pc) { try { entry.pc.close(); } catch (_) {} }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  entry.pc = pc;
  entry.makingOffer = false;
  entry.ignoreOffer = false;

  // DataChannel força negociação mesmo sem câmera/mic (mesh sempre ativo)
  try {
    if (shouldOffer(peerId)) {
      entry._dc = pc.createDataChannel('mesh', { ordered: true });
    } else {
      pc.ondatachannel = (ev) => { entry._dc = ev.channel; };
    }
  } catch (_) {}

  pc.onicecandidate = (e) => {
    if (e.candidate && socket) {
      socket.emit('ice-candidate', { targetId: peerId, candidate: e.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      try { pc.restartIce(); } catch (_) {}
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'connected') {
      // Quando a conexão estabiliza, reenvia tracks locais.
      // Corrige: quem entra depois não ouve quem já estava transmitindo.
      setTimeout(() => {
        if (peers.get(peerId) && peers.get(peerId).pc === pc) {
          addLocalTracksToPeer(pc);
        }
      }, 200);
    }
    if (state === 'failed') {
      try { pc.restartIce(); } catch (_) {}
      setTimeout(() => {
        if (peers.get(peerId) && peers.get(peerId).pc === pc && pc.connectionState === 'failed') {
          createPeerConnection(peerId);
        }
      }, 1500);
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      if (pc.signalingState !== 'stable') return;
      entry.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      if (socket) socket.emit('offer', { targetId: peerId, sdp: pc.localDescription });
    } catch (err) {
      if (!String(err && err.message).includes('InvalidStateError')) {
        console.error('onnegotiationneeded:', err);
      }
    } finally {
      entry.makingOffer = false;
    }
  };

  pc.ontrack = (e) => handleRemoteTrack(peerId, e);

  addLocalTracksToPeer(pc);
  return pc;
}

function addLocalTracksToPeer(pc) {
  if (!pc || !pcIsUsable(pc)) return;
  const videoTrack = getCurrentVideoTrack();
  // Usa o áudio da transmissão (tela/sistema), não só o microfone
  const audioTrack = getOutboundAudioTrack();
  if (!videoTrack && !audioTrack) return;

  const ls = new MediaStream();
  if (videoTrack) ls.addTrack(videoTrack);
  if (audioTrack) ls.addTrack(audioTrack);

  ls.getTracks().forEach(track => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
    if (sender) {
      if (sender.track !== track) {
        sender.replaceTrack(track).catch(err => console.error('replaceTrack:', err));
      }
    } else {
      try {
        pc.addTrack(track, ls);
      } catch (err) {
        console.error('addTrack:', err);
      }
    }
    if (track.kind === 'video') {
      const vs = pc.getSenders().find(s => s.track === track || (s.track && s.track.kind === 'video'));
      if (vs) optimizeVideoSender(vs);
    }
  });
}

function replaceVideoTrackInPeer(pc, newTrack) {
  const senders = pc.getSenders();
  const sender = senders.find(s => s.track && s.track.kind === 'video');
  if (sender) {
    sender.replaceTrack(newTrack).then(() => optimizeVideoSender(sender)).catch(err => console.error('replaceVideoTrack:', err));
    return;
  }
  const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
  const ls = new MediaStream([newTrack]);
  if (audioSender && audioSender.track) ls.addTrack(audioSender.track);
  const added = pc.addTrack(newTrack, ls);
  optimizeVideoSender(added);
}

function replaceAudioTrackInPeer(pc, newTrack) {
  const senders = pc.getSenders();
  const as = senders.find(s => s.track && s.track.kind === 'audio');
  if (as) {
    as.replaceTrack(newTrack).catch(err => console.error('replaceAudioTrack:', err));
  } else {
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    const ls = new MediaStream([newTrack]);
    if (videoSender && videoSender.track) ls.addTrack(videoSender.track);
    pc.addTrack(newTrack, ls);
  }
}

async function optimizeVideoSender(sender) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const n = Math.max(1, peers.size);
    const isScreen = isScreenSharing;
    const q = QUALITY_PRESETS[streamQuality] || QUALITY_PRESETS.high;
    const baseBitrate = q.bitrate;
    const peerScale = Math.max(0.5, 1 / Math.sqrt(n));
    // scaleResolutionDownBy: browsers respeitam de forma confiável (1 = full, 2 = metade)
    let down = 1;
    if (streamQuality === 'medium') down = isScreen ? 1.5 : 1.25;
    if (streamQuality === 'low') down = isScreen ? 2.5 : 2;
    params.encodings[0].scaleResolutionDownBy = down;
    params.encodings[0].maxBitrate = Math.round(baseBitrate * peerScale);
    params.encodings[0].maxFramerate = q.frameRate;
    params.degradationPreference = isScreen ? 'maintain-resolution' : 'balanced';
    await sender.setParameters(params);
  } catch (_) {}
}

async function handleOffer(fromId, sdp) {
  if (!fromId || fromId === myId || !sdp) return;
  const pc = connectToPeer(fromId);
  const entry = getPeerEntry(fromId);
  const polite = !shouldOffer(fromId);

  try {
    const offerCollision = entry.makingOffer || pc.signalingState !== 'stable';
    entry.ignoreOffer = !polite && offerCollision;
    if (entry.ignoreOffer) return;

    if (offerCollision && pc.signalingState === 'have-local-offer') {
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch (_) {}
    }

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    flushIce(fromId, pc);
    addLocalTracksToPeer(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.emit('answer', { targetId: fromId, sdp: pc.localDescription });
  } catch (err) {
    console.error('handleOffer:', err);
  }
}

async function handleAnswer(fromId, sdp) {
  const entry = peers.get(fromId);
  if (!entry || !entry.pc || !sdp) return;
  if (entry.pc.signalingState !== 'have-local-offer') return;
  try {
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    flushIce(fromId, entry.pc);
  } catch (err) {
    console.error('handleAnswer:', err);
  }
}

async function handleIceCandidate(fromId, candidate) {
  const entry = peers.get(fromId);
  if (entry && entry.pc && entry.pc.remoteDescription) {
    try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  } else {
    if (!pendingIce.has(fromId)) pendingIce.set(fromId, []);
    pendingIce.get(fromId).push(candidate);
  }
}

function flushIce(peerId, pc) {
  const list = pendingIce.get(peerId);
  if (list) { list.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); pendingIce.delete(peerId); }
}

function closePeer(peerId) {
  const entry = peers.get(peerId);
  if (entry && entry.pc) { try { entry.pc.close(); } catch (_) {} }
  peers.delete(peerId);
  pendingIce.delete(peerId);
  removeRemoteAudioElement(peerId);
  peerVolumes.delete(peerId);
}

// ==================== TRACKS REMOTOS ====================

function handleRemoteTrack(peerId, event) {
  if (!event || !event.track) return;
  if (peerId === myId) return;

  const entry = getPeerEntry(peerId);
  let stream = event.streams && event.streams[0];
  if (!stream) {
    stream = entry.streams.get('remote') || new MediaStream();
    if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
    entry.streams.set('remote', stream);
  } else {
    entry.streams.set(stream.id, stream);
    // Garantir track no stream canônico do peer
    const canonical = entry.streams.get('remote') || new MediaStream();
    if (!canonical.getTracks().includes(event.track)) {
      try { canonical.addTrack(event.track); } catch (_) {}
    }
    entry.streams.set('remote', canonical);
  }

  event.track.addEventListener('unmute', () => {
    if (event.track.kind === 'video') upsertVideoTile(peerId, stream);
    if (event.track.kind === 'audio') ensureRemoteAudioElement(peerId, stream);
  });
  event.track.addEventListener('ended', () => {
    if (event.track.kind === 'video' && !stream.getVideoTracks().some(t => t.readyState === 'live')) {
      removeVideoTile(peerId);
    }
  });

  if (event.track.kind === 'video') {
    upsertVideoTile(peerId, stream);
  } else if (event.track.kind === 'audio') {
    // Sempre manter um <audio> dedicado — garante que quem entra depois ouça
    ensureRemoteAudioElement(peerId, stream);

    // Também tentar anexar ao tile de vídeo (quando existir)
    const videoTile = document.getElementById(`${peerId}-video`);
    if (videoTile) {
      const video = videoTile.querySelector('video');
      if (video) {
        if (video.srcObject && video.srcObject !== stream) {
          try {
            video.srcObject.addTrack(event.track);
          } catch (_) {
            if (stream.getVideoTracks().length > 0) {
              bindVideoPlayback(video, stream, peerId);
            }
          }
        } else if (!video.srcObject) {
          bindVideoPlayback(video, stream, peerId);
        }
        applyPeerVolume(peerId);
        if (!isAudioMuted && !isPeerMuted(peerId)) {
          video.muted = false;
          video.play().catch(() => {});
        }
        return;
      }
    }
    // Sem tile de vídeo — criar tile de áudio puro
    const p = participants.get(peerId);
    upsertAudioTile(peerId, stream, p ? p.name : 'Remoto');
  }
}

/** Áudio remoto dedicado (invisível). Resolve bug de quem entra com transmissão já ativa. */
function ensureRemoteAudioElement(peerId, stream) {
  if (!peerId || peerId === myId || !stream) return;
  let audio = document.getElementById(`remote-audio-${peerId}`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = `remote-audio-${peerId}`;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.style.display = 'none';
    document.body.appendChild(audio);
  }
  // Preferir stream com o track de áudio atual
  const audioTracks = stream.getAudioTracks().filter(t => t.readyState === 'live');
  if (audioTracks.length) {
    const ms = new MediaStream(audioTracks);
    if (audio.srcObject !== ms) audio.srcObject = ms;
  } else if (audio.srcObject !== stream) {
    audio.srcObject = stream;
  }
  applyPeerVolume(peerId);
  // Tenta play; se autoplay bloqueado, unlockAudioPlayback vai retentar no próximo gesto
  const p = audio.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // Marca para retentar quando o usuário interagir
      if (!audioUnlocked) {
        const retry = () => { audio.play().catch(() => {}); };
        document.addEventListener('click', retry, { once: true });
        document.addEventListener('touchstart', retry, { once: true });
      }
    });
  }
}

function removeRemoteAudioElement(peerId) {
  const audio = document.getElementById(`remote-audio-${peerId}`);
  if (audio) {
    try { audio.srcObject = null; } catch (_) {}
    audio.remove();
  }
}

function isPeerMuted(peerId) {
  const v = peerVolumes.get(peerId);
  return v !== undefined && v <= 0;
}

function getPeerVolume(peerId) {
  if (peerVolumes.has(peerId)) return peerVolumes.get(peerId);
  const saved = loadSavedPeerVolume(peerId);
  if (saved !== null) { peerVolumes.set(peerId, saved); return saved; }
  return 1;
}
function setPeerVolume(peerId, vol) {
  vol = Math.max(0, Math.min(1, Number(vol) || 0));
  peerVolumes.set(peerId, vol);
  savePeerVolume(peerId, vol);
  applyPeerVolume(peerId);
}
function applyPeerVolume(peerId) {
  const vol = getPeerVolume(peerId);
  const mutedGlobally = isAudioMuted;
  const effectiveMuted = mutedGlobally || vol <= 0;
  const effectiveVol = mutedGlobally ? 0 : uiVolToElement(vol);

  const videoTile = document.getElementById(`${peerId}-video`);
  if (videoTile) {
    const video = videoTile.querySelector('video');
    if (video) {
      video.volume = effectiveVol;
      // Não forçar muted se o usuário só baixou o volume (vol > 0)
      if (effectiveMuted) video.muted = true;
      else if (!mutedGlobally) video.muted = false;
    }
  }
  const micTile = document.getElementById(`${peerId}-mic`);
  if (micTile) {
    const a = micTile.querySelector('audio');
    if (a) {
      a.volume = effectiveVol;
      a.muted = effectiveMuted;
    }
  }
  const remoteAudio = document.getElementById(`remote-audio-${peerId}`);
  if (remoteAudio) {
    remoteAudio.volume = effectiveVol;
    remoteAudio.muted = effectiveMuted;
    if (!effectiveMuted) remoteAudio.play().catch(() => {});
  }
  // Indicador visual no tile
  updateVolumeIndicator(peerId, vol);
}

function updateVolumeIndicator(peerId, vol) {
  const tile = document.getElementById(`${peerId}-video`) || document.getElementById(`${peerId}-mic`);
  if (!tile) return;
  let badge = tile.querySelector('.tile-vol-badge');
  if (vol >= 0.99) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'tile-vol-badge';
    tile.appendChild(badge);
  }
  badge.textContent = vol <= 0 ? '🔇' : `🔊 ${Math.round(vol * 100)}%`;
}

// ==================== TILES ====================

function revealVideoEl(video) {
  if (!video) return;
  video.style.opacity = '1';
  video.style.transition = 'opacity 0.25s ease';
  const tile = video.closest('.stream-tile');
  const loader = tile && tile.querySelector('.tile-loader');
  if (loader) loader.style.display = 'none';
}

function bindVideoPlayback(video, stream, peerId) {
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');

  const isSelf = peerId === myId;
  const reveal = () => revealVideoEl(video);

  video.addEventListener('loadedmetadata', reveal, { once: true });
  video.addEventListener('loadeddata',     reveal, { once: true });
  video.addEventListener('playing',        reveal, { once: true });

  // Quando novo track chega (áudio depois do vídeo)
  stream.addEventListener('addtrack', (ev) => {
    if (isSelf) return;
    if (ev.track && ev.track.kind === 'audio') {
      ensureRemoteAudioElement(peerId, stream);
    }
    if (!isAudioMuted && !isPeerMuted(peerId)) {
      tryUnmuteVideo(video, peerId);
    }
    applyPeerVolume(peerId);
  });

  // Self sempre mudo; remoto depende do mute global e volume por peer
  if (isSelf) {
    video.muted = true;
  } else {
    const vol = getPeerVolume(peerId);
    video.volume = isAudioMuted ? 0 : uiVolToElement(vol);
    video.muted = isAudioMuted || vol <= 0;
    // Áudio dedicado reforça a escuta (especialmente quem entra depois)
    if (stream.getAudioTracks().length) {
      ensureRemoteAudioElement(peerId, stream);
    }
  }

  video.play()
    .then(() => {
      reveal();
      hideMutePrompt(video);
    })
    .catch(() => {
      video.muted = true;
      video.play().then(() => {
        reveal();
        if (!isSelf && !isAudioMuted && !isPeerMuted(peerId)) {
          showMutePrompt(video, peerId);
        }
      }).catch(() => {});
    });

  setTimeout(() => { if (video.style.opacity !== '1') reveal(); }, 2500);
}

// Mostra overlay "🔊 Clique para ouvir" no tile
function showMutePrompt(video, peerId) {
  const tile = video.closest('.stream-tile');
  if (!tile || tile.querySelector('.mute-prompt')) return;

  const prompt = document.createElement('button');
  prompt.className = 'mute-prompt';
  prompt.innerHTML = '<span class="mute-prompt-icon">🔇</span><span>Clique para ouvir</span>';
  tile.appendChild(prompt);

  const activate = () => {
    video.muted = false;
    video.play().catch(() => {});
    hideMutePrompt(video);
    // Desmutar todos os outros vídeos remotos também
    document.querySelectorAll('#streams-grid video').forEach(v => {
      const t = v.closest('.stream-tile');
      const isSelfTile = t && t.dataset.peerId === myId;
      if (!isSelfTile && !isAudioMuted) {
        v.muted = false;
        v.play().catch(() => {});
      }
    });
  };

  prompt.addEventListener('click', activate, { once: true });
  prompt.addEventListener('touchend', activate, { once: true });
}

function hideMutePrompt(video) {
  const tile = video.closest('.stream-tile');
  if (!tile) return;
  const prompt = tile.querySelector('.mute-prompt');
  if (prompt) prompt.remove();
}

function tryUnmuteVideo(video, peerId) {
  if (isAudioMuted || peerId === myId) return;
  if (!video.muted) return; // já com som

  // Tentar desmutar direto
  video.muted = false;
  const p = video.play();
  if (p && p.catch) {
    p.catch(() => {
      // Bloqueado — mostrar prompt
      video.muted = true;
      video.play().catch(() => {});
      showMutePrompt(video, peerId);
    });
  }
}

function upsertVideoTile(peerId, stream) {
  const tileId = `${peerId}-video`;
  let tile = document.getElementById(tileId);

  if (!tile) {
    tile = document.createElement('div');
    tile.id = tileId;
    tile.className = 'stream-tile type-screen';
    tile.dataset.peerId = peerId;
    tile.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); makeTileFullscreen(tile); });
    (function(t){ let last=0; t.addEventListener('touchend',(e)=>{ const n=Date.now(); if(n-last<300){ e.preventDefault(); makeTileFullscreen(t); last=0;} else last=n; },{passive:false}); })(tile);
    // Clique direito / long-press = volume desta transmissão
    attachTileVolumeControls(tile, peerId);

    const loader = document.createElement('div');
    loader.className = 'tile-loader';
    loader.innerHTML = `
      <div class="tile-loader-spinner"></div>
      <span class="tile-loader-text">Conectando...</span>`;
    tile.appendChild(loader);

    const video = document.createElement('video');
    video.style.opacity = '0';
    tile.appendChild(video);
    bindVideoPlayback(video, stream, peerId);

    const label = document.createElement('div');
    label.className = 'stream-tile-label';
    tile.appendChild(label);

    document.getElementById('streams-grid').appendChild(tile);
    tiles.set(tileId, tile);
    hideNoStream();
    updateGridClass();
  } else {
    const video = tile.querySelector('video');
    if (video && video.srcObject !== stream) {
      bindVideoPlayback(video, stream, peerId);
    } else if (video) {
      video.play().catch(() => {});
      if (video.videoWidth > 0) revealVideoEl(video);
    }
  }

  const p = participants.get(peerId);
  const name = peerId === myId ? myName + ' (você)' : (p ? p.name : 'Remoto');
  const type = (p && p.broadcastType) || 'screen';
  tile.classList.toggle('type-camera', type === 'camera');
  tile.classList.toggle('type-screen', type !== 'camera');
  updateTileLabel(tile, name, type);
  applyPeerVolume(peerId);
}

function upsertAudioTile(peerId, stream, name) {
  // Áudio puro — usar elemento <audio> invisível + tile visual de mic
  const tileId = `${peerId}-mic`;
  if (document.getElementById(tileId)) {
    const audio = document.getElementById(tileId).querySelector('audio');
    if (audio) audio.srcObject = stream;
    ensureRemoteAudioElement(peerId, stream);
    applyPeerVolume(peerId);
    return;
  }

  const col = nameColor(name);
  const tile = document.createElement('div');
  tile.id = tileId;
  tile.className = 'stream-tile audio-only';
  tile.dataset.peerId = peerId;
  const p = participants.get(peerId);
  const url = peerId === myId ? loadPhoto() : (p && p.photoUrl) || '';
  let micAv;
  if (url && url.length > 10) {
    const safe = String(url).replace(/"/g, '&quot;');
    micAv = `<div class="mic-avatar" style="background:transparent;padding:0;overflow:hidden">
      <img src="${safe}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block"
        onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,${col},${col}88)';this.parentElement.textContent='🎙️';">
    </div>`;
  } else {
    micAv = `<div class="mic-avatar" style="background:linear-gradient(135deg,${col},${col}88)">🎙️</div>`;
  }
  tile.innerHTML = `
    ${micAv}
    <div class="mic-name">${name}</div>
  `;
  attachTileVolumeControls(tile, peerId);

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.srcObject = stream;
  audio.muted = isAudioMuted || isPeerMuted(peerId);
  audio.volume = uiVolToElement(getPeerVolume(peerId));
  audio.style.display = 'none';
  tile.appendChild(audio);
  audio.play().catch(() => {});

  ensureRemoteAudioElement(peerId, stream);

  document.getElementById('streams-grid').appendChild(tile);
  tiles.set(tileId, tile);
  updateGridClass();
  hideNoStream();
  applyPeerVolume(peerId);
}

function updateTileLabel(tile, name, type, photoUrl) {
  const label = tile.querySelector('.stream-tile-label');
  if (!label) return;
  const col = nameColor(name);
  const icon = type === 'camera' ? '📹' : '🖥️';
  const peerId = tile.dataset.peerId || '';
  const p = participants.get(peerId);
  const url = photoUrl || (peerId === myId ? loadPhoto() : (p && p.photoUrl)) || '';
  let av;
  if (url && url.length > 10) {
    const safe = String(url).replace(/"/g, '&quot;');
    av = `<div class="tile-avatar" style="background:transparent;padding:0;overflow:hidden">
      <img src="${safe}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block"
        onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,${col},${col}88)';this.parentElement.textContent='${nameInitial(name)}';">
    </div>`;
  } else {
    av = `<div class="tile-avatar" style="background:linear-gradient(135deg,${col},${col}88)">${nameInitial(name)}</div>`;
  }
  label.innerHTML = `
    ${av}
    <span class="tile-name">${name}</span>
    <span class="tile-type-badge">${icon}</span>
  `;
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(`${peerId}-video`);
  if (tile) { const v = tile.querySelector('video'); if (v) v.srcObject = null; tile.remove(); tiles.delete(`${peerId}-video`); }
  // Não remove o áudio remoto aqui — pode ainda haver mic; stream-stopped remove vídeo
  updateGridClass(); checkNoStream();
}

function removeMicTile(peerId) {
  const tile = document.getElementById(`${peerId}-mic`);
  if (tile) { const a = tile.querySelector('audio'); if (a) a.srcObject = null; tile.remove(); tiles.delete(`${peerId}-mic`); }
  updateGridClass(); checkNoStream();
}

function removeTilesByPeer(peerId) {
  removeVideoTile(peerId);
  removeMicTile(peerId);
  removeRemoteAudioElement(peerId);
  peerVolumes.delete(peerId);
}

function updateGridClass() {
  const grid = document.getElementById('streams-grid');
  const count = grid.querySelectorAll('.stream-tile').length;
  grid.className = 'streams-grid';
  if (count > 0) grid.classList.add(count <= 9 ? `count-${count}` : 'count-many');
}

function hideNoStream() { const el = document.getElementById('no-stream'); if (el) el.style.display = 'none'; }

function checkNoStream() {
  const grid = document.getElementById('streams-grid');
  const el = document.getElementById('no-stream');
  if (el) el.style.display = grid.querySelectorAll('.stream-tile').length ? 'none' : '';
}

function makeTileFullscreen(tile) {
  if (!tile) return;
  const video = tile.querySelector && tile.querySelector('video');
  const target = video || tile;
  try {
    if (document.fullscreenElement === target || document.webkitFullscreenElement === target) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
  } catch (_) {}
  const req = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
  if (req) {
    req.call(target).catch(() => {
      // fallback: try tile
      const r2 = tile.requestFullscreen || tile.webkitRequestFullscreen;
      if (r2) r2.call(tile).catch(() => {});
    });
  }
}

// ==================== CANVAS COMPOSITOR ====================

function ensureCompositeElements() {
  if (compositeCanvas) return;
  compositeCanvas = document.createElement('canvas');
  compositeCtx = compositeCanvas.getContext('2d');
  compScreenEl = Object.assign(document.createElement('video'), { autoplay: true, muted: true, playsInline: true });
  compCameraEl = Object.assign(document.createElement('video'), { autoplay: true, muted: true, playsInline: true });
}

function startComposite() {
  if (compositeStream) return compositeStream;
  if (!screenStream || !cameraStream) return null;
  ensureCompositeElements();
  if (!compositeCanvas.captureStream) return null;

  const settings = screenStream.getVideoTracks()[0].getSettings();
  compositeCanvas.width = settings.width || 1280;
  compositeCanvas.height = settings.height || 720;

  compScreenEl.srcObject = new MediaStream(screenStream.getVideoTracks());
  compCameraEl.srcObject = new MediaStream(cameraStream.getVideoTracks());
  compScreenEl.muted = true;
  compCameraEl.muted = true;
  compScreenEl.play().catch(() => {});
  compCameraEl.play().catch(() => {});

  compositeStream = compositeCanvas.captureStream(20);

  const kick = () => { if (!compRAF) drawComposite(); };
  if (compScreenEl.videoWidth > 0) kick();
  else {
    compScreenEl.addEventListener('loadeddata', kick, { once: true });
    compScreenEl.addEventListener('playing', kick, { once: true });
  }

  return compositeStream;
}

function drawComposite() {
  if (!compositeCtx || !isScreenSharing || !isCameraOn) { compRAF = null; return; }
  const w = compositeCanvas.width, h = compositeCanvas.height;

  if (compScreenEl && compScreenEl.videoWidth > 0) {
    compositeCtx.drawImage(compScreenEl, 0, 0, w, h);
  }

  if (compCameraEl && compCameraEl.videoWidth > 0) {
    const camW = Math.round(w * 0.22);
    const camH = Math.round(camW * compCameraEl.videoHeight / compCameraEl.videoWidth);
    const margin = Math.round(w * 0.012);
    const cx = w - camW - margin, cy = h - camH - margin, r = 10;

    compositeCtx.save();
    rrPath(compositeCtx, cx, cy, camW, camH, r);
    compositeCtx.clip();
    compositeCtx.drawImage(compCameraEl, cx, cy, camW, camH);
    compositeCtx.restore();
    compositeCtx.save();
    compositeCtx.strokeStyle = 'rgba(255,255,255,0.18)';
    compositeCtx.lineWidth = 2;
    rrPath(compositeCtx, cx, cy, camW, camH, r);
    compositeCtx.stroke();
    compositeCtx.restore();
  }
  compRAF = requestAnimationFrame(drawComposite);
}

function rrPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function stopComposite() {
  if (compRAF) { cancelAnimationFrame(compRAF); compRAF = null; }
  if (compositeStream) { compositeStream.getTracks().forEach(t => t.stop()); compositeStream = null; }
  if (compScreenEl) compScreenEl.srcObject = null;
  if (compCameraEl) compCameraEl.srcObject = null;
}

function getCurrentVideoTrack() {
  if (isScreenSharing && isCameraOn && screenStream && cameraStream) {
    if (compositeStream) return compositeStream.getVideoTracks()[0];
    const cs = startComposite();
    if (cs) return cs.getVideoTracks()[0];
  }
  if (isScreenSharing && screenStream) return screenStream.getVideoTracks()[0];
  if (isCameraOn && cameraStream) return cameraStream.getVideoTracks()[0];
  return null;
}

function getMicAudioTrack() {
  return micStream && micStream.getAudioTracks().length ? micStream.getAudioTracks()[0] : null;
}

/** Áudio que deve ir para TODOS os peers (inclui som do sistema na tela). */
function getOutboundAudioTrack() {
  if (outboundAudioTrack && outboundAudioTrack.readyState === 'live') {
    return outboundAudioTrack;
  }
  // Fallback: áudio cru da tela (se ainda existir)
  if (isScreenSharing && screenStream) {
    const sa = screenStream.getAudioTracks().find(t => t.readyState === 'live');
    if (sa) return sa;
  }
  return getMicAudioTrack();
}

function setOutboundAudioTrack(track, keepStream) {
  outboundAudioTrack = track || null;
  if (keepStream) outboundAudioStream = keepStream;
  else if (!track) outboundAudioStream = null;
}

function pushOutboundAudioToAllPeers() {
  const track = getOutboundAudioTrack();
  if (!track) return;
  for (const [, entry] of peers) {
    if (entry.pc) replaceAudioTrackInPeer(entry.pc, track);
  }
}

// ==================== MÍDIA LOCAL ====================

async function startMic() {
  if (micStream) return true;
  try {
    const raw = await navigator.mediaDevices.getUserMedia(getMicConstraints());
    micStream = raw;
    isMicOn = true;
    if (socket) socket.emit('mic-update', { hasMic: true, micMuted: false });
    let outStream = raw;
    if (noiseSuppressionOn) outStream = await applyNoiseSuppression(raw);
    const trackToSend = outStream.getAudioTracks()[0] || raw.getAudioTracks()[0];
    if (!isScreenSharing) {
      setOutboundAudioTrack(trackToSend, outStream);
      pushOutboundAudioToAllPeers();
    } else {
      for (const [, entry] of peers) {
        if (entry.pc) replaceAudioTrackInPeer(entry.pc, getOutboundAudioTrack() || trackToSend);
      }
    }
    return true;
  } catch (err) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      isMicOn = true;
      if (socket) socket.emit('mic-update', { hasMic: true, micMuted: false });
      let outStream = micStream;
      if (noiseSuppressionOn) outStream = await applyNoiseSuppression(micStream);
      const track = outStream.getAudioTracks()[0];
      if (!isScreenSharing) {
        setOutboundAudioTrack(track, outStream);
        pushOutboundAudioToAllPeers();
      } else {
        for (const [, entry] of peers) {
          if (entry.pc) replaceAudioTrackInPeer(entry.pc, getOutboundAudioTrack() || track);
        }
      }
      return true;
    } catch (err2) {
      console.error('Mic error:', err2);
      showToast('Não foi possível acessar o microfone', 'error');
      return false;
    }
  }
}

async function stopMic() {
  if (!micStream) return;
  destroyNoisePipeline();
  micStream.getTracks().forEach(t => t.stop());
  micStream = null;
  isMicOn = false;
  socket.emit('mic-update', { hasMic: false, micMuted: true });
  // Se só o mic era a fonte, limpa outbound; se tela ainda tem áudio, reconfigura
  if (!isScreenSharing) {
    setOutboundAudioTrack(null, null);
  } else if (screenStream) {
    const sa = screenStream.getAudioTracks().find(t => t.readyState === 'live');
    setOutboundAudioTrack(sa || null, sa ? screenStream : null);
    pushOutboundAudioToAllPeers();
  }
}

// FIX 6: toggleMic independente de câmera/tela
async function toggleMic() {
  if (!micStream) {
    const ok = await startMic();
    if (ok) showToast('Microfone ativado', 'success');
  } else {
    const track = micStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      isMicOn = track.enabled;
      socket.emit('mic-update', { hasMic: true, micMuted: !isMicOn });
      showToast(isMicOn ? 'Microfone ativado' : 'Microfone mutado', isMicOn ? 'success' : 'info');
    }
  }
  updateToolbarUI();
  renderParticipantsList();
}

async function startCamera() {
  try {
    const q = QUALITY_PRESETS[streamQuality] || QUALITY_PRESETS.high;
    const constraints = isMobile()
      ? {
          video: {
            facingMode:  currentFacingMode,
            width:       { ideal: Math.min(q.width, 640) },
            height:      { ideal: Math.min(q.height, 480) },
            frameRate:   { ideal: q.frameRate }
          },
          audio: false
        }
      : {
          video: {
            width:     { ideal: q.width },
            height:    { ideal: q.height },
            frameRate: { ideal: q.frameRate }
          },
          audio: false
        };

    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    isCameraOn = true;

    // Garantir mic ativo e enviado para todos os peers
    if (!micStream) await startMic();
    else {
      // Mic já existia — garantir que está sendo enviado para peers existentes
      const micTrack = getMicAudioTrack();
      if (micTrack) {
        for (const [, entry] of peers) {
          if (entry.pc) replaceAudioTrackInPeer(entry.pc, micTrack);
        }
      }
    }

    const track = getCurrentVideoTrack();
    if (track) broadcastVideoTrack(track);

    socket.emit('stream-started', { type: isScreenSharing ? 'screen' : 'camera', hasAudio: !!micStream });
    updateSelfPreview();
    updateToolbarUI();
    // Mostrar botão de flip só no mobile com câmera ativa
    if (isMobile()) {
      document.getElementById('btn-flip-camera').classList.remove('hidden');
    }
    showToast('Câmera ligada', 'success');
  } catch (err) {
    isCameraOn = false;
    console.error('Camera error:', err);
    if (err.name === 'NotAllowedError') {
      showToast('Permissão negada para câmera', 'error');
    } else if (err.name === 'NotFoundError') {
      showToast('Câmera não encontrada neste dispositivo', 'error');
    } else {
      showToast('Não foi possível acessar a câmera', 'error');
    }
  }
}

async function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  isCameraOn = false;
  stopComposite();

  if (isScreenSharing && screenStream) {
    const track = screenStream.getVideoTracks()[0];
    replaceVideoInAllPeers(track);
    socket.emit('stream-started', { type: 'screen', hasAudio: !!micStream });
  } else {
    clearVideoInAllPeers();
    socket.emit('stream-stopped');
  }

  updateSelfPreview();
  updateToolbarUI();
  // Esconder flip quando câmera desliga
  document.getElementById('btn-flip-camera').classList.add('hidden');
  showToast('Câmera desligada', 'info');
}

/** Inverte câmera frontal ↔ traseira (mobile). Para tracks e readquire com facingMode oposto. */
async function flipCamera() {
  if (!isCameraOn || !isMobile()) return;
  const btn = document.getElementById('btn-flip-camera');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

  const prevFacing = currentFacingMode;
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

  try {
    // Para tracks antigas antes de pedir nova mídia (evita conflito de dispositivo em alguns browsers)
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      cameraStream = null;
    }

    const q = QUALITY_PRESETS[streamQuality] || QUALITY_PRESETS.high;
    const constraints = {
      video: {
        facingMode: { ideal: currentFacingMode },
        width:     { ideal: Math.min(q.width, 1280) },
        height:    { ideal: Math.min(q.height, 720) },
        frameRate: { ideal: q.frameRate }
      },
      audio: false
    };

    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    isCameraOn = true;

    // Atualiza preview local e peers (composite se tela+câmera)
    if (isScreenSharing && isCameraOn) {
      stopComposite();
      startComposite();
    }
    const track = getCurrentVideoTrack();
    if (track) {
      try { track.contentHint = 'motion'; } catch (_) {}
      broadcastVideoTrack(track);
    }
    updateSelfPreview();
    updateToolbarUI();
    showToast(currentFacingMode === 'user' ? 'Câmera frontal' : 'Câmera traseira', 'success');
  } catch (err) {
    console.error('Flip camera error:', err);
    // Reverte facingMode se falhou
    currentFacingMode = prevFacing;
    // Tenta recuperar a câmera anterior
    try {
      await startCamera();
    } catch (_) {
      isCameraOn = false;
      const flipBtn = document.getElementById('btn-flip-camera');
      if (flipBtn) flipBtn.classList.add('hidden');
      showToast('Não foi possível virar a câmera', 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function acquireDisplayMedia() {
  const q = QUALITY_PRESETS[streamQuality] || QUALITY_PRESETS.high;
  const attempts = [
    {
      video: {
        frameRate: { ideal: q.frameRate, max: Math.max(q.frameRate, 30) },
        width: { ideal: q.width, max: q.width },
        height: { ideal: q.height, max: q.height }
      },
      audio: true,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include'
    },
    {
      video: {
        frameRate: { ideal: q.frameRate },
        width: { ideal: q.width },
        height: { ideal: q.height }
      },
      audio: true
    },
    { video: { frameRate: { ideal: q.frameRate } }, audio: true },
    { video: true, audio: false }
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (err && err.name === 'NotAllowedError') throw err;
    }
  }
  throw lastErr || new Error('getDisplayMedia failed');
}

async function startScreenShare() {
  if (!supportsScreenShare()) {
    showToast('No celular use a Câmera para transmitir 📹', 'info');
    return;
  }
  if (screenShareBusy || isScreenSharing) return;
  screenShareBusy = true;
  try {
    screenStream = await acquireDisplayMedia();
    isScreenSharing = true;

    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      try { videoTrack.contentHint = 'detail'; } catch (_) {}
      // Tentar aplicar a qualidade escolhida (frameRate/resolução quando o browser permitir)
      try {
        const q = QUALITY_PRESETS[streamQuality] || QUALITY_PRESETS.high;
        await videoTrack.applyConstraints({
          frameRate: { ideal: q.frameRate, max: Math.max(q.frameRate, 30) },
          width: { ideal: q.width, max: q.width },
          height: { ideal: q.height, max: q.height }
        });
      } catch (_) {}
      videoTrack.onended = () => {
        if (isScreenSharing) stopScreenShare();
      };
    }

    const screenAudioTrack = screenStream.getAudioTracks()[0] || null;
    if (!micStream) await startMic();

    broadcastVideoTrack(getCurrentVideoTrack());

    let audioTrackToSend = getMicAudioTrack();
    let keepStream = null;
    if (screenAudioTrack && audioTrackToSend) {
      const merged = await mergeAudioTracks(screenAudioTrack, audioTrackToSend);
      // mergeAudioTracks devolve o track; guardar stream do merge se disponível
      audioTrackToSend = merged;
      keepStream = window._mergeAudioStream || null;
    } else if (screenAudioTrack) {
      audioTrackToSend = screenAudioTrack;
      keepStream = screenStream;
    }

    setOutboundAudioTrack(audioTrackToSend, keepStream);
    pushOutboundAudioToAllPeers();

    socket.emit('stream-started', { type: 'screen', hasAudio: !!audioTrackToSend });
    updateSelfPreview();
    updateToolbarUI();
    showToast('Compartilhamento de tela iniciado', 'success');
  } catch (err) {
    isScreenSharing = false;
    console.error('Screen share error:', err);
    if (err && err.name === 'NotAllowedError') {
      showToast('Permissão negada para compartilhar a tela', 'error');
    } else {
      showToast('Não foi possível compartilhar a tela', 'error');
    }
  } finally {
    screenShareBusy = false;
  }
}

// Mescla dois AudioTracks em um único usando AudioContext
async function mergeAudioTracks(track1, track2) {
  try {
    const ctx   = new (window.AudioContext || window.webkitAudioContext)();
    const dest  = ctx.createMediaStreamDestination();

    const src1  = ctx.createMediaStreamSource(new MediaStream([track1]));
    const src2  = ctx.createMediaStreamSource(new MediaStream([track2]));

    // Gain para controlar volume relativo
    const gain1 = ctx.createGain(); gain1.gain.value = 1.0;  // sistema
    const gain2 = ctx.createGain(); gain2.gain.value = 0.8;  // mic (levemente mais baixo)

    src1.connect(gain1); gain1.connect(dest);
    src2.connect(gain2); gain2.connect(dest);

    // Guardar contexto + stream para não garbage-collectar e poder reenviar a late-joiners
    window._mergeAudioCtx = ctx;
    window._mergeAudioStream = dest.stream;

    return dest.stream.getAudioTracks()[0];
  } catch (err) {
    console.warn('mergeAudioTracks falhou, usando só mic:', err);
    return track2; // fallback para só o mic
  }
}

// FIX 1: stopScreenShare sem double-call
async function stopScreenShare() {
  isScreenSharing = false;

  // Fechar AudioContext de mesclagem se existia
  if (window._mergeAudioCtx) {
    try { window._mergeAudioCtx.close(); } catch (_) {}
    window._mergeAudioCtx = null;
  }
  window._mergeAudioStream = null;

  if (screenStream) {
    screenStream.getVideoTracks().forEach(t => { t.onended = null; t.stop(); });
    screenStream.getAudioTracks().forEach(t => t.stop());
    screenStream = null;
  }

  stopComposite();

  if (isCameraOn && cameraStream) {
    const track = cameraStream.getVideoTracks()[0];
    replaceVideoInAllPeers(track);
    // Restaurar mic como fonte de áudio
    const micTrack = getMicAudioTrack();
    setOutboundAudioTrack(micTrack, micStream);
    pushOutboundAudioToAllPeers();
    socket.emit('stream-started', { type: 'camera', hasAudio: !!micStream });
  } else {
    clearVideoInAllPeers();
    const micTrack = getMicAudioTrack();
    setOutboundAudioTrack(micTrack, micStream);
    if (micTrack) pushOutboundAudioToAllPeers();
    else {
      // Sem áudio para enviar — limpa senders de áudio se necessário
      setOutboundAudioTrack(null, null);
    }
    socket.emit('stream-stopped');
  }

  updateSelfPreview();
  updateToolbarUI();
  showToast('Compartilhamento de tela encerrado', 'info');
}

function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  // Aplicar volume global + por peer
  for (const [pid] of participants) {
    if (pid === myId) continue;
    applyPeerVolume(pid);
  }
  // Elementos soltos no grid
  document.querySelectorAll('#streams-grid video, #streams-grid audio').forEach(el => {
    const tile = el.closest('.stream-tile');
    const isSelf = tile && tile.dataset.peerId === myId;
    if (isSelf) return;
    if (isAudioMuted) {
      el.muted = true;
    } else {
      const pid = tile && tile.dataset.peerId;
      const vol = pid ? getPeerVolume(pid) : 1;
      el.volume = vol;
      el.muted = vol <= 0;
      if (vol > 0) {
        el.play().catch(() => { el.muted = true; });
      }
    }
  });
  // Áudios remotos dedicados
  document.querySelectorAll('audio[id^="remote-audio-"]').forEach(a => {
    const pid = a.id.replace('remote-audio-', '');
    applyPeerVolume(pid);
  });
  updateToolbarUI();
  showToast(isAudioMuted ? 'Áudio silenciado' : 'Áudio ativado', isAudioMuted ? 'info' : 'success');
}

// ==================== HELPERS DE BROADCAST ====================

// FIX 4: broadcastVideoTrack — sem offer manual, deixa só o onnegotiationneeded trabalhar
// O offer manual criava conflito com onnegotiationneeded (2 offers simultâneos → tela preta)
function broadcastVideoTrack(videoTrack) {
  if (!videoTrack) return;
  try { videoTrack.contentHint = videoTrack.contentHint || (isScreenSharing ? 'detail' : 'motion'); } catch (_) {}
  for (const [, entry] of peers) {
    if (entry.pc) replaceVideoTrackInPeer(entry.pc, videoTrack);
  }
}

function replaceVideoInAllPeers(newTrack) {
  if (!newTrack) return;
  for (const [, entry] of peers) {
    if (entry.pc) replaceVideoTrackInPeer(entry.pc, newTrack);
  }
}

function clearVideoInAllPeers() {
  for (const [, entry] of peers) {
    if (!entry.pc) continue;
    const vs = entry.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (vs) vs.replaceTrack(null).catch(() => {});
  }
}

// ==================== SELF PREVIEW ====================

// FIX 8: updateSelfPreview é a única função que cria/atualiza/remove o tile próprio
function updateSelfPreview() {
  const tileId = `${myId}-video`;
  const hasMedia = isCameraOn || isScreenSharing;

  if (!hasMedia) {
    // Remover tile próprio
    const tile = document.getElementById(tileId);
    if (tile) { const v = tile.querySelector('video'); if (v) v.srcObject = null; tile.remove(); tiles.delete(tileId); updateGridClass(); checkNoStream(); }
    return;
  }

  let tile = document.getElementById(tileId);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = tileId;
    tile.className = 'stream-tile type-camera';
    tile.dataset.peerId = myId;
    tile.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); makeTileFullscreen(tile); });
    (function(t){ let last=0; t.addEventListener('touchend',(e)=>{ const n=Date.now(); if(n-last<300){ e.preventDefault(); makeTileFullscreen(t); last=0;} else last=n; },{passive:false}); })(tile);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // mute self-preview
    tile.appendChild(video);

    const label = document.createElement('div');
    label.className = 'stream-tile-label';
    tile.appendChild(label);

    document.getElementById('streams-grid').appendChild(tile);
    tiles.set(tileId, tile);
    hideNoStream();
    updateGridClass();
  }

  const video = tile.querySelector('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  if (isCameraOn && cameraStream) {
    video.srcObject = cameraStream;
    tile.className = 'stream-tile type-camera';
    updateTileLabel(tile, myName + ' (você)', 'camera');
  } else if (isScreenSharing && screenStream) {
    video.srcObject = screenStream;
    tile.className = 'stream-tile type-screen';
    updateTileLabel(tile, myName + ' (você)', 'screen');
  }
  video.play().catch(() => {});
}

function stopAllMedia() {
  // Fechar AudioContext de mesclagem se existia
  if (window._mergeAudioCtx) {
    try { window._mergeAudioCtx.close(); } catch (_) {}
    window._mergeAudioCtx = null;
  }
  window._mergeAudioStream = null;
  setOutboundAudioTrack(null, null);
  stopComposite();
  if (screenStream) { screenStream.getVideoTracks().forEach(t => { t.onended = null; t.stop(); }); screenStream.getAudioTracks().forEach(t => t.stop()); screenStream = null; }
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  isScreenSharing = false; isCameraOn = false; isMicOn = false;
}

// ==================== GESTÃO DE SALAS ====================

function validateName() {
  // Tentar usar nome salvo no perfil ou o que estiver no input
  const fromInput = document.getElementById('global-username');
  const n = (fromInput ? fromInput.value.trim() : '') || loadName();
  if (!n) { showToast('Digite seu apelido antes de continuar', 'error'); enterEditMode(); return null; }
  return n;
}

async function createRoom() {
  const name = validateName(); if (!name) return;
  const roomId   = document.getElementById('create-room-id').value.trim().toUpperCase() || generateRoomId();
  const rName    = document.getElementById('create-room-name').value.trim();
  const password = document.getElementById('create-password').value.trim();
  const btn = document.getElementById('btn-create-room');

  if (!rName) {
    showToast('Digite o nome da sala antes de criar', 'error');
    document.getElementById('create-room-name').focus();
    return;
  }

  if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }

  try {
    showToast('Conectando ao servidor...', 'info');
    const ok = await connectSocket();
    if (!ok) {
      showToast('Não conectou. Espere 20s (servidor acordando) e clique de novo.', 'error');
      return;
    }

    myName = name; saveName(name);
    lastJoinPassword = password || '';

    showToast('Criando sala...', 'info');
    const res = await emitWithAck('create-room', {
      roomId,
      roomName: rName,
      password,
      userName: name,
      photoUrl: safePhotoForEmit()
    }, 15000);

    if (res && res.success) {
      isOwner = true;
      if (socket && socket.id) myId = socket.id;
      // currentRoomId cedo — evita race com room-sync
      currentRoomId = String(res.roomId || roomId).toUpperCase();
      participants.clear();
      (res.participants || [{
        id: myId, name: name, isOwner: true,
        isBroadcasting: false, broadcastType: null, hasMic: false, micMuted: true,
        photoUrl: safePhotoForEmit()
      }]).forEach(p => {
        if (p && p.id) participants.set(p.id, {
          name: p.name, isOwner: p.isOwner,
          isBroadcasting: !!p.isBroadcasting, broadcastType: p.broadcastType || null,
          hasMic: !!p.hasMic, micMuted: p.micMuted !== false, photoUrl: p.photoUrl || ''
        });
      });
      enterRoom(res.roomId || roomId, rName || res.roomName, true);
    } else {
      showToast((res && res.message) || 'Erro ao criar sala', 'error');
    }
  } catch (err) {
    console.error(err);
    showToast('Erro inesperado ao criar sala', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function joinRoom(roomId, password) {
  const name = validateName(); if (!name) return;
  roomId   = roomId   !== undefined ? roomId   : document.getElementById('join-room-id').value.trim().toUpperCase();
  password = password !== undefined ? password : document.getElementById('join-password').value.trim();
  if (!roomId) { showToast('Digite o ID da sala', 'error'); return; }
  const btn = document.getElementById('btn-join-room');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }

  try {
    showToast('Conectando ao servidor...', 'info');
    const ok = await connectSocket();
    if (!ok) {
      showToast('Não conectou. Espere 20s (servidor acordando) e clique de novo.', 'error');
      return;
    }

    myName = name; saveName(name);
    lastJoinPassword = password || '';

    showToast('Entrando na sala...', 'info');
    const res = await emitWithAck('join-room', {
      roomId,
      password,
      userName: name,
      photoUrl: safePhotoForEmit()
    }, 15000);

    if (res && res.success) {
      isOwner = res.isOwner;
      if (socket && socket.id) myId = socket.id;
      // currentRoomId cedo — room-sync que chegou junto não é descartado
      currentRoomId = String(res.roomId || roomId).toUpperCase();
      participants.clear();
      (res.participants || []).forEach(p => {
        if (!p || !p.id) return;
        participants.set(p.id, {
          name: p.name, isOwner: p.isOwner,
          isBroadcasting: !!p.isBroadcasting, broadcastType: p.broadcastType || null,
          hasMic: !!p.hasMic, micMuted: p.micMuted !== false,
          photoUrl: p.photoUrl || ''
        });
      });
      enterRoom(res.roomId, res.roomName, res.isOwner);
    } else {
      const msg = (res && res.message) || 'Erro ao entrar na sala';
      if (msg.toLowerCase().includes('não encontrada')) {
        showToast('Sala não encontrada. O criador precisa recriar a sala.', 'error');
        loadRoomsList();
      } else {
        showToast(msg, 'error');
      }
      if (msg.toLowerCase().includes('senha')) {
        const fb = document.getElementById('btn-forgot-password');
        if (fb) fb.classList.remove('hidden');
      }
    }
  } catch (err) {
    console.error(err);
    showToast('Erro inesperado ao entrar na sala', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

function enterRoom(roomId, rName, owner) {
  // Setar cedo para que room-sync concurrent não seja ignorado
  currentRoomId = roomId ? String(roomId).toUpperCase() : roomId;
  roomName = rName;
  isOwner = owner;
  if (socket && socket.id) myId = socket.id;

  // Garante que os outros recebam nossa foto
  const myPhoto = loadPhoto();
  if (socket && myPhoto) {
    setTimeout(() => { try { socket.emit('photo-share', { photoUrl: myPhoto }); } catch (_) {} }, 400);
  }

  document.getElementById('room-name-display').textContent = rName || roomId;
  document.getElementById('room-id-badge').textContent = roomId;

  if (owner) {
    document.getElementById('btn-delete-room').classList.remove('hidden');
    document.getElementById('btn-delete-room').classList.add('flex');
  } else {
    document.getElementById('btn-delete-room').classList.add('hidden');
    document.getElementById('btn-delete-room').classList.remove('flex');
  }

  document.getElementById('lobby-view').classList.add('hidden');
  document.getElementById('room-view').classList.remove('hidden');

  updateParticipantCount();
  renderParticipantsList();

  // Mesh: conecta a todos que já estão na sala (várias tentativas)
  const meshAll = () => {
    if (socket && socket.id) myId = socket.id;
    for (const [pid] of participants) {
      if (!pid || pid === myId) continue;
      ensureMeshWith(pid);
    }
  };
  meshAll();
  setTimeout(meshAll, 400);
  setTimeout(meshAll, 1200);
  setTimeout(meshAll, 2500);

  // Liga o microfone automaticamente para call de voz na sala
  // (usuário pode mutar depois). Falha silenciosa se negar permissão.
  setTimeout(() => {
    if (!currentRoomId) return;
    if (!micStream) {
      startMic().then(ok => {
        if (ok) {
          updateToolbarUI();
          renderParticipantsList();
        }
      }).catch(() => {});
    }
  }, 600);

  // Força sincronização da lista de participantes com o servidor
  // (corrige caso user-joined/room-sync tenham sido perdidos)
  requestRoomSync();
  setTimeout(() => requestRoomSync(), 1000);
  setTimeout(() => requestRoomSync(), 2500);
  startRoomSyncLoop();

  showToast(`Você entrou em ${rName || roomId}`, 'success');
}

let _roomSyncTimer = null;
function startRoomSyncLoop() {
  stopRoomSyncLoop();
  // Nos primeiros 20s sincroniza a cada 3s; depois a cada 12s
  let ticks = 0;
  _roomSyncTimer = setInterval(() => {
    if (!currentRoomId || !socket || !socket.connected) {
      stopRoomSyncLoop();
      return;
    }
    requestRoomSync();
    ticks++;
    if (ticks === 7) {
      // após ~21s, reduz frequência
      stopRoomSyncLoop();
      _roomSyncTimer = setInterval(() => {
        if (!currentRoomId || !socket || !socket.connected) {
          stopRoomSyncLoop();
          return;
        }
        requestRoomSync();
      }, 12000);
    }
  }, 3000);
}
function stopRoomSyncLoop() {
  if (_roomSyncTimer) {
    clearInterval(_roomSyncTimer);
    _roomSyncTimer = null;
  }
}

/** Pede ao servidor a lista oficial de quem está na sala e aplica no cliente */
function requestRoomSync() {
  if (!socket || !socket.connected || !currentRoomId) return;
  try {
    socket.emit('sync-room', (res) => {
      if (!res || !res.success || !Array.isArray(res.participants)) return;
      if (socket && socket.id) myId = socket.id;
      const prevSize = participants.size;
      participants.clear();
      res.participants.forEach(p => {
        if (!p || !p.id) return;
        participants.set(p.id, {
          name: p.name || 'Usuário',
          isOwner: !!p.isOwner,
          isBroadcasting: !!p.isBroadcasting,
          broadcastType: p.broadcastType || null,
          hasMic: !!p.hasMic,
          micMuted: p.micMuted !== false,
          photoUrl: p.photoUrl || ''
        });
      });
      updateParticipantCount();
      renderParticipantsList();
      for (const [pid] of participants) {
        if (!pid || pid === myId) continue;
        ensureMeshWith(pid);
      }
      if (participants.size > prevSize) {
        // Alguém novo detectado via sync
        console.log('[MaxCord] sync-room: participantes =', participants.size);
      }
    });
  } catch (_) {}
}

function rejoinAfterReconnect() {
  if (!currentRoomId || !socket) return;
  for (const [, e] of peers) { if (e.pc) try { e.pc.close(); } catch (_) {} }
  peers.clear();
  pendingIce.clear();

  socket.emit('join-room', {
    roomId: currentRoomId,
    password: lastJoinPassword,
    userName: myName,
    photoUrl: loadPhoto()
  }, (res) => {
    if (!res || !res.success) {
      showToast('Não foi possível voltar à sala', 'error');
      leaveRoom(false);
      return;
    }
    isOwner = res.isOwner;
    participants.clear();
    (res.participants || []).forEach(p => participants.set(p.id, {
      name: p.name, isOwner: p.isOwner,
      isBroadcasting: p.isBroadcasting, broadcastType: p.broadcastType,
      hasMic: p.hasMic, micMuted: p.micMuted,
      photoUrl: p.photoUrl || ''
    }));
    updateParticipantCount();
    renderParticipantsList();
    for (const [pid] of participants) {
      if (pid === myId) continue;
      connectToPeer(pid);
      socket.emit('request-peer', { targetId: pid });
    }
    const vt = getCurrentVideoTrack();
    if (vt) broadcastVideoTrack(vt);
    // Reenvia o mesmo áudio da transmissão (tela/sistema), não só o mic
    const at = getOutboundAudioTrack();
    if (at) {
      for (const [, entry] of peers) {
        if (entry.pc) replaceAudioTrackInPeer(entry.pc, at);
      }
    }
    setTimeout(() => {
      pushOutboundAudioToAllPeers();
      const vt2 = getCurrentVideoTrack();
      if (vt2) broadcastVideoTrack(vt2);
    }, 500);
    if (isScreenSharing || isCameraOn) {
      socket.emit('stream-started', {
        type: isScreenSharing ? 'screen' : 'camera',
        hasAudio: !!getOutboundAudioTrack()
      });
    }
    if (micStream) socket.emit('mic-update', { hasMic: true, micMuted: !isMicOn });
    showToast('Reconectado à sala', 'success');
  });
}

function leaveRoom(notify = true) {
  stopRoomSyncLoop();
  stopAllMedia();
  for (const [pid, e] of peers) {
    if (e.pc) try { e.pc.close(); } catch (_) {}
    removeRemoteAudioElement(pid);
  }
  peers.clear(); pendingIce.clear(); participants.clear(); tiles.clear();
  peerVolumes.clear();
  hideTileVolumeMenu();
  document.querySelectorAll('audio[id^="remote-audio-"]').forEach(a => a.remove());

  if (notify && socket) socket.emit('leave-room');

  isOwner = false; currentRoomId = null; roomName = '';
  isAudioMuted = false;
  lastJoinPassword = '';
  screenShareBusy = false;

  const grid = document.getElementById('streams-grid');
  grid.innerHTML = `<div id="no-stream" class="no-stream-placeholder">
    <div class="no-stream-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
    </div>
    <p class="no-stream-title">Nenhuma transmissão ativa</p>
    <p class="no-stream-hint">Compartilhe sua tela ou ligue a câmera</p>
  </div>`;
  grid.className = 'streams-grid';

  document.getElementById('participants-list').innerHTML = '';
  document.getElementById('chat-messages').innerHTML = '';
  chatUnread = 0; chatOpen = false;
  document.getElementById('chat-badge').classList.add('hidden');
  document.getElementById('chat-panel').classList.add('hidden');
  document.getElementById('btn-flip-camera').classList.add('hidden');
  document.getElementById('room-view').classList.add('hidden');
  document.getElementById('lobby-view').classList.remove('hidden');
  document.getElementById('btn-delete-room').classList.add('hidden');
  document.getElementById('btn-delete-room').classList.remove('flex');
  document.getElementById('participants-panel').classList.add('hidden');

  updateToolbarUI();
  loadRoomsList();
  showToast('Você saiu da sala', 'info');
}

async function deleteRoom() {
  if (!confirm('Deletar a sala? Todos os participantes serão removidos.')) return;
  socket.emit('delete-room', (res) => {
    if (!res.success) showToast(res.message || 'Erro ao deletar sala', 'error');
  });
}

// ==================== UI ====================

function updateParticipantCount() {
  // participants pode ou não incluir o próprio usuário (room-sync inclui; user-joined não).
  // Contamos IDs únicos garantindo que "eu" entre na conta.
  const ids = new Set(participants.keys());
  if (myId) ids.add(myId);
  else if (socket && socket.id) ids.add(socket.id);
  const n = Math.max(1, ids.size);
  const el = document.getElementById('participant-count');
  if (el) el.textContent = String(n);
}

function renderParticipantsList() {
  const list = document.getElementById('participants-list');
  list.innerHTML = '';

  const renderItem = (id, name, owner, broadcasting, broadType, hasMic, micMuted, isMe, photoUrl) => {
    const micIcon = hasMic ? (micMuted ? '🔇' : '🎙️') : '';
    const vidIcon = broadcasting ? (broadType === 'screen' ? '🖥️' : '📹') : '';
    const div = document.createElement('div');
    div.className = 'participant-item';
    div.innerHTML = `
      ${avatarHtml(name, photoUrl, 'avatar-sm')}
      <span class="p-name">${name}${isMe ? ' <span style="font-size:10px;color:var(--accent-text)">(você)</span>' : ''}</span>
      <div class="p-badges">
        ${owner   ? '<span class="p-badge">👑</span>' : ''}
        ${vidIcon ? `<span class="p-badge">${vidIcon}</span>` : ''}
        ${micIcon ? `<span class="p-badge">${micIcon}</span>` : ''}
      </div>`;
    list.appendChild(div);
  };

  const myBroad = isCameraOn || isScreenSharing;
  const myType  = isScreenSharing ? 'screen' : (isCameraOn ? 'camera' : null);
  renderItem(myId, myName, isOwner, myBroad, myType, !!micStream, !isMicOn, true, loadPhoto());

  for (const [pid, p] of participants) {
    if (pid === myId) continue;
    renderItem(pid, p.name, p.isOwner, p.isBroadcasting, p.broadcastType, p.hasMic, p.micMuted, false, p.photoUrl || '');
  }
}

function updateToolbarUI() {
  const btnScreen = document.getElementById('btn-share-screen');
  const btnCamera = document.getElementById('btn-camera');
  const btnMic    = document.getElementById('btn-mic');
  const btnAudio  = document.getElementById('btn-audio');
  const qWrap = document.getElementById('quality-select-wrap');
  if (qWrap) qWrap.classList.toggle('hidden', !(isScreenSharing || isCameraOn));

  // Celular: não mostra botão de transmissão de tela (getDisplayMedia limitado/inexistente no mobile)
  if (isMobile() || !supportsScreenShare()) {
    if (btnScreen) btnScreen.style.display = 'none';
  } else {
    if (btnScreen) {
      btnScreen.style.display = '';
      btnScreen.className = `toolbar-btn${isScreenSharing ? ' active-screen' : ''}`;
      const lbl = btnScreen.querySelector('.btn-label');
      if (lbl) lbl.textContent = isScreenSharing ? 'Parar Tela' : 'Tela';
    }
  }

  btnCamera.className = `toolbar-btn${isCameraOn ? ' active-camera' : ''}`;
  btnCamera.querySelector('.btn-label').textContent = isCameraOn ? 'Desligar' : 'Câmera';

  if (isMicOn) {
    btnMic.className = 'toolbar-btn active-mic';
    btnMic.querySelector('.btn-label').textContent = 'Mutar Mic';
  } else if (micStream) {
    btnMic.className = 'toolbar-btn muted-mic';
    btnMic.querySelector('.btn-label').textContent = 'Mic Off';
  } else {
    btnMic.className = 'toolbar-btn';
    btnMic.querySelector('.btn-label').textContent = 'Mic';
  }

  btnAudio.className = `toolbar-btn ${isAudioMuted ? 'muted-audio' : 'active-audio'}`;
  btnAudio.querySelector('.btn-label').textContent = isAudioMuted ? 'Mudo' : 'Áudio';

  // Select de qualidade — destacar quando transmitindo
  const qualityWrap = document.getElementById('quality-select-wrap');
  if (qualityWrap) {
    qualityWrap.classList.toggle('broadcasting', isCameraOn || isScreenSharing);
  }
}

// ==================== LISTA DE SALAS ====================

function loadRoomsList() {
  if (!socket || !socket.connected) { connectSocket().then(() => fetchRooms()); return; }
  fetchRooms();
}

function renderRoomsList(roomsArr) {
  const c = document.getElementById('rooms-list');
  if (!c) return;
  // Só salas com gente (servidor já filtra; reforço no cliente)
  const active = (roomsArr || []).filter(r => (Number(r.participantCount) || 0) > 0);
  if (!active.length) {
    c.innerHTML = '<p class="rooms-empty">Nenhuma sala com pessoas no momento.</p>';
    return;
  }
  c.innerHTML = '';
  active.forEach(room => {
    const count = Number(room.participantCount) || 0;
    const countLabel = count === 1 ? '1 pessoa' : `${count} pessoas`;
    const item = document.createElement('div');
    item.className = 'room-list-item';
    item.innerHTML = `
      <div class="room-info">
        <div class="room-title">${room.name || room.id}</div>
        <div class="room-meta">${room.hasPassword ? '🔒 ' : ''}${room.ownerName || '—'} · ${countLabel}</div>
      </div>
      <div class="room-people-badge" title="${countLabel} na sala">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <span>${count}</span>
      </div>
      <div class="room-join-btn">Entrar</div>`;
    item.addEventListener('click', () => {
      document.getElementById('join-room-id').value = room.id;
      if (room.hasPassword) { document.getElementById('join-password').focus(); showToast('Esta sala tem senha.', 'info'); }
      else joinRoom(room.id, '');
    });
    c.appendChild(item);
  });
}

function fetchRooms() {
  socket.emit('list-rooms', (res) => {
    renderRoomsList(res.rooms);
  });
}

// ==================== MODAL: ESQUECI A SENHA ====================

function openForgotModal(roomId) {
  document.getElementById('forgot-room-id').value = roomId || document.getElementById('join-room-id').value.trim().toUpperCase();
  document.getElementById('forgot-owner-name').value = document.getElementById('global-username').value.trim();
  document.getElementById('forgot-new-password').value = '';
  document.getElementById('forgot-confirm-password').value = '';
  document.getElementById('forgot-error').classList.add('hidden');
  document.getElementById('forgot-error').textContent = '';
  document.getElementById('modal-forgot').classList.remove('hidden');
  setTimeout(() => document.getElementById('forgot-owner-name').focus(), 50);
}

function closeForgotModal() {
  document.getElementById('modal-forgot').classList.add('hidden');
}

async function submitForgotPassword() {
  const roomId      = document.getElementById('forgot-room-id').value.trim();
  const ownerName   = document.getElementById('forgot-owner-name').value.trim();
  const newPassword = document.getElementById('forgot-new-password').value;
  const confirmPass = document.getElementById('forgot-confirm-password').value;
  const errorEl     = document.getElementById('forgot-error');

  errorEl.classList.add('hidden');

  if (!ownerName) {
    errorEl.textContent = 'Digite o apelido que foi usado ao criar a sala.';
    errorEl.classList.remove('hidden'); return;
  }

  if (newPassword !== confirmPass) {
    errorEl.textContent = 'As senhas não coincidem.';
    errorEl.classList.remove('hidden'); return;
  }

  if (!(await connectSocket())) return;

  const btn = document.getElementById('btn-forgot-confirm');
  btn.textContent = 'Aguarde...';
  btn.disabled = true;

  socket.emit('reset-password', { roomId, ownerName, newPassword: newPassword.trim() }, (res) => {
    btn.textContent = 'Redefinir Senha';
    btn.disabled = false;

    if (res.success) {
      closeForgotModal();
      showToast('Senha redefinida! Agora pode entrar na sala.', 'success');
      // Preencher o campo de senha com a nova
      document.getElementById('join-password').value = newPassword.trim();
      document.getElementById('join-room-id').value = roomId;
    } else {
      errorEl.textContent = res.message || 'Erro ao redefinir a senha.';
      errorEl.classList.remove('hidden');
    }
  });
}

// Mostrar botão "Esqueci a senha" quando digitar ID de sala com senha
function checkShowForgotButton() {
  const roomId = document.getElementById('join-room-id').value.trim().toUpperCase();
  const btn    = document.getElementById('btn-forgot-password');
  if (!roomId || !socket || !socket.connected) { btn.classList.add('hidden'); return; }

  socket.emit('check-room', { roomId }, (res) => {
    if (res.exists && res.hasPassword) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  });
}

// ==================== PERFIL ====================

function applyAvatarTo(el, name, photoUrl) {
  if (photoUrl) {
    const safeInit = nameInitial(name);
    const safeColor = nameColor(name);
    el.innerHTML = `<img src="${photoUrl}" alt="${safeInit}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block" onerror="this.parentElement.textContent='${safeInit}';this.parentElement.style.background='linear-gradient(135deg,${safeColor},${safeColor}88)'">`;
    el.style.background = 'transparent';
    el.style.padding = '0';
  } else {
    el.innerHTML = nameInitial(name);
    el.style.background = `linear-gradient(135deg, ${nameColor(name)}, ${nameColor(name)}88)`;
    el.style.padding = '';
  }
}

function updateAvatarPreview() {
  const name     = (document.getElementById('global-username') || {}).value || '';
  const photoUrl = (document.getElementById('profile-photo-url') || {}).value || '';
  const av       = document.getElementById('avatar-preview');
  if (av) applyAvatarTo(av, name.trim() || '?', photoUrl.trim());
}

function showProfileView() {
  const name  = loadName();
  const photo = loadPhoto();
  const viewEl = document.getElementById('profile-view');
  const editEl = document.getElementById('profile-edit');
  if (!viewEl || !editEl) return;

  if (name) {
    document.getElementById('profile-name-display').textContent = name;
    const dispAv = document.getElementById('profile-avatar-display');
    if (dispAv) applyAvatarTo(dispAv, name, photo);
    viewEl.classList.remove('hidden');
    editEl.classList.add('hidden');
  } else {
    viewEl.classList.add('hidden');
    editEl.classList.remove('hidden');
    updateAvatarPreview();
  }
}

function enterEditMode() {
  const name  = loadName();
  const photo = loadPhoto();
  const usernameEl = document.getElementById('global-username');
  const photoEl    = document.getElementById('profile-photo-url');
  if (usernameEl) usernameEl.value = name;
  if (photoEl)    photoEl.value    = photo;
  document.getElementById('profile-view').classList.add('hidden');
  document.getElementById('profile-edit').classList.remove('hidden');
  updateAvatarPreview();
  setTimeout(() => usernameEl && usernameEl.focus(), 50);
}

async function saveProfile() {
  const nameEl  = document.getElementById('global-username');
  const photoEl = document.getElementById('profile-photo-url');
  const name    = nameEl ? nameEl.value.trim() : '';
  let photo   = photoEl ? photoEl.value.trim() : '';

  if (!name) {
    showToast('Digite seu apelido', 'error');
    if (nameEl) nameEl.focus();
    return;
  }

  // Garante que data:image grandes sejam comprimidos antes de salvar/enviar
  if (photo.startsWith('data:image/') && photo.length > 400000) {
    try {
      const blob = await (await fetch(photo)).blob();
      const file = new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' });
      photo = await compressImageFile(file, 380000, 256);
      if (photoEl) photoEl.value = photo;
    } catch (err) {
      console.warn('compress on save:', err);
    }
  }

  saveName(name);
  savePhoto(photo);
  myName = name;
  showProfileView();

  // Se já está em sala, avisa os outros da nova foto
  if (socket && currentRoomId && photo) {
    try {
      socket.emit('photo-share', { photoUrl: photo });
    } catch (_) {}
  }

  showToast('Perfil salvo!', 'success');
}

async function handlePhotoUpload(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    showToast('Arquivo muito grande. Use até 4MB ou cole uma URL.', 'error');
    return;
  }
  try {
    showToast('Processando imagem...', 'info');
    const dataUrl = await compressImageFile(file, 380000, 256);
    const photoEl = document.getElementById('profile-photo-url');
    if (photoEl) photoEl.value = dataUrl;
    updateAvatarPreview();
    showToast('Imagem pronta!', 'success');
  } catch (err) {
    console.error(err);
    showToast('Falha ao processar imagem', 'error');
  }
}

// ==================== EVENT LISTENERS ====================

document.getElementById('global-username').addEventListener('input', updateAvatarPreview);
document.getElementById('generate-room-id').addEventListener('click', () => {
  document.getElementById('create-room-id').value = generateRoomId();
});

// Perfil
document.getElementById('btn-edit-profile').addEventListener('click', enterEditMode);
document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
document.getElementById('global-username').addEventListener('keypress', e => {
  if (e.key === 'Enter') document.getElementById('profile-photo-url').focus();
});
document.getElementById('profile-photo-url').addEventListener('input', updateAvatarPreview);
document.getElementById('profile-photo-url').addEventListener('keypress', e => {
  if (e.key === 'Enter') saveProfile();
});

// Upload de arquivo
document.getElementById('btn-upload-photo').addEventListener('click', () => {
  document.getElementById('profile-photo-file').click();
});
document.getElementById('profile-photo-file').addEventListener('change', e => {
  handlePhotoUpload(e.target.files[0]);
});

// Drag and drop de imagem no avatar
document.getElementById('profile-edit-avatar-wrap').addEventListener('click', () => {
  document.getElementById('profile-photo-file').click();
});
document.getElementById('profile-edit-avatar-wrap').addEventListener('dragover', e => {
  e.preventDefault();
  e.currentTarget.style.opacity = '0.7';
});
document.getElementById('profile-edit-avatar-wrap').addEventListener('dragleave', e => {
  e.currentTarget.style.opacity = '1';
});
document.getElementById('profile-edit-avatar-wrap').addEventListener('drop', e => {
  e.preventDefault();
  e.currentTarget.style.opacity = '1';
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) handlePhotoUpload(file);
});document.getElementById('btn-create-room').addEventListener('click', createRoom);
document.getElementById('btn-join-room').addEventListener('click', () => joinRoom());

document.getElementById('btn-refresh-rooms').addEventListener('click', loadRoomsList);
document.getElementById('create-password').addEventListener('keypress', e => { if (e.key === 'Enter') createRoom(); });
document.getElementById('join-password').addEventListener('keypress', e => { if (e.key === 'Enter') joinRoom(); });
document.getElementById('global-username').addEventListener('keypress', e => { if (e.key === 'Enter') document.getElementById('create-room-id').focus(); });

// Verificar se sala tem senha ao digitar ID (para mostrar botão de recuperação)
document.getElementById('join-room-id').addEventListener('input', checkShowForgotButton);
document.getElementById('join-room-id').addEventListener('blur', checkShowForgotButton);

// Modal Esqueci a Senha
document.getElementById('btn-forgot-password').addEventListener('click', () => openForgotModal());
document.getElementById('btn-forgot-cancel').addEventListener('click', closeForgotModal);
document.getElementById('btn-forgot-confirm').addEventListener('click', submitForgotPassword);
document.getElementById('modal-forgot').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-forgot')) closeForgotModal();
});
document.getElementById('forgot-confirm-password').addEventListener('keypress', e => { if (e.key === 'Enter') submitForgotPassword(); });
document.getElementById('forgot-new-password').addEventListener('keypress', e => { if (e.key === 'Enter') document.getElementById('forgot-confirm-password').focus(); });

document.getElementById('btn-share-screen').addEventListener('click', () => {
  if (!supportsScreenShare()) {
    showToast('No celular use a Câmera para transmitir 📹', 'info');
    return;
  }
  if (isScreenSharing) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
});
document.getElementById('btn-camera').addEventListener('click', () => {
  if (isCameraOn) {
    stopCamera();
  } else {
    startCamera();
  }
});
// Virar câmera (mobile)
const btnFlipCam = document.getElementById('btn-flip-camera');
if (btnFlipCam) btnFlipCam.addEventListener('click', flipCamera);
document.getElementById('btn-mic').addEventListener('click', toggleMic);
document.getElementById('btn-audio').addEventListener('click', toggleAudio);
document.getElementById('btn-leave').addEventListener('click', () => leaveRoom(true));
document.getElementById('btn-delete-room').addEventListener('click', deleteRoom);
document.getElementById('btn-toggle-participants').addEventListener('click', () => {
  document.getElementById('participants-panel').classList.toggle('hidden');
});

// Fechar painel pelo botão X interno
const btnClosePanel = document.getElementById('btn-close-participants');
if (btnClosePanel) {
  btnClosePanel.addEventListener('click', () => {
    document.getElementById('participants-panel').classList.add('hidden');
  });
}

// Botão X do modal de senha
const btnForgotCancelX = document.getElementById('btn-forgot-cancel-x');
if (btnForgotCancelX) btnForgotCancelX.addEventListener('click', closeForgotModal);

// Prevenir double-tap zoom no mobile
let lastTap = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTap < 300) e.preventDefault();
  lastTap = now;
}, { passive: false });

// Clique direito em vídeo = menu de volume (não o menu nativo do browser)
document.addEventListener('contextmenu', e => {
  const tile = e.target.closest && e.target.closest('.stream-tile');
  if (tile && tile.dataset.peerId && tile.dataset.peerId !== myId) {
    e.preventDefault();
    showTileVolumeMenu(e.clientX, e.clientY, tile.dataset.peerId);
  } else if (e.target.tagName === 'VIDEO') {
    e.preventDefault();
  }
});

// ==================== MENU DE VOLUME (clique direito / long-press) ====================

function attachTileVolumeControls(tile, peerId) {
  if (!tile || !peerId || peerId === myId) return;
  if (tile.dataset.volBound) return;
  tile.dataset.volBound = '1';

  // Long-press no mobile (~450ms)
  let pressTimer = null;
  let startX = 0, startY = 0;
  const startPress = (x, y) => {
    startX = x; startY = y;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      showTileVolumeMenu(x, y, peerId);
    }, 450);
  };
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  tile.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startPress(t.clientX, t.clientY);
  }, { passive: true });
  tile.addEventListener('touchmove', e => {
    if (!pressTimer || !e.touches[0]) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 12 || Math.abs(t.clientY - startY) > 12) cancelPress();
  }, { passive: true });
  tile.addEventListener('touchend', cancelPress);
  tile.addEventListener('touchcancel', cancelPress);
}

function hideTileVolumeMenu() {
  if (tileContextMenuEl) {
    tileContextMenuEl.remove();
    tileContextMenuEl = null;
  }
}

function showTileVolumeMenu(x, y, peerId) {
  hideTileVolumeMenu();
  if (!peerId || peerId === myId) return;

  const p = participants.get(peerId);
  const name = (p && p.name) || 'Transmissão';
  const vol = getPeerVolume(peerId);
  const pct = Math.round(vol * 100);

  const menu = document.createElement('div');
  menu.className = 'tile-volume-menu';
  menu.innerHTML = `
    <div class="tvm-title">🔊 ${escapeHtml(name)}</div>
    <div class="tvm-row">
      <button type="button" class="tvm-btn" data-act="mute">${vol <= 0 ? '🔊 Ativar som' : '🔇 Silenciar'}</button>
    </div>
    <div class="tvm-slider-row">
      <span class="tvm-label">Volume</span>
      <input type="range" class="tvm-slider" min="0" max="100" value="${pct}" aria-label="Volume">
      <span class="tvm-pct">${pct}%</span>
    </div>
    <div class="tvm-row tvm-presets">
      <button type="button" class="tvm-btn tvm-sm" data-vol="25">25%</button>
      <button type="button" class="tvm-btn tvm-sm" data-vol="50">50%</button>
      <button type="button" class="tvm-btn tvm-sm" data-vol="75">75%</button>
      <button type="button" class="tvm-btn tvm-sm" data-vol="100">100%</button>
    </div>
    <div class="tvm-hint">Clique direito ou segure no tile</div>
  `;

  document.body.appendChild(menu);
  tileContextMenuEl = menu;

  // Posicionar dentro da viewport
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  const slider = menu.querySelector('.tvm-slider');
  const pctEl = menu.querySelector('.tvm-pct');
  const muteBtn = menu.querySelector('[data-act="mute"]');

  const updateUI = (v) => {
    const p2 = Math.round(v * 100);
    slider.value = String(p2);
    pctEl.textContent = p2 + '%';
    muteBtn.textContent = v <= 0 ? '🔊 Ativar som' : '🔇 Silenciar';
  };

  slider.addEventListener('input', () => {
    const v = Number(slider.value) / 100;
    setPeerVolume(peerId, v);
    updateUI(v);
  });

  muteBtn.addEventListener('click', () => {
    const next = getPeerVolume(peerId) <= 0 ? 1 : 0;
    setPeerVolume(peerId, next);
    updateUI(next);
    showToast(next <= 0 ? `Som de ${name} silenciado` : `Som de ${name} ativado`, 'info');
  });

  menu.querySelectorAll('[data-vol]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.vol) / 100;
      setPeerVolume(peerId, v);
      updateUI(v);
    });
  });

  // Fechar ao clicar fora
  const onDoc = (ev) => {
    if (menu.contains(ev.target)) return;
    hideTileVolumeMenu();
    document.removeEventListener('pointerdown', onDoc, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== SAIR AO FECHAR / RECARREGAR ====================

// beforeunload: sair ao fechar aba/janela
window.addEventListener('beforeunload', () => {
  if (currentRoomId && socket) {
    stopAllMedia();
    socket.emit('leave-room');
  }
});

// pagehide: fallback para iOS — só sair se NÃO for cache (persisted=false)
// persisted=true = apenas minimizou/trocou de app → NÃO sair da sala
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return; // Minimizou — manter na sala
  if (currentRoomId && socket) {
    stopAllMedia();
    socket.emit('leave-room');
  }
});

// visibilitychange: NÃO sair ao minimizar/background — reconectar + re-sincronizar participantes
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentRoomId) return;
  if (socket && !socket.connected) {
    connectSocket().then(() => requestRoomSync());
  } else {
    requestRoomSync();
  }
});
window.addEventListener('focus', () => {
  if (currentRoomId) requestRoomSync();
});

// ==================== SISTEMA DE TEMAS ====================

const THEMES = [
  { id: 'dark',      name: 'Dark'      },
  { id: 'amoled',    name: 'AMOLED'    },
  { id: 'light',     name: 'Light'     },
  { id: 'cyberpunk', name: 'Cyberpunk' },
  { id: 'ocean',     name: 'Ocean'     },
  { id: 'forest',    name: 'Forest'    },
  { id: 'ruby',      name: 'Ruby'      },
  { id: 'synthwave', name: 'Synthwave' }
];

let currentTheme = 'dark';

function applyTheme(themeId) {
  const valid = THEMES.find(t => t.id === themeId);
  if (!valid) themeId = 'dark';
  currentTheme = themeId;

  // Aplicar data-theme no html para as variáveis CSS funcionarem
  document.documentElement.setAttribute('data-theme', themeId);

  // Atualizar meta theme-color conforme o tema
  const themeColors = {
    dark:      '#0d0d14', amoled:    '#000000',
    light:     '#f1f5f9', cyberpunk: '#0a0010',
    ocean:     '#030d1a', forest:    '#060f08',
    ruby:      '#0f0508', synthwave: '#0d0521'
  };
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', themeColors[themeId] || '#0d0d14');

  // Salvar preferência
  try { localStorage.setItem('mc_theme', themeId); } catch (_) {}

  // Marcar card ativo no modal
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('active', card.dataset.themeId === themeId);
  });
}

function loadTheme() {
  try {
    const saved = localStorage.getItem('mc_theme');
    return saved || 'dark';
  } catch (_) { return 'dark'; }
}

function openThemeModal() {
  // Atualizar estado ativo dos cards antes de abrir
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('active', card.dataset.themeId === currentTheme);
  });
  document.getElementById('modal-themes').classList.remove('hidden');
}

function closeThemeModal() {
  document.getElementById('modal-themes').classList.add('hidden');
}

// Event listeners para cards de tema
document.querySelectorAll('.theme-card').forEach(card => {
  card.addEventListener('click', () => {
    applyTheme(card.dataset.themeId);
  });
});

// Botões para abrir o modal (lobby e sala)
document.getElementById('btn-theme-lobby').addEventListener('click', openThemeModal);
document.getElementById('btn-theme-room').addEventListener('click', openThemeModal);
document.getElementById('btn-themes-close').addEventListener('click', closeThemeModal);

// Fechar ao clicar fora
document.getElementById('modal-themes').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-themes')) closeThemeModal();
});

// ==================== CHAT ====================

function setupChatListeners() {
  socket.on('chat-message', (msg) => {
    if (msg && msg.id && msg.id !== myId) { try { playNotifySound('message'); } catch (_) {} }
    addChatMessage(msg);
    // Notificar se chat estiver fechado
    if (!chatOpen) {
      chatUnread++;
      const badge = document.getElementById('chat-badge');
      badge.textContent = chatUnread > 99 ? '99+' : chatUnread;
      badge.classList.remove('hidden');
      // Toast discreto
      showToast(`💬 ${msg.name}: ${msg.text.slice(0, 40)}${msg.text.length > 40 ? '...' : ''}`, 'info');
    }
  });
}

function addChatMessage(msg) {
  const container = document.getElementById('chat-messages');
  const isMe = msg.id === myId;
  const col  = nameColor(msg.name);
  const time = new Date(msg.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const div = document.createElement('div');
  div.className = `chat-msg${isMe ? ' own' : ''}`;

  const avHtml = (msg.photoUrl && msg.photoUrl.length > 10)
    ? `<div class="chat-msg-avatar" style="background:transparent;padding:0;overflow:hidden">
         <img src="${String(msg.photoUrl).replace(/"/g,'&quot;')}" alt=""
           style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block"
           onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,${col},${col}88)';this.parentElement.textContent='${nameInitial(msg.name)}';">
       </div>`
    : `<div class="chat-msg-avatar" style="background:linear-gradient(135deg,${col},${col}88)">${nameInitial(msg.name)}</div>`;

  div.innerHTML = `
    ${avHtml}
    <div class="chat-msg-body">
      <div class="chat-msg-header">
        <span class="chat-msg-name">${msg.name}</span>
        <span class="chat-msg-time">${time}</span>
      </div>
      <div class="chat-msg-text">${msg.text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    </div>`;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !socket || !currentRoomId) return;
  socket.emit('chat-message', { text });
  input.value = '';
  input.focus();
}

function toggleChat() {
  const panel = document.getElementById('chat-panel');
  chatOpen = !chatOpen;
  panel.classList.toggle('hidden', !chatOpen);

  if (chatOpen) {
    // Zerar badge
    chatUnread = 0;
    document.getElementById('chat-badge').classList.add('hidden');
    // Focar input
    setTimeout(() => document.getElementById('chat-input').focus(), 100);
    // Scroll para baixo
    const msgs = document.getElementById('chat-messages');
    msgs.scrollTop = msgs.scrollHeight;
  }
}

document.getElementById('btn-chat').addEventListener('click', toggleChat);
document.getElementById('btn-close-chat').addEventListener('click', () => {
  chatOpen = false;
  document.getElementById('chat-panel').classList.add('hidden');
});
document.getElementById('btn-chat-send').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keypress', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});

// ==================== SUPRESSÃO DE RUÍDOS ====================
let noiseCtx = null, noiseWorklet = null, noiseSource = null, noiseDest = null, noiseStream = null;
let noiseWorkletReady = false;

function getMicConstraints() {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: !!noiseSuppressionOn,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  };
}

async function ensureNoiseWorklet(ctx) {
  if (noiseWorkletReady) return true;
  try {
    await ctx.audioWorklet.addModule('/noise-processor.js');
    noiseWorkletReady = true;
    return true;
  } catch (err) {
    console.warn('Noise worklet:', err);
    return false;
  }
}

function destroyNoisePipeline() {
  try {
    if (noiseWorklet) { try { noiseWorklet.port.postMessage({ type: 'enable', value: false }); } catch (_) {} try { noiseWorklet.disconnect(); } catch (_) {} }
    try { noiseSource && noiseSource.disconnect(); } catch (_) {}
    try { noiseDest && noiseDest.disconnect(); } catch (_) {}
    if (noiseCtx && noiseCtx.state !== 'closed') { try { noiseCtx.close(); } catch (_) {} }
  } catch (_) {}
  noiseWorklet = null; noiseSource = null; noiseDest = null; noiseCtx = null; noiseStream = null;
}

async function applyNoiseSuppression(rawStream) {
  if (!rawStream || !rawStream.getAudioTracks().length) return rawStream;
  if (!noiseSuppressionOn) return rawStream;
  destroyNoisePipeline();
  try {
    noiseCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (noiseCtx.state === 'suspended') { try { await noiseCtx.resume(); } catch (_) {} }
    if (!(await ensureNoiseWorklet(noiseCtx))) return rawStream;
    noiseSource = noiseCtx.createMediaStreamSource(rawStream);
    noiseWorklet = new AudioWorkletNode(noiseCtx, 'noise-suppression-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    noiseDest = noiseCtx.createMediaStreamDestination();
    noiseWorklet.port.postMessage({ type: 'enable', value: true });
    noiseWorklet.port.postMessage({ type: 'threshold', value: 0.012 });
    noiseSource.connect(noiseWorklet);
    noiseWorklet.connect(noiseDest);
    noiseStream = noiseDest.stream;
    return noiseStream;
  } catch (err) {
    console.warn('applyNoiseSuppression:', err);
    destroyNoisePipeline();
    return rawStream;
  }
}

function updateNoiseButtonUI() {
  const btn = document.getElementById('btn-noise');
  if (!btn) return;
  btn.classList.toggle('active-noise', noiseSuppressionOn);
  btn.classList.toggle('off-noise', !noiseSuppressionOn);
  const label = btn.querySelector('.btn-label');
  if (label) label.textContent = noiseSuppressionOn ? 'Supressão de ruídos' : 'Supressão off';
  btn.title = noiseSuppressionOn ? 'Supressão de ruídos ativa — clique para desativar' : 'Supressão desativada — clique para ativar';
}

async function restartMicWithNoiseSetting() {
  if (!micStream && !isMicOn) return;
  destroyNoisePipeline();
  try {
    const raw = await navigator.mediaDevices.getUserMedia(getMicConstraints());
    if (micStream) { try { micStream.getTracks().forEach(t => t.stop()); } catch (_) {} }
    micStream = raw;
    isMicOn = true;
    let outStream = raw;
    if (noiseSuppressionOn) outStream = await applyNoiseSuppression(raw);
    const track = outStream.getAudioTracks()[0] || raw.getAudioTracks()[0];
    if (!isScreenSharing) {
      setOutboundAudioTrack(track, outStream);
      pushOutboundAudioToAllPeers();
    } else {
      pushOutboundAudioToAllPeers();
    }
    if (socket) socket.emit('mic-update', { hasMic: true, micMuted: false });
  } catch (err) {
    console.error(err);
    showToast('Não foi possível reaplicar o microfone', 'error');
  }
}

async function toggleNoiseSuppression() {
  noiseSuppressionOn = !noiseSuppressionOn;
  try { localStorage.setItem('mc_noise_suppression', noiseSuppressionOn ? '1' : '0'); } catch (_) {}
  updateNoiseButtonUI();
  if (micStream || isMicOn) await restartMicWithNoiseSetting();
  try { window.dispatchEvent(new CustomEvent('mc-noise-toggle', { detail: { enabled: noiseSuppressionOn } })); } catch (_) {}
  showToast(noiseSuppressionOn ? 'Supressão de ruídos ativada' : 'Supressão de ruídos desativada', noiseSuppressionOn ? 'success' : 'info');
}

window.NoiseSuppression = {
  isEnabled: () => !!noiseSuppressionOn,
  setEnabled: async (on) => { noiseSuppressionOn = !!on; updateNoiseButtonUI(); if (micStream || isMicOn) await restartMicWithNoiseSetting(); },
  toggle: () => toggleNoiseSuppression(),
  processStream: (s) => applyNoiseSuppression(s),
  getConstraints: () => getMicConstraints()
};

function destroyRNNoise() { destroyNoisePipeline(); }
async function applyRNNoise(raw) { return applyNoiseSuppression(raw); }
async function loadRNNoise() { return true; }

const btnNoiseEl = document.getElementById('btn-noise');
if (btnNoiseEl) btnNoiseEl.addEventListener('click', toggleNoiseSuppression);
try {
  const saved = localStorage.getItem('mc_noise_suppression');
  if (saved === '0') noiseSuppressionOn = false;
  if (saved === '1') noiseSuppressionOn = true;
} catch (_) {}
updateNoiseButtonUI();

// ==================== SELECT DE QUALIDADE (inline na toolbar) ====================

document.getElementById('quality-select').addEventListener('change', async (e) => {
  streamQuality = e.target.value;
  try { localStorage.setItem('mc_quality', streamQuality); } catch (_) {}

  const q = QUALITY_PRESETS[streamQuality];
  if (!q) return;

  const label = e.target.options[e.target.selectedIndex] ? e.target.options[e.target.selectedIndex].text : streamQuality;

  // Sempre atualizar bitrate / framerate / scaleResolutionDownBy nos senders
  const applyAll = async () => {
    for (const [, entry] of peers) {
      if (!entry.pc) continue;
      const vs = entry.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vs) await optimizeVideoSenderWithPreset(vs, q);
    }
  };
  await applyAll();
  // Segunda aplicação após um tick (alguns browsers só aplicam após negociação)
  setTimeout(() => { applyAll().catch(() => {}); }, 300);

  // Câmera: reaplicar constraints em tempo real
  if (isCameraOn && cameraStream) {
    const videoTrack = cameraStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        await videoTrack.applyConstraints({
          width:     { ideal: isMobile() ? Math.min(q.width, 640)  : q.width  },
          height:    { ideal: isMobile() ? Math.min(q.height, 480) : q.height },
          frameRate: { ideal: q.frameRate }
        });
        showToast(`Qualidade: ${label}`, 'success');
      } catch (err) {
        console.warn('applyConstraints falhou, recriando câmera:', err);
        await stopCamera();
        await startCamera();
      }
    }
  } else if (isScreenSharing && screenStream) {
    // Tela: tentar applyConstraints (alguns browsers respeitam frameRate/bitrate)
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        await videoTrack.applyConstraints({
          frameRate: { ideal: q.frameRate, max: Math.max(q.frameRate, 30) },
          width: { ideal: q.width, max: q.width },
          height: { ideal: q.height, max: q.height }
        });
      } catch (err) {
        console.warn('applyConstraints tela (parcial):', err);
      }
    }
    showToast(`Qualidade da tela: ${label} (bitrate/fps atualizados)`, 'success');
  } else {
    showToast(`Qualidade definida: ${label}`, 'info');
  }
});

// Melhora o clique no botão de qualidade (área maior + abre o select)
(function improveQualitySelectClick() {
  const wrap = document.getElementById('quality-select-wrap');
  const sel = document.getElementById('quality-select');
  if (!wrap || !sel) return;
  wrap.addEventListener('click', (e) => {
    if (e.target === sel) return;
    e.preventDefault();
    e.stopPropagation();
    // Abre o dropdown nativo de forma mais confiável
    try {
      sel.focus();
      if (typeof sel.showPicker === 'function') sel.showPicker();
      else sel.click();
    } catch (_) {
      sel.click();
    }
  });
})();

async function optimizeVideoSenderWithPreset(sender, q) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const isScreen = isScreenSharing;
    let down = 1;
    if (streamQuality === 'medium') down = isScreen ? 1.5 : 1.25;
    if (streamQuality === 'low') down = isScreen ? 2.5 : 2;
    params.encodings[0].scaleResolutionDownBy = down;
    params.encodings[0].maxBitrate = q.bitrate;
    params.encodings[0].maxFramerate = q.frameRate;
    params.degradationPreference = isScreen ? 'maintain-resolution' : 'balanced';
    await sender.setParameters(params);
  } catch (_) {}
}

function openQualityModal(type) {
  pendingStreamType = type;
  // Marcar qualidade atual
  document.querySelectorAll('.quality-option').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.quality === streamQuality);
  });
  document.getElementById('modal-quality').classList.remove('hidden');
}

function closeQualityModal() {
  document.getElementById('modal-quality').classList.add('hidden');
  pendingStreamType = null;
}

document.getElementById('btn-quality-close').addEventListener('click', closeQualityModal);
document.getElementById('modal-quality').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-quality')) closeQualityModal();
});

document.querySelectorAll('.quality-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    streamQuality = btn.dataset.quality;
    document.querySelectorAll('.quality-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    closeQualityModal();

    // Iniciar transmissão com a qualidade escolhida
    if (pendingStreamType === 'camera') {
      await startCamera();
    } else if (pendingStreamType === 'screen') {
      await startScreenShare();
    }
  });
});

// ==================== INIT ====================

(function init() {
  // Aplicar tema salvo ANTES de tudo (evita flash de tema errado)
  applyTheme(loadTheme());

  // Restaurar qualidade salva
  try {
    const savedQ = localStorage.getItem('mc_quality');
    if (savedQ && ['high','medium','low'].includes(savedQ)) {
      streamQuality = savedQ;
      const sel = document.getElementById('quality-select');
      if (sel) sel.value = savedQ;
    }
  } catch (_) {}

  const saved = loadName();
  if (saved) {
    const el = document.getElementById('global-username');
    if (el) el.value = saved;
  }
  showProfileView();
  connectSocket().then(() => fetchRooms());
})();
