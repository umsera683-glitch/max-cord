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
let noiseSuppressionOn = false;  // RNNoise removido da UI
let currentFacingMode = 'user';  // câmera frontal por padrão
let streamQuality = 'high';      // qualidade padrão
let pendingStreamType = null;    // 'screen' | 'camera' — aguardando modal de qualidade

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

// Volume por peer (0–1). Default 1. Usado no clique direito / long-press
const peerVolumes = new Map();
let tileContextMenuEl = null;

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
// Open Relay Project — gratuito, sem cadastro

// WebRTC: DTLS/SRTP é obrigatório nos browsers modernos para media tracks.
// STUN/TURN só auxiliam NAT traversal; mídia permanece criptografada ponta a ponta quando P2P.
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
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
  iceCandidatePoolSize: 4,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

function shouldOffer(peerId) {
  return !!(myId && peerId && myId < peerId);
}

// ==================== UTILITÁRIOS ====================

function nameInitial(name) { return (name || '?').charAt(0).toUpperCase(); }

function nameColor(name) {
  const colors = ['#7c3aed','#2563eb','#0891b2','#059669','#d97706','#dc2626','#db2777','#0d9488'];
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return colors[h % colors.length];
}


// ==================== SONS DE NOTIFICAÇÃO ====================
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}
/** type: message | join | leave | announce */
function playSound(type) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    const tone = (freqStart, freqEnd, dur, peak, wave) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = wave || 'sine';
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.setValueAtTime(freqStart, now);
      if (freqEnd && freqEnd !== freqStart) {
        o.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), now + dur * 0.85);
      }
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.start(now);
      o.stop(now + dur + 0.02);
    };

    if (type === 'join') {
      // Entrada — um pouco mais presente
      tone(520, 820, 0.32, 0.22, 'sine');
    } else if (type === 'leave') {
      tone(420, 200, 0.36, 0.18, 'triangle');
    } else if (type === 'announce') {
      // Aviso do site — dois toques suaves e claros
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const g = ctx.createGain();
      o1.type = 'sine';
      o2.type = 'sine';
      o1.frequency.setValueAtTime(660, now);
      o2.frequency.setValueAtTime(880, now + 0.12);
      o1.connect(g);
      o2.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.24, now + 0.03);
      g.gain.exponentialRampToValueAtTime(0.08, now + 0.12);
      g.gain.exponentialRampToValueAtTime(0.26, now + 0.16);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      o1.start(now);
      o1.stop(now + 0.14);
      o2.start(now + 0.12);
      o2.stop(now + 0.48);
    } else {
      // message — bip um pouco mais audível
      tone(900, 700, 0.18, 0.16, 'sine');
    }
  } catch (_) {}
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Texto de usuário: remove controles, limita tamanho e bloqueia padrões perigosos. */
function sanitizeUserText(val, maxLen) {
  if (typeof val !== 'string') return '';
  let s = val.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  s = s.slice(0, maxLen || 100);
  // Neutraliza tentativas óbvias de markup/handlers
  s = s.replace(/[<>]/g, '').replace(/javascript:/gi, '').replace(/data:text\/html/gi, '');
  return s;
}

/** ~5MB em data URL (GIF/imagem). Arquivo original costuma ser ~30% menor. */
const MAX_PHOTO_DATA_LEN = 5 * 1024 * 1024;
const MAX_PHOTO_FILE_BYTES = 8 * 1024 * 1024;

function isSafePhotoUrl(url) {
  if (typeof url !== 'string') return false;
  const s = url.trim();
  if (!s) return false;
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/i.test(s) && s.length <= MAX_PHOTO_DATA_LEN) return true;
  if (/^https?:\/\//i.test(s) && s.length <= 8000 && !/[\s<>"']/g.test(s)) return true;
  return false;
}

function showToast(msg, type) {
  type = type || 'info';
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = document.createElement('span');
  icon.textContent = icons[type] || icons.info;
  const text = document.createElement('span');
  text.textContent = String(msg == null ? '' : msg);
  el.appendChild(icon);
  el.appendChild(text);
  const box = document.getElementById('toast-container');
  if (box) box.appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 3200);
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 640;
}

function supportsScreenShare() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function saveName(n) {
  try { localStorage.setItem('sh_username', sanitizeUserText(n, 20)); } catch (_) {}
}
function loadName() {
  try { return sanitizeUserText(localStorage.getItem('sh_username') || '', 20); } catch (_) { return ''; }
}

/** Quando mudar este valor, todos os navegadores apagam perfil local e pedem conta nova. */
const ACCOUNTS_EPOCH = '2026-11-08-reset-v1';
const ACCOUNTS_EPOCH_KEY = 'mc_accounts_epoch';

function clearLocalProfileData() {
  try {
    localStorage.removeItem('sh_username');
    localStorage.removeItem('sh_photo');
    localStorage.removeItem('mc_user_id');
    // Força recriar perfil (e reaceitar fluxo de conta)
    localStorage.removeItem(TERMS_KEY);
    localStorage.removeItem(TERMS_META_KEY);
  } catch (_) {}
  try {
    sessionStorage.removeItem('mc_closed_anns');
  } catch (_) {}
  _photoMemory = '';
  try { idbSetPhoto(''); } catch (_) {}
  window.__mcIsAdmin = false;
  window.__mcUserId = null;
  myName = '';
}

/** Limpa contas antigas do navegador uma vez (site reiniciou contagem de contas). */
function ensureFreshAccountsEpoch() {
  try {
    const cur = localStorage.getItem(ACCOUNTS_EPOCH_KEY);
    if (cur === ACCOUNTS_EPOCH) return false;
    clearLocalProfileData();
    localStorage.setItem(ACCOUNTS_EPOCH_KEY, ACCOUNTS_EPOCH);
    return true;
  } catch (_) {
    clearLocalProfileData();
    return true;
  }
}

const TERMS_KEY = 'mc_terms_accepted_v1';
const TERMS_META_KEY = 'mc_terms_meta_v1';

function loadTermsMeta() {
  try {
    const raw = localStorage.getItem(TERMS_META_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (_) { return null; }
}

function loadTermsAccepted() {
  try {
    if (localStorage.getItem(TERMS_KEY) === '1') return true;
    const meta = loadTermsMeta();
    return !!(meta && meta.accepted);
  } catch (_) { return false; }
}

/** Data de aceite imutável — só lê do storage, nunca inventa data nova. */
function getTermsAcceptedAt() {
  const meta = loadTermsMeta();
  if (meta && meta.at) return meta.at;
  return null;
}

/** Salva aceite ligado ao perfil (apelido) + data.
 *  A data original NUNCA é alterada depois do primeiro aceite,
 *  mesmo se o usuário editar o perfil depois. */
function saveTermsAccepted(profileName) {
  const name = sanitizeUserText(profileName || loadName() || '', 20);
  const existing = loadTermsMeta();
  // Se já aceitou e já tem data, NÃO regrava data nem nada crítico
  if (existing && existing.accepted && existing.at) {
    // Só atualiza o nome vinculado, se mudou — data fica intocada
    if (name && name !== existing.name) {
      const meta = Object.assign({}, existing, { name: name });
      try { localStorage.setItem(TERMS_META_KEY, JSON.stringify(meta)); } catch (_) {}
      return meta;
    }
    return existing;
  }
  // Primeiro aceite de verdade
  const meta = {
    accepted: true,
    name: name || (existing && existing.name) || '',
    at: (existing && existing.at) || new Date().toISOString(),
    version: 'v1'
  };
  try {
    localStorage.setItem(TERMS_KEY, '1');
    localStorage.setItem(TERMS_META_KEY, JSON.stringify(meta));
  } catch (_) {}
  return meta;
}

/** Atualiza só o nome no meta dos termos, sem tocar na data de aceite. */
function bindTermsMetaName(profileName) {
  const name = sanitizeUserText(profileName || loadName() || '', 20);
  const existing = loadTermsMeta();
  if (!existing || !existing.accepted) return existing;
  if (!name || name === existing.name) return existing;
  const meta = Object.assign({}, existing, { name: name });
  try { localStorage.setItem(TERMS_META_KEY, JSON.stringify(meta)); } catch (_) {}
  return meta;
}

function formatTermsDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) { return ''; }
}

/** Emblema MaxCord — marca de quem aceitou os Termos / Privacidade */
function createTermsBadgeEl(compact) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'mc-terms-badge' + (compact ? ' mc-terms-badge--compact' : '');
  el.setAttribute('aria-label', 'Termos de uso e política de privacidade aceitos');
  const w = compact ? 20 : 28;
  const h = compact ? 24 : 34;
  const gid = 'mcSg' + Math.random().toString(36).slice(2, 9);
  const fid = 'mcSf' + Math.random().toString(36).slice(2, 9);
  el.innerHTML = `
    <svg class="mc-terms-shield" viewBox="0 0 80 96" width="${w}" height="${h}" aria-hidden="true">
      <defs>
        <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fff3c4"/>
          <stop offset="35%" stop-color="#ffd56a"/>
          <stop offset="70%" stop-color="#f0a93a"/>
          <stop offset="100%" stop-color="#d4881a"/>
        </linearGradient>
        <filter id="${fid}" x="-20%" y="-10%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.2" flood-color="#000" flood-opacity="0.28"/>
        </filter>
      </defs>
      <path filter="url(#${fid})" fill="url(#${gid})" stroke="#b87510" stroke-width="2" stroke-linejoin="round"
        d="M40 4c3.5 0 7 1.4 7 3.8V10h12c2.8 0 5 2.2 5 5v28c0 18-10.5 31.5-24 39.5C26.5 74.5 16 61 16 43V15c0-2.8 2.2-5 5-5h12V7.8C33 5.4 36.5 4 40 4z"/>
      <path fill="#6d28d9" stroke="#4c1d95" stroke-width="0.8" stroke-linejoin="round"
        d="M40 22l4.2 3.2 5.1-.5 1.9 4.8 4.6 2.2-1.9 4.9 1.4 5-4.6 2.1-1.9 4.8-5.1-.6L40 51.5l-3.7-3.6-5.1.6-1.9-4.8-4.6-2.1 1.4-5-1.9-4.9 4.6-2.2 1.9-4.8 5.1.5L40 22z"/>
      <circle cx="40" cy="36" r="2.2" fill="#c4b5fd"/>
      <text x="40" y="70" text-anchor="middle" font-size="9.5" font-weight="800" fill="#4c1d95" font-family="system-ui,-apple-system,sans-serif" letter-spacing="0.5">TERMOS</text>
      <text x="40" y="81" text-anchor="middle" font-size="9.5" font-weight="800" fill="#4c1d95" font-family="system-ui,-apple-system,sans-serif" letter-spacing="0.5">ACEITOS</text>
    </svg>`;
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTermsBadgePopover(el);
  });
  return el;
}

function openTermsBadgePopover(anchorEl) {
  const pop = document.getElementById('mc-terms-popover');
  if (!pop) return;
  pop.classList.remove('hidden');
  const r = anchorEl.getBoundingClientRect();
  const card = pop.querySelector('.mc-terms-popover-card');
  const pad = 10;
  let top = r.bottom + 8;
  let left = r.left + r.width / 2;
  pop.style.top = '0px';
  pop.style.left = '0px';
  const cw = card.offsetWidth || 260;
  const ch = card.offsetHeight || 120;
  left = Math.min(Math.max(pad + cw / 2, left), window.innerWidth - pad - cw / 2);
  if (top + ch + pad > window.innerHeight) {
    top = Math.max(pad, r.top - ch - 8);
  }
  card.style.position = 'fixed';
  card.style.top = top + 'px';
  card.style.left = left + 'px';
  card.style.transform = 'translateX(-50%)';
}

function closeTermsBadgePopover() {
  const pop = document.getElementById('mc-terms-popover');
  if (pop) pop.classList.add('hidden');
}

function updateProfileTermsBadge() {
  const badge = document.getElementById('profile-terms-badge');
  if (!badge) return;
  if (loadTermsAccepted()) badge.classList.remove('hidden');
  else badge.classList.add('hidden');
}

// Foto em memória + IndexedDB (localStorage estoura com GIF/data URL grande)
let _photoMemory = '';
const PHOTO_IDB_NAME = 'maxcord_profile';
const PHOTO_IDB_STORE = 'photos';
const PHOTO_IDB_KEY = 'avatar';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('no idb'));
    const req = indexedDB.open(PHOTO_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTO_IDB_STORE)) {
        db.createObjectStore(PHOTO_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb open fail'));
  });
}

function idbSetPhoto(url) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(PHOTO_IDB_STORE, 'readwrite');
      const store = tx.objectStore(PHOTO_IDB_STORE);
      if (url) store.put(url, PHOTO_IDB_KEY);
      else store.delete(PHOTO_IDB_KEY);
      tx.oncomplete = () => { try { db.close(); } catch (_) {} resolve(true); };
      tx.onerror = () => { try { db.close(); } catch (_) {} reject(tx.error); };
    } catch (e) { reject(e); }
  })).catch(() => false);
}

function idbGetPhoto() {
  return idbOpen().then(db => new Promise((resolve) => {
    try {
      const tx = db.transaction(PHOTO_IDB_STORE, 'readonly');
      const req = tx.objectStore(PHOTO_IDB_STORE).get(PHOTO_IDB_KEY);
      req.onsuccess = () => {
        try { db.close(); } catch (_) {}
        resolve(typeof req.result === 'string' ? req.result : '');
      };
      req.onerror = () => { try { db.close(); } catch (_) {} resolve(''); };
    } catch (_) { resolve(''); }
  })).catch(() => '');
}

function savePhoto(url) {
  let u = url || '';
  if (u && !isSafePhotoUrl(u)) u = '';
  _photoMemory = u;
  // URLs curtas no localStorage; data URLs (GIF/imagem) no IndexedDB
  try {
    if (u && /^https?:\/\//i.test(u) && u.length <= 8000) {
      localStorage.setItem('sh_photo', u);
      idbSetPhoto(''); // limpa data antiga
    } else if (u && u.startsWith('data:')) {
      try { localStorage.removeItem('sh_photo'); } catch (_) {}
      idbSetPhoto(u);
    } else if (!u) {
      try { localStorage.removeItem('sh_photo'); } catch (_) {}
      idbSetPhoto('');
    } else {
      try { localStorage.setItem('sh_photo', u); } catch (_) {}
      idbSetPhoto(u);
    }
  } catch (_) {
    idbSetPhoto(u);
  }
}

function loadPhoto() {
  if (_photoMemory && isSafePhotoUrl(_photoMemory)) return _photoMemory;
  try {
    const stored = localStorage.getItem('sh_photo') || '';
    if (stored && isSafePhotoUrl(stored)) return stored;
  } catch (_) {}
  return '';
}

/** Carrega foto do IndexedDB para memória (chamar no boot). */
async function hydratePhotoFromIdb() {
  if (_photoMemory && isSafePhotoUrl(_photoMemory)) return _photoMemory;
  try {
    const stored = localStorage.getItem('sh_photo') || '';
    if (stored && isSafePhotoUrl(stored)) {
      _photoMemory = stored;
      return stored;
    }
  } catch (_) {}
  const fromIdb = await idbGetPhoto();
  if (fromIdb && isSafePhotoUrl(fromIdb)) {
    _photoMemory = fromIdb;
    return fromIdb;
  }
  return '';
}

/** Envia a foto atual para todos na sala verem o perfil. */
function broadcastMyPhoto() {
  if (!socket || !socket.connected || !currentRoomId) return;
  const photo = loadPhoto();
  if (!photo || !isSafePhotoUrl(photo)) return;
  socket.emit('photo-share', { photoUrl: photo });
}

// ==================== SOCKET ====================

function connectSocket() {
  return new Promise(resolve => {
    if (socket && socket.connected) return resolve(true);

    if (!socket) {
      socket = io(window.SOCKET_URL || location.origin, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 8,
        reconnectionDelay: 800,
        reconnectionDelayMax: 4000,
        timeout: 8000
      });
      setupSocketListeners();
      setupChatListeners();
    }

    const onOk = () => { myId = socket.id; cleanup(); resolve(true); };
    const onErr = (err) => {
      console.warn('Socket connect_error:', err && err.message);
      cleanup();
      resolve(!!socket.connected);
    };
    const cleanup = () => {
      socket.off('connect', onOk);
      socket.off('connect_error', onErr);
    };
    socket.on('connect', onOk);
    socket.on('connect_error', onErr);
    if (socket.connected) onOk();
    setTimeout(() => { if (!socket.connected) { cleanup(); resolve(false); } }, 8000);
  });
}

// ==================== LISTENERS DO SOCKET ====================

function setupSocketListeners() {
  if (!socket || socketListenersBound) return;
  socketListenersBound = true;

  socket.on('user-joined', (data) => {
    if (!data || !data.id || data.id === myId) return;
    participants.set(data.id, {
      name: data.name, isOwner: data.isOwner,
      isBroadcasting: false, broadcastType: null, hasMic: false, micMuted: true,
      photoUrl: data.photoUrl || '',
      termsAccepted: !!data.termsAccepted,
      isAdmin: !!data.isAdmin,
      userId: data.userId || null
    });
    // Garante que o novo usuário receba minha foto (GIF/imagem)
    setTimeout(() => broadcastMyPhoto(), 200);
    updateParticipantCount();
    renderParticipantsList();
    showToast(`${data.name} entrou na sala`, 'info');
    playSound('join');
    const pc = connectToPeer(data.id);
    // Se já estamos transmitindo (tela com som do sistema incluso), reenvia tudo
    if (pc && (isScreenSharing || isCameraOn || getOutboundAudioTrack())) {
      addLocalTracksToPeer(pc);
      // Reaplica áudio da tela explicitamente (late joiner / reentrada)
      const outA = getOutboundAudioTrack();
      if (outA) replaceAudioTrackInPeer(pc, outA);
      setTimeout(() => {
        const entry = peers.get(data.id);
        if (!entry || !entry.pc) return;
        addLocalTracksToPeer(entry.pc);
        const a2 = getOutboundAudioTrack();
        if (a2) replaceAudioTrackInPeer(entry.pc, a2);
        if (shouldOffer(data.id) && entry.pc.signalingState === 'stable') {
          try {
            entry.makingOffer = true;
            entry.pc.createOffer().then(offer => {
              return entry.pc.setLocalDescription(offer).then(() => {
                if (socket) socket.emit('offer', { targetId: data.id, sdp: entry.pc.localDescription });
              });
            }).catch(() => {}).finally(() => { entry.makingOffer = false; });
          } catch (_) {}
        }
      }, 400);
      setTimeout(() => {
        const entry = peers.get(data.id);
        if (!entry || !entry.pc) return;
        addLocalTracksToPeer(entry.pc);
        const a3 = getOutboundAudioTrack();
        if (a3) replaceAudioTrackInPeer(entry.pc, a3);
      }, 1200);
    }
  });

  socket.on('user-left', (data) => {
    participants.delete(data.id);
    closePeer(data.id);
    removeTilesByPeer(data.id);
    updateParticipantCount();
    renderParticipantsList();
    if (data && data.kicked) {
      showToast(`${data.name} foi desconectado pela administração`, 'info');
    } else {
      showToast(`${data.name} saiu da sala`, 'info');
    }
    playSound('leave');
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

  socket.on('kicked', (data) => {
    showToast((data && data.message) || 'Você foi desconectado da sala pela administração.', 'error');
    setTimeout(() => leaveRoom(false), 1200);
  });

  // Admin forçou mudança de nome neste cliente
  socket.on('force-rename', (data) => {
    const name = sanitizeUserText((data && data.name) || '', 20);
    if (!name) return;
    saveName(name);
    myName = name;
    const el = document.getElementById('global-username');
    if (el) el.value = name;
    bindTermsMetaName(name);
    updateAdminUI();
    showProfileView();
    showToast((data && data.message) || ('Seu nome foi alterado para ' + name), 'info');
    if (currentRoomId) renderParticipantsList();
  });

  // Admin apagou esta conta (ou reset geral)
  socket.on('account-deleted', (data) => {
    showToast((data && data.message) || 'Sua conta foi removida pela administração.', 'error');
    clearLocalProfileData();
    const el = document.getElementById('global-username');
    if (el) el.value = '';
    const photoEl = document.getElementById('profile-photo-url');
    if (photoEl) photoEl.value = '';
    if (currentRoomId) leaveRoom(false);
    setTimeout(() => {
      showProfileView();
      if (typeof enterEditMode === 'function') enterEditMode();
    }, 400);
  });

  // Alguém na sala teve o nome alterado pelo admin
  socket.on('user-renamed', (data) => {
    if (!data || !data.id) return;
    if (data.id === myId) return;
    const p = participants.get(data.id);
    if (p) {
      p.name = data.name;
      p.isAdmin = !!data.isAdmin;
      p.userId = data.userId || null;
      renderParticipantsList();
    }
  });

  socket.on('site-announcement', (ann) => {
    if (ann) showSiteAnnouncement(ann);
  });

  // Sync completo enviado pelo servidor ao conectar
  socket.on('site-announcements-sync', (data) => {
    const list = (data && data.announcements) || [];
    list.forEach(a => showSiteAnnouncement(a, { silent: true }));
  });

  socket.on('site-announcement-cleared', (data) => {
    if (data && data.id) removeSiteAnnouncement(data.id);
    else clearAllSiteAnnouncements();
  });

  // Receber foto de perfil de outro participante (enviada diretamente, não via servidor)
  socket.on('photo-share', (data) => {
    if (!data || !data.id) return;
    const url = (data.photoUrl || '').trim();
    if (!url || !isSafePhotoUrl(url)) return;
    const p = participants.get(data.id);
    if (p) {
      p.photoUrl = url;
      renderParticipantsList();
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
    if (fromId && fromId !== myId) connectToPeer(fromId);
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

function connectToPeer(peerId) {
  if (!peerId || peerId === myId) return null;
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
    const q = (typeof QUALITY_PRESETS !== 'undefined' && QUALITY_PRESETS[streamQuality])
      ? QUALITY_PRESETS[streamQuality]
      : { bitrate: 2500000, frameRate: 30, scale: 1 };
    const n = Math.max(1, peers.size);
    // Bitrate conforme qualidade escolhida; divide levemente com muitos peers
    let br = q.bitrate || 2500000;
    if (n > 2) br = Math.round(br / Math.sqrt(n / 2));
    params.encodings[0].maxBitrate = br;
    params.encodings[0].maxFramerate = q.frameRate || 30;
    if (q.scale && q.scale > 1) {
      params.encodings[0].scaleResolutionDownBy = q.scale;
    } else {
      params.encodings[0].scaleResolutionDownBy = 1;
    }
    params.degradationPreference = isScreenSharing ? 'maintain-framerate' : 'balanced';
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
  audio.play().catch(() => {});
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
  const v = peerVolumes.get(peerId);
  return v === undefined ? 1 : v;
}

function setPeerVolume(peerId, vol) {
  vol = Math.max(0, Math.min(1, Number(vol) || 0));
  peerVolumes.set(peerId, vol);
  applyPeerVolume(peerId);
}

function applyPeerVolume(peerId) {
  const vol = getPeerVolume(peerId);
  const mutedGlobally = isAudioMuted;
  const effectiveMuted = mutedGlobally || vol <= 0;
  const effectiveVol = mutedGlobally ? 0 : vol;

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
    video.volume = isAudioMuted ? 0 : vol;
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
    tile.addEventListener('click', () => makeTileFullscreen(tile));
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
  const micAv = document.createElement('div');
  micAv.className = 'mic-avatar';
  micAv.style.background = `linear-gradient(135deg,${col},${col}88)`;
  micAv.textContent = '🎙️';
  const micName = document.createElement('div');
  micName.className = 'mic-name';
  micName.textContent = String(name || 'Remoto');
  tile.appendChild(micAv);
  tile.appendChild(micName);
  attachTileVolumeControls(tile, peerId);

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.srcObject = stream;
  audio.muted = isAudioMuted || isPeerMuted(peerId);
  audio.volume = getPeerVolume(peerId);
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

function updateTileLabel(tile, name, type) {
  const label = tile.querySelector('.stream-tile-label');
  if (!label) return;
  const col = nameColor(name);
  const icon = type === 'camera' ? '📹' : '🖥️';
  while (label.firstChild) label.removeChild(label.firstChild);
  const av = document.createElement('div');
  av.className = 'tile-avatar';
  av.style.background = `linear-gradient(135deg,${col},${col}88)`;
  av.textContent = nameInitial(name);
  const nm = document.createElement('span');
  nm.className = 'tile-name';
  nm.textContent = String(name || '');
  const badge = document.createElement('span');
  badge.className = 'tile-type-badge';
  badge.textContent = icon;
  label.appendChild(av);
  label.appendChild(nm);
  label.appendChild(badge);
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
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFs) {
    const video = tile.querySelector('video');
    if (video && video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
    const req = tile.requestFullscreen || tile.webkitRequestFullscreen;
    if (req) req.call(tile).catch(() => {});
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
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

// Constraints de microfone otimizadas para mobile e desktop
function getMicConstraints() {
  return {
    audio: {
      echoCancellation:   noiseSuppressionOn,
      noiseSuppression:   noiseSuppressionOn,
      autoGainControl:    noiseSuppressionOn,
      channelCount:       1,
      sampleRate:         48000,
      sampleSize:         16
    },
    video: false
  };
}

async function startMic() {
  if (micStream) return true;
  try {
    // Carregar RNNoise em background na primeira vez que o mic é usado
    if (!rnnoiseReady) loadRNNoise();

    const raw = await navigator.mediaDevices.getUserMedia(getMicConstraints());
    micStream = raw;
    isMicOn = true;
    socket.emit('mic-update', { hasMic: true, micMuted: false });

    let trackToSend = raw.getAudioTracks()[0];

    // Se RNNoise já carregou e supressão está ligada, aplicar pipeline
    if (noiseSuppressionOn && rnnoiseReady) {
      const processed = await applyRNNoise(raw);
      trackToSend = processed.getAudioTracks()[0] || trackToSend;
    }

    // Se NÃO está compartilhando tela, o mic é o áudio de saída
    if (!isScreenSharing) {
      setOutboundAudioTrack(trackToSend, micStream);
      pushOutboundAudioToAllPeers();
    } else {
      // Tela ativa: mantém outbound da tela; peers já recebem via getOutboundAudioTrack
      for (const [, entry] of peers) {
        if (entry.pc) replaceAudioTrackInPeer(entry.pc, getOutboundAudioTrack() || trackToSend);
      }
    }
    return true;
  } catch (err) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      isMicOn = true;
      socket.emit('mic-update', { hasMic: true, micMuted: false });
      const track = micStream.getAudioTracks()[0];
      if (!isScreenSharing) {
        setOutboundAudioTrack(track, micStream);
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
  destroyRNNoise();
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

async function acquireDisplayMedia() {
  const attempts = [
    {
      video: {
        frameRate: { ideal: 24, max: 30 },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 }
      },
      audio: true,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include'
    },
    { video: { frameRate: { ideal: 24 } }, audio: true },
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
    tile.addEventListener('click', () => makeTileFullscreen(tile));

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

  const stopStream = (stream) => {
    if (!stream) return;
    try {
      stream.getTracks().forEach(t => {
        try { t.onended = null; } catch (_) {}
        try { t.stop(); } catch (_) {}
      });
    } catch (_) {}
  };
  stopStream(screenStream); screenStream = null;
  stopStream(cameraStream); cameraStream = null;
  stopStream(micStream); micStream = null;
  stopStream(outboundAudioStream); outboundAudioStream = null;
  outboundAudioTrack = null;

  // Garante liberação de tracks órfãs em peers locais
  for (const [, entry] of peers) {
    if (!entry || !entry.pc) continue;
    try {
      entry.pc.getSenders().forEach(s => {
        if (s.track) {
          try { s.track.stop(); } catch (_) {}
          try { s.replaceTrack(null); } catch (_) {}
        }
      });
    } catch (_) {}
  }

  isScreenSharing = false; isCameraOn = false; isMicOn = false;
  screenShareBusy = false;
}

// ==================== GESTÃO DE SALAS ====================

function validateName() {
  // Tentar usar nome salvo no perfil ou o que estiver no input
  const fromInput = document.getElementById('global-username');
  const n = sanitizeUserText((fromInput ? fromInput.value : '') || loadName(), 20);
  if (!n) { showToast('Digite seu apelido antes de continuar', 'error'); enterEditMode(); return null; }
  return n;
}

async function createRoom() {
  const name = validateName(); if (!name) return;
  const roomId   = sanitizeUserText(document.getElementById('create-room-id').value, 12).toUpperCase() || generateRoomId();
  const rName    = sanitizeUserText(document.getElementById('create-room-name').value, 30);
  const password = sanitizeUserText(document.getElementById('create-password').value, 60);

  if (!rName) {
    showToast('Digite o nome da sala antes de criar', 'error');
    document.getElementById('create-room-name').focus();
    return;
  }

  if (!(await connectSocket())) return;
  myName = name; saveName(name);
  lastJoinPassword = password || '';

  socket.emit('create-room', {
    roomId, roomName: rName, password, userName: name,
    photoUrl: loadPhoto(), termsAccepted: loadTermsAccepted()
  }, (res) => {
    if (res.success) {
      isOwner = true;
      if (res.isAdmin) { window.__mcIsAdmin = true; window.__mcUserId = res.userId || '01'; updateAdminUI(); }
      enterRoom(res.roomId, rName, true);
    }
    else showToast(res.message, 'error');
  });
}

async function joinRoom(roomId, password) {
  const name = validateName(); if (!name) return;
  roomId   = roomId   !== undefined ? roomId   : document.getElementById('join-room-id').value.trim().toUpperCase();
  password = password !== undefined ? password : document.getElementById('join-password').value.trim();
  if (!roomId) { showToast('Digite o ID da sala', 'error'); return; }

  if (!(await connectSocket())) return;
  myName = name; saveName(name);
  lastJoinPassword = password || '';

  socket.emit('join-room', {
    roomId, password, userName: name,
    photoUrl: loadPhoto(), termsAccepted: loadTermsAccepted()
  }, (res) => {
    if (res.success) {
      isOwner = res.isOwner;
      if (res.isAdmin) { window.__mcIsAdmin = true; window.__mcUserId = res.userId || '01'; updateAdminUI(); }
      participants.clear();
      res.participants.forEach(p => participants.set(p.id, {
        name: p.name, isOwner: p.isOwner,
        isBroadcasting: p.isBroadcasting, broadcastType: p.broadcastType,
        hasMic: p.hasMic, micMuted: p.micMuted,
        photoUrl: p.photoUrl || '',
        termsAccepted: !!p.termsAccepted,
        isAdmin: !!p.isAdmin,
        userId: p.userId || null
      }));
      enterRoom(res.roomId, res.roomName, res.isOwner);
    } else {
      // Mensagem mais clara para "Sala não encontrada"
      // (pode acontecer se o servidor reiniciou e perdeu as salas da memória)
      if (res.message && res.message.toLowerCase().includes('não encontrada')) {
        showToast('Sala não encontrada. O criador precisa recriar a sala.', 'error');
        loadRoomsList(); // Atualizar lista para mostrar salas atuais
      } else {
        showToast(res.message, 'error');
      }
      // Se falhou por senha incorreta, mostrar botão de recuperação
      if (res.message && res.message.toLowerCase().includes('senha')) {
        document.getElementById('btn-forgot-password').classList.remove('hidden');
      }
    }
  });
}

function enterRoom(roomId, rName, owner) {
  currentRoomId = roomId; roomName = rName; isOwner = owner;

  document.getElementById('room-name-display').textContent = rName || roomId;
  document.getElementById('room-id-badge').textContent = roomId;

  if (owner || isLocalAdmin()) {
    document.getElementById('btn-delete-room').classList.remove('hidden');
    document.getElementById('btn-delete-room').classList.add('flex');
  }

  document.getElementById('lobby-view').classList.add('hidden');
  document.getElementById('room-view').classList.remove('hidden');

  updateParticipantCount();
  renderParticipantsList();

  for (const [pid] of participants) {
    if (pid === myId) continue;
    connectToPeer(pid);
    socket.emit('request-peer', { targetId: pid });
  }

  // Envia foto do perfil (GIF/imagem) para todos na sala
  setTimeout(() => broadcastMyPhoto(), 300);

  showToast(`Você entrou em ${rName || roomId}`, 'success');
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
    photoUrl: loadPhoto(),
    termsAccepted: loadTermsAccepted()
  }, (res) => {
    if (!res || !res.success) {
      showToast('Não foi possível voltar à sala', 'error');
      leaveRoom(false);
      return;
    }
    isOwner = res.isOwner;
    if (res.isAdmin) { window.__mcIsAdmin = true; window.__mcUserId = res.userId || '01'; updateAdminUI(); }
    participants.clear();
    (res.participants || []).forEach(p => participants.set(p.id, {
      name: p.name, isOwner: p.isOwner,
      isBroadcasting: p.isBroadcasting, broadcastType: p.broadcastType,
      hasMic: p.hasMic, micMuted: p.micMuted,
      photoUrl: p.photoUrl || '',
      termsAccepted: !!p.termsAccepted,
      isAdmin: !!p.isAdmin,
      userId: p.userId || null
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

async function deleteRoom(targetRoomId) {
  const id = targetRoomId || currentRoomId;
  if (!id) return;
  if (!confirm('Deletar a sala? Todos os participantes serão removidos.')) return;
  if (!socket || !socket.connected) {
    showToast('Sem conexão com o servidor', 'error');
    return;
  }
  socket.emit('delete-room', { roomId: id }, (res) => {
    if (res && !res.success) showToast(res.message || 'Erro ao deletar sala', 'error');
    else if (!currentRoomId) showToast('Sala removida', 'success');
  });
}

// ==================== UI ====================

function updateParticipantCount() {
  document.getElementById('participant-count').textContent = participants.size + 1;
}

function renderParticipantsList() {
  const list = document.getElementById('participants-list');
  list.innerHTML = '';
  const iAmAdmin = !!window.__mcIsAdmin || (loadName() || '').trim().toLowerCase() === 'exibidoofc';

  const renderItem = (id, name, owner, broadcasting, broadType, hasMic, micMuted, isMe, photoUrl, termsOk, isAdminUser, userId) => {
    const micIcon = hasMic ? (micMuted ? '🔇' : '🎙️') : '';
    const vidIcon = broadcasting ? (broadType === 'screen' ? '🖥️' : '📹') : '';
    const div = document.createElement('div');
    div.className = 'participant-item';

    const av = document.createElement('div');
    av.className = 'avatar avatar-sm';
    applyAvatarTo(av, name, photoUrl || '');

    const nameWrap = document.createElement('div');
    nameWrap.className = 'p-name-wrap';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'p-name';
    nameSpan.textContent = name + (isMe ? ' ' : '');
    if (isMe) {
      const you = document.createElement('span');
      you.style.cssText = 'font-size:10px;color:var(--accent-text)';
      you.textContent = '(você)';
      nameSpan.appendChild(you);
    }
    nameWrap.appendChild(nameSpan);
    if (isAdminUser || userId === '01') {
      const adm = document.createElement('span');
      adm.className = 'p-admin-tag';
      adm.textContent = 'ADMIN · ID 01';
      nameWrap.appendChild(adm);
    }
    if (termsOk) {
      const badgeRow = document.createElement('div');
      badgeRow.className = 'p-terms-row';
      badgeRow.appendChild(createTermsBadgeEl(true));
      nameWrap.appendChild(badgeRow);
    }

    const badges = document.createElement('div');
    badges.className = 'p-badges';
    if (owner) { const s = document.createElement('span'); s.className = 'p-badge'; s.textContent = '👑'; badges.appendChild(s); }
    if (vidIcon) { const s = document.createElement('span'); s.className = 'p-badge'; s.textContent = vidIcon; badges.appendChild(s); }
    if (micIcon) { const s = document.createElement('span'); s.className = 'p-badge'; s.textContent = micIcon; badges.appendChild(s); }
    // Botão de kick só para o admin, e não em si mesmo
    if (iAmAdmin && !isMe) {
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.className = 'p-kick-btn';
      kickBtn.title = 'Desconectar este usuário';
      kickBtn.textContent = '✕';
      kickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Desconectar ${name} da sala?`)) return;
        if (!socket || !socket.connected) return;
        socket.emit('admin-kick', { targetId: id, roomId: currentRoomId }, (res) => {
          if (res && !res.success) showToast(res.message || 'Falha ao desconectar', 'error');
          else showToast(`${name} foi desconectado`, 'success');
        });
      });
      badges.appendChild(kickBtn);
    }
    div.appendChild(av);
    div.appendChild(nameWrap);
    div.appendChild(badges);
    list.appendChild(div);
  };

  const myBroad = isCameraOn || isScreenSharing;
  const myType  = isScreenSharing ? 'screen' : (isCameraOn ? 'camera' : null);
  const myAdmin = iAmAdmin;
  const myUid = window.__mcUserId || (myAdmin ? '01' : null);
  renderItem(myId, myName, isOwner, myBroad, myType, !!micStream, !isMicOn, true, loadPhoto(), loadTermsAccepted(), myAdmin, myUid);

  for (const [pid, p] of participants) {
    if (pid === myId) continue;
    renderItem(pid, p.name, p.isOwner, p.isBroadcasting, p.broadcastType, p.hasMic, p.micMuted, false, p.photoUrl || '', !!p.termsAccepted, !!p.isAdmin, p.userId || null);
  }
}

function updateToolbarUI() {
  const btnScreen = document.getElementById('btn-share-screen');
  const btnCamera = document.getElementById('btn-camera');
  const btnMic    = document.getElementById('btn-mic');
  const btnAudio  = document.getElementById('btn-audio');

  // Esconder botão de tela em dispositivos sem suporte (mobile)
  if (!supportsScreenShare()) {
    btnScreen.style.display = 'none';
  } else {
    btnScreen.style.display = '';
    btnScreen.className = `toolbar-btn${isScreenSharing ? ' active-screen' : ''}`;
    btnScreen.querySelector('.btn-label').textContent = isScreenSharing ? 'Parar Tela' : 'Tela';
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

  // Qualidade só aparece quando transmitindo TELA (não câmera)
  const qualityWrap = document.getElementById('quality-select-wrap');
  if (qualityWrap) {
    const showQ = !!isScreenSharing;
    qualityWrap.classList.toggle('hidden', !showQ);
    qualityWrap.classList.toggle('broadcasting', showQ);
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
  while (c.firstChild) c.removeChild(c.firstChild);
  if (!roomsArr || !roomsArr.length) {
    const empty = document.createElement('p');
    empty.className = 'rooms-empty';
    empty.textContent = 'Nenhuma sala disponível no momento.';
    c.appendChild(empty);
    return;
  }
  roomsArr.forEach(room => {
    const safeId = sanitizeUserText(String(room.id || ''), 12).toUpperCase();
    const safeName = sanitizeUserText(String(room.name || safeId), 50);
    const safeOwner = sanitizeUserText(String(room.ownerName || ''), 20);
    const count = Number(room.participantCount) || 0;
    const item = document.createElement('div');
    item.className = 'room-list-item';
    const info = document.createElement('div');
    info.className = 'room-info';
    const title = document.createElement('div');
    title.className = 'room-title';
    title.textContent = safeName || safeId;
    const meta = document.createElement('div');
    meta.className = 'room-meta';
    meta.textContent = `${room.hasPassword ? '🔒 ' : ''}${count} participante${count !== 1 ? 's' : ''} · ${safeOwner}`;
    info.appendChild(title);
    info.appendChild(meta);
    const joinBtn = document.createElement('div');
    joinBtn.className = 'room-join-btn';
    joinBtn.textContent = 'Entrar';
    item.appendChild(info);
    item.appendChild(joinBtn);

    // Admin (exibidoofc) pode apagar qualquer sala direto da lista
    const iAmAdmin = !!window.__mcIsAdmin || (loadName() || '').trim().toLowerCase() === 'exibidoofc';
    if (iAmAdmin) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'room-admin-del';
      delBtn.title = 'Apagar sala (admin)';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRoom(safeId);
      });
      item.appendChild(delBtn);
    }

    item.addEventListener('click', () => {
      document.getElementById('join-room-id').value = safeId;
      if (room.hasPassword) { document.getElementById('join-password').focus(); showToast('Esta sala tem senha.', 'info'); }
      else joinRoom(safeId, '');
    });
    c.appendChild(item);
  });
}

function fetchRooms() {
  socket.emit('list-rooms', (res) => {
    const rooms = (res && res.rooms) || [];
    renderRoomsList(rooms);
    const stat = document.getElementById('arena-stat-rooms');
    if (stat) stat.textContent = String(rooms.length);
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
  if (!el) return;
  const safeInit = nameInitial(name);
  const safeColor = nameColor(name);
  const url = (photoUrl || '').trim();
  while (el.firstChild) el.removeChild(el.firstChild);
  if (url && isSafePhotoUrl(url)) {
    el.style.background = 'transparent';
    el.style.padding = '0';
    el.classList.add('has-photo');
    const img = document.createElement('img');
    img.alt = safeInit;
    img.decoding = 'async';
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    // ajuda a carregar GIFs/imagens de CDNs (Giphy/Tenor)
    if (/^https?:\/\//i.test(url)) {
      try { img.crossOrigin = 'anonymous'; } catch (_) {}
    }
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
    img.onerror = () => {
      // se crossOrigin falhar, tenta de novo sem CORS
      if (img.crossOrigin) {
        img.crossOrigin = null;
        img.src = url;
        return;
      }
      while (el.firstChild) el.removeChild(el.firstChild);
      el.classList.remove('has-photo');
      el.textContent = safeInit;
      el.style.background = `linear-gradient(135deg, ${safeColor}, ${safeColor}88)`;
    };
    img.src = url;
    el.appendChild(img);
  } else {
    el.classList.remove('has-photo');
    el.textContent = safeInit;
    el.style.background = `linear-gradient(135deg, ${safeColor}, ${safeColor}88)`;
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
  const nameEl = document.getElementById('profile-name-display');
  const dispAv = document.getElementById('profile-avatar-display');

  if (nameEl) nameEl.textContent = name || '—';
  if (dispAv) applyAvatarTo(dispAv, name || '?', photo);
  updateProfileTermsBadge();

  if (!viewEl || !editEl) return;

  const card = document.getElementById('profile-card');
  // Com apelido: só sidebar; esconde formulário
  if (name) {
    viewEl.classList.add('hidden');
    editEl.classList.add('hidden');
    if (card) card.classList.add('hidden');
  } else {
    viewEl.classList.add('hidden');
    editEl.classList.remove('hidden');
    if (card) card.classList.remove('hidden');
    updateAvatarPreview();
  }
}

function updateTermsUI() {
  const row = document.getElementById('terms-check-row');
  const termsEl = document.getElementById('accept-terms');
  const accepted = loadTermsAccepted();
  if (row) {
    if (accepted) row.classList.add('hidden');
    else row.classList.remove('hidden');
  }
  if (termsEl) {
    termsEl.checked = accepted;
    // Só pode marcar via modal após ler tudo — não pelo clique direto
    termsEl.disabled = true;
  }
  updateProfileTermsBadge();
}

function enterEditMode() {
  const name  = loadName();
  const photo = loadPhoto();
  const usernameEl = document.getElementById('global-username');
  const photoEl    = document.getElementById('profile-photo-url');
  const editEl     = document.getElementById('profile-edit');
  if (usernameEl) usernameEl.value = name;
  if (photoEl)    photoEl.value    = photo;
  updateTermsUI();
  if (editEl) editEl.classList.remove('hidden');
  const viewEl = document.getElementById('profile-view');
  if (viewEl) viewEl.classList.add('hidden');
  const card = document.getElementById('profile-card');
  if (card) {
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  updateAvatarPreview();
  setTimeout(() => usernameEl && usernameEl.focus(), 50);
}

async function saveProfile() {
  const nameEl  = document.getElementById('global-username');
  const photoEl = document.getElementById('profile-photo-url');
  const name    = sanitizeUserText(nameEl ? nameEl.value : '', 20);
  let photo     = photoEl ? photoEl.value.trim() : '';
  if (photo && !isSafePhotoUrl(photo)) photo = '';

  if (!name) {
    showToast('Digite seu apelido', 'error');
    if (nameEl) nameEl.focus();
    return;
  }
  if (!loadTermsAccepted()) {
    showToast('Leia e aceite a Política de Privacidade e os Termos de Uso para criar o perfil', 'error');
    openPrivacyModal();
    return;
  }

  // Garante conexão e verifica se o nome está disponível (único no site)
  await connectSocket();
  if (socket && socket.connected) {
    const check = await new Promise(resolve => {
      socket.emit('check-name', { userName: name }, (res) => resolve(res || {}));
      setTimeout(() => resolve({ available: true }), 2500);
    });
    if (check.available === false) {
      showToast(check.message || 'Este nome de perfil já está em uso. Escolha outro.', 'error');
      if (nameEl) nameEl.focus();
      return;
    }
    // Reserva o nome neste socket (conta persistente no servidor — aparece no painel admin)
    socket.emit('claim-name', { userName: name, photoUrl: photo || loadPhoto() }, (res) => {
      if (res && res.success) {
        window.__mcIsAdmin = !!res.isAdmin;
        window.__mcUserId = res.userId || null;
        updateAdminUI();
      }
    });
  }

  if (nameEl) nameEl.value = name;
  if (photoEl) photoEl.value = photo;
  saveName(name);
  savePhoto(photo);
  // Propaga foto/GIF para quem já está na sala
  broadcastMyPhoto();
  // Só vincula o nome ao aceite já existente — NUNCA altera a data de aceite
  bindTermsMetaName(name);

  // Conta especial exibidoofc → ID fixo 01
  if (name.trim().toLowerCase() === 'exibidoofc') {
    try { localStorage.setItem('mc_user_id', '01'); } catch (_) {}
    window.__mcIsAdmin = true;
    window.__mcUserId = '01';
  } else {
    try {
      const prev = localStorage.getItem('mc_user_id');
      if (prev === '01') localStorage.removeItem('mc_user_id');
    } catch (_) {}
    if (window.__mcUserId === '01') {
      window.__mcIsAdmin = false;
      window.__mcUserId = null;
    }
  }

  updateTermsUI();
  updateAdminUI();
  showProfileView();
  showToast(
    name.trim().toLowerCase() === 'exibidoofc'
      ? 'Perfil admin (exibidoofc · ID 01) salvo!'
      : 'Perfil salvo!',
    'success'
  );
}

function setPrivacyAcceptEnabled(enabled) {
  // Se já aceitou, nunca reexibe o botão de confirmar
  if (loadTermsAccepted()) {
    applyPrivacyAlreadyAcceptedUI();
    return;
  }
  const btn = document.getElementById('btn-privacy-accept');
  const hint = document.getElementById('privacy-scroll-hint');
  const done = document.getElementById('privacy-already-accepted');
  if (done) done.classList.add('hidden');
  if (btn) {
    btn.classList.remove('hidden');
    btn.disabled = !enabled;
    btn.classList.toggle('is-disabled', !enabled);
  }
  if (hint) {
    if (enabled) hint.classList.add('hidden');
    else hint.classList.remove('hidden');
  }
}

function applyPrivacyAlreadyAcceptedUI() {
  const btn = document.getElementById('btn-privacy-accept');
  const hint = document.getElementById('privacy-scroll-hint');
  const done = document.getElementById('privacy-already-accepted');
  if (btn) {
    btn.classList.add('hidden');
    btn.disabled = true;
    btn.classList.add('is-disabled');
  }
  if (hint) hint.classList.add('hidden');
  if (done) {
    const meta = loadTermsMeta();
    const when = formatTermsDate(meta && meta.at);
    const who = (meta && meta.name) || loadName() || '';
    let msg = 'Você já aceitou a Política de Privacidade e os Termos de Uso.';
    if (who && when) msg = `Perfil “${who}” já aceitou os termos em ${when}.`;
    else if (when) msg = `Você já aceitou os termos em ${when}.`;
    else if (who) msg = `Perfil “${who}” já aceitou os termos.`;
    done.textContent = msg;
    done.classList.remove('hidden');
  }
}

function onPrivacyScroll() {
  if (loadTermsAccepted()) {
    applyPrivacyAlreadyAcceptedUI();
    return;
  }
  const content = document.getElementById('privacy-content');
  if (!content) return;
  const atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 12;
  setPrivacyAcceptEnabled(atBottom);
}

function openPrivacyModal() {
  const modal = document.getElementById('modal-privacy');
  if (!modal) return;
  modal.classList.remove('hidden');
  const content = document.getElementById('privacy-content');
  if (content) content.scrollTop = 0;

  // Já aceitou: só leitura — sem botão de confirmar
  if (loadTermsAccepted()) {
    applyPrivacyAlreadyAcceptedUI();
    return;
  }

  if (content) {
    requestAnimationFrame(() => {
      const needsScroll = content.scrollHeight > content.clientHeight + 8;
      setPrivacyAcceptEnabled(!needsScroll);
      if (needsScroll) setPrivacyAcceptEnabled(false);
    });
  } else {
    setPrivacyAcceptEnabled(false);
  }
}

function closePrivacyModal() {
  const modal = document.getElementById('modal-privacy');
  if (modal) modal.classList.add('hidden');
}

function acceptPrivacyFromModal() {
  if (loadTermsAccepted()) {
    applyPrivacyAlreadyAcceptedUI();
    closePrivacyModal();
    return;
  }
  const content = document.getElementById('privacy-content');
  if (content) {
    const atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 12;
    const needsScroll = content.scrollHeight > content.clientHeight + 8;
    if (needsScroll && !atBottom) {
      showToast('Leia com atenção nossos termos de uso e política de privacidade até o fim', 'error');
      return;
    }
  }
  const nameEl = document.getElementById('global-username');
  const profileName = sanitizeUserText((nameEl && nameEl.value) || loadName() || '', 20);
  saveTermsAccepted(profileName);
  updateTermsUI();
  applyPrivacyAlreadyAcceptedUI();
  closePrivacyModal();
  showToast('Termos aceitos e salvos no seu perfil', 'success');
}

function applyPhotoToProfileField(dataUrl, opts) {
  opts = opts || {};
  if (!dataUrl || !isSafePhotoUrl(dataUrl)) {
    if (dataUrl && dataUrl.startsWith('data:') && dataUrl.length > MAX_PHOTO_DATA_LEN) {
      showToast('Arquivo ainda grande demais. Tente outro GIF ou cole um link https no campo da foto.', 'error');
    } else {
      showToast('Imagem inválida', 'error');
    }
    return false;
  }
  const photoEl = document.getElementById('profile-photo-url');
  if (photoEl) photoEl.value = dataUrl;
  savePhoto(dataUrl);
  updateAvatarPreview();
  broadcastMyPhoto();
  if (!opts.silent) showToast('Foto do perfil atualizada — todos na sala verão', 'success');
  return true;
}

function handlePhotoUpload(file) {
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) {
    showToast('Selecione uma imagem ou GIF', 'error');
    return;
  }
  if (file.size > MAX_PHOTO_FILE_BYTES) {
    showToast('Arquivo acima de 8MB. Use um arquivo menor ou cole um link https no campo da foto.', 'error');
    return;
  }
  const isGif = /image\/gif/i.test(file.type) || /\.gif$/i.test(file.name);

  if (isGif) {
    // GIF: mantém animação (não passa por canvas)
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      if (typeof dataUrl !== 'string') {
        showToast('Não foi possível ler o GIF', 'error');
        return;
      }
      // Aceita até o limite alto; só recusa se realmente estourar o buffer
      if (dataUrl.length > MAX_PHOTO_DATA_LEN) {
        showToast('Este GIF passou do limite interno. Cole o link do GIF (Tenor/Giphy) no campo da foto.', 'error');
        return;
      }
      applyPhotoToProfileField(dataUrl);
    };
    reader.onerror = () => showToast('Não foi possível ler o GIF', 'error');
    reader.readAsDataURL(file);
    return;
  }

  // Imagem estática: redimensiona e comprime (até 384px)
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const max = 384;
      let w = img.width, h = img.height;
      if (w > max || h > max) {
        if (w > h) { h = Math.round(h * max / w); w = max; }
        else { w = Math.round(w * max / h); h = max; }
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      let dataUrl = c.toDataURL('image/webp', 0.9);
      if (!dataUrl || !dataUrl.startsWith('data:image/webp')) {
        dataUrl = c.toDataURL('image/jpeg', 0.92);
      }
      applyPhotoToProfileField(dataUrl);
    };
    img.onerror = () => showToast('Não foi possível ler a imagem', 'error');
    img.src = e.target.result;
  };
  reader.onerror = () => showToast('Não foi possível ler o arquivo', 'error');
  reader.readAsDataURL(file);
}

// ==================== EVENT LISTENERS ====================

document.getElementById('global-username').addEventListener('input', updateAvatarPreview);
document.getElementById('generate-room-id').addEventListener('click', () => {
  document.getElementById('create-room-id').value = generateRoomId();
});

// Perfil
document.getElementById('btn-edit-profile').addEventListener('click', enterEditMode);
document.getElementById('btn-save-profile').addEventListener('click', saveProfile);

// Privacidade / Termos
const btnPrivacy = document.getElementById('btn-privacy');
if (btnPrivacy) btnPrivacy.addEventListener('click', openPrivacyModal);
const linkOpenPrivacy = document.getElementById('link-open-privacy');
if (linkOpenPrivacy) {
  linkOpenPrivacy.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPrivacyModal();
  });
}
const termsCheckRow = document.getElementById('terms-check-row');
if (termsCheckRow) {
  termsCheckRow.addEventListener('click', (e) => {
    // Clique na linha abre o modal para ler (não marca a caixa direto)
    if (e.target && e.target.id === 'link-open-privacy') return;
    e.preventDefault();
    openPrivacyModal();
  });
}
const btnPrivacyClose = document.getElementById('btn-privacy-close');
if (btnPrivacyClose) btnPrivacyClose.addEventListener('click', closePrivacyModal);
const btnPrivacyAccept = document.getElementById('btn-privacy-accept');
if (btnPrivacyAccept) btnPrivacyAccept.addEventListener('click', acceptPrivacyFromModal);
const privacyContent = document.getElementById('privacy-content');
if (privacyContent) privacyContent.addEventListener('scroll', onPrivacyScroll, { passive: true });

// Badge de termos: clique abre painel interno (não tooltip do navegador)
(function setupTermsBadgePopover() {
  const profileBadge = document.getElementById('profile-terms-badge');
  if (profileBadge) {
    profileBadge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTermsBadgePopover(profileBadge);
    });
  }
  const closeBtn = document.getElementById('mc-terms-popover-close');
  if (closeBtn) closeBtn.addEventListener('click', closeTermsBadgePopover);
  const pop = document.getElementById('mc-terms-popover');
  if (pop) {
    pop.addEventListener('click', (e) => {
      if (e.target === pop) closeTermsBadgePopover();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTermsBadgePopover();
  });
  document.addEventListener('click', (e) => {
    const pop = document.getElementById('mc-terms-popover');
    if (!pop || pop.classList.contains('hidden')) return;
    if (e.target.closest('.mc-terms-badge') || e.target.closest('.mc-terms-popover-card')) return;
    closeTermsBadgePopover();
  });
})();

const modalPrivacy = document.getElementById('modal-privacy');
if (modalPrivacy) {
  modalPrivacy.addEventListener('click', (e) => {
    if (e.target === modalPrivacy) closePrivacyModal();
  });
}
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

// visibilitychange: NÃO sair ao minimizar/background — apenas reconectar se preciso
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentRoomId && socket && !socket.connected) {
    // Voltou ao app e perdeu conexão — tentar reconectar
    connectSocket();
  }
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
    addChatMessage(msg);
    // Som de mensagem (não toca para a própria msg se quiser — toca para todas)
    if (msg.id !== myId) playSound('message');
    if (!chatOpen) {
      chatUnread++;
      const badge = document.getElementById('chat-badge');
      badge.textContent = chatUnread > 99 ? '99+' : chatUnread;
      badge.classList.remove('hidden');
      showToast(`💬 ${msg.name}: ${msg.text.slice(0, 40)}${msg.text.length > 40 ? '...' : ''}`, 'info');
    }
  });
}

function addChatMessage(msg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const isMe = msg.id === myId;
  const col  = nameColor(msg.name);
  const time = new Date(msg.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const init = nameInitial(msg.name);
  // Preferir foto da msg; se for eu, fallback para loadPhoto()
  let photo = msg.photoUrl || '';
  if (isMe && !photo) photo = loadPhoto() || '';
  if (!isMe && !photo) {
    const p = participants.get(msg.id);
    if (p && p.photoUrl) photo = p.photoUrl;
  }

  const div = document.createElement('div');
  div.className = `chat-msg${isMe ? ' own' : ''}`;

  const body = document.createElement('div');
  body.className = 'chat-msg-body';
  body.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-msg-name"></span>
        <span class="chat-msg-time">${time}</span>
      </div>
      <div class="chat-msg-text"></div>`;
  body.querySelector('.chat-msg-name').textContent = msg.name || '';
  body.querySelector('.chat-msg-text').textContent = msg.text || '';

  const av = document.createElement('div');
  av.className = 'chat-msg-avatar';
  applyAvatarTo(av, msg.name || '?', photo);

  div.appendChild(av);
  div.appendChild(body);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text  = sanitizeUserText(input.value, 500);
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

// ==================== FLIP CÂMERA (mobile) ====================

async function flipCamera() {
  if (!isCameraOn || !cameraStream) return;
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

  try {
    // Parar stream atual
    cameraStream.getTracks().forEach(t => t.stop());

    const constraints = {
      video: {
        facingMode: currentFacingMode,
        width:  { ideal: streamQuality === 'high' ? 1280 : streamQuality === 'medium' ? 720 : 480 },
        height: { ideal: streamQuality === 'high' ? 720  : streamQuality === 'medium' ? 480 : 360 },
        frameRate: { ideal: streamQuality === 'low' ? 15 : 30 }
      },
      audio: false
    };

    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    const newVideoTrack = cameraStream.getVideoTracks()[0];

    // Substituir nos peers
    replaceVideoInAllPeers(newVideoTrack);
    updateSelfPreview();
    showToast(`Câmera ${currentFacingMode === 'user' ? 'frontal' : 'traseira'} ativada`, 'success');
  } catch (err) {
    console.error('flipCamera:', err);
    showToast('Não foi possível virar a câmera', 'error');
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user'; // reverter
  }
}

document.getElementById('btn-flip-camera').addEventListener('click', flipCamera);

// ==================== SUPRESSÃO DE RUÍDO (RNNoise AI) ====================

// Estado do pipeline RNNoise
let noiseCtx       = null;   // AudioContext
let noiseWorklet   = null;   // AudioWorkletNode (RNNoise)
let noiseSource    = null;   // MediaStreamAudioSourceNode
let noiseDest      = null;   // MediaStreamAudioDestinationNode
let noiseStream    = null;   // stream processado pelo RNNoise
let rnnoiseModule  = null;   // WASM module carregado
let rnnoiseReady   = false;  // módulo WASM pronto

// URL do RNNoise WASM (Jitsi CDN — open source, Apache 2.0)
const RNNOISE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.0.1/dist/rnnoise.wasm';
const RNNOISE_JS_URL   = 'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.0.1/dist/rnnoise.js';

async function loadRNNoise() {
  if (rnnoiseReady) return true;
  try {
    // Carregar o módulo JS do RNNoise dinamicamente
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = RNNOISE_JS_URL;
      script.onload  = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

    // Inicializar o módulo WASM
    rnnoiseModule = await window.createRNNoise({ locateFile: () => RNNOISE_WASM_URL });
    rnnoiseReady  = true;
    return true;
  } catch (err) {
    console.warn('RNNoise WASM não disponível, usando supressão nativa do browser:', err);
    return false;
  }
}

async function applyRNNoise(rawStream) {
  if (!rnnoiseReady || !rnnoiseModule) return rawStream;

  try {
    // Criar AudioContext com a mesma taxa de amostragem do stream
    noiseCtx  = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

    // Registrar o worklet processor
    await noiseCtx.audioWorklet.addModule('/noise-processor.js');

    // Criar nós
    noiseSource  = noiseCtx.createMediaStreamSource(rawStream);
    noiseWorklet = new AudioWorkletNode(noiseCtx, 'rnnoise-processor');
    noiseDest    = noiseCtx.createMediaStreamDestination();

    // Enviar o módulo WASM para o worklet via port
    noiseWorklet.port.postMessage({ type: 'init', module: rnnoiseModule });

    // Conectar pipeline: source → rnnoise → destination
    noiseSource.connect(noiseWorklet);
    noiseWorklet.connect(noiseDest);

    noiseStream = noiseDest.stream;
    return noiseStream;
  } catch (err) {
    console.warn('AudioWorklet RNNoise falhou, usando stream original:', err);
    destroyRNNoise();
    return rawStream;
  }
}

function destroyRNNoise() {
  if (noiseWorklet) {
    try { noiseWorklet.port.postMessage({ type: 'destroy' }); } catch (_) {}
    noiseWorklet.disconnect();
    noiseWorklet = null;
  }
  if (noiseSource) { noiseSource.disconnect(); noiseSource = null; }
  if (noiseCtx)    { noiseCtx.close().catch(() => {}); noiseCtx = null; }
  noiseDest  = null;
  noiseStream = null;
}

async function toggleNoiseSuppression() {
  noiseSuppressionOn = !noiseSuppressionOn;

  // Se mic ativo, reaplicar pipeline
  if (micStream) {
    const oldTrack = micStream.getAudioTracks()[0];

    if (noiseSuppressionOn && rnnoiseReady) {
      // Ativar RNNoise
      const processedStream = await applyRNNoise(micStream);
      const processedTrack  = processedStream.getAudioTracks()[0];
      if (processedTrack && processedTrack !== oldTrack) {
        for (const [, entry] of peers) {
          if (entry.pc) replaceAudioTrackInPeer(entry.pc, processedTrack);
        }
      }
      showToast('🎙️ RNNoise ativado — ruído removido por IA', 'success');
    } else {
      // Desativar — voltar ao mic direto
      destroyRNNoise();
      if (oldTrack) {
        for (const [, entry] of peers) {
          if (entry.pc) replaceAudioTrackInPeer(entry.pc, oldTrack);
        }
      }
      showToast('Supressão de ruído desativada', 'info');
    }
  }

  const btn = document.getElementById('btn-noise');
  if (btn) {
    if (noiseSuppressionOn) {
      btn.className = 'toolbar-btn active-noise';
      const lab = btn.querySelector('.btn-label');
      if (lab) lab.textContent = 'RNNoise';
    } else {
      btn.className = 'toolbar-btn off-noise';
      const lab = btn.querySelector('.btn-label');
      if (lab) lab.textContent = 'Ruído Off';
    }
  }
}


// ==================== QUALIDADE DE TRANSMISSÃO ====================

const QUALITY_PRESETS = {
  high:   { width: 1920, height: 1080, frameRate: 30, bitrate: 2800000, scale: 1 },
  medium: { width: 1280, height: 720,  frameRate: 24, bitrate: 1200000, scale: 1.5 },
  low:    { width: 854,  height: 480,  frameRate: 15, bitrate:  450000, scale: 2.5 }
};

// ==================== SELECT DE QUALIDADE (inline na toolbar) ====================

document.getElementById('quality-select').addEventListener('change', async (e) => {
  streamQuality = e.target.value;
  try { localStorage.setItem('mc_quality', streamQuality); } catch (_) {}

  const q = QUALITY_PRESETS[streamQuality];
  if (!q) return;

  // Qualidade só afeta transmissão de TELA (bitrate + scale no WebRTC)
  if (isScreenSharing) {
    let applied = 0;
    for (const [, entry] of peers) {
      if (!entry.pc) continue;
      const vs = entry.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vs) {
        await optimizeVideoSenderWithPreset(vs, q);
        applied++;
      }
    }
    // Tenta ajustar frameRate da track de tela (nem sempre o browser aceita)
    try {
      const vt = screenStream && screenStream.getVideoTracks()[0];
      if (vt) {
        await vt.applyConstraints({ frameRate: { ideal: q.frameRate, max: q.frameRate } });
      }
    } catch (_) {}
    showToast(`Qualidade da tela: ${e.target.options[e.target.selectedIndex].text}`, 'success');
  } else {
    showToast('Qualidade só se aplica ao compartilhar tela', 'info');
  }
});

async function optimizeVideoSenderWithPreset(sender, q) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = q.bitrate;
    params.encodings[0].maxFramerate = q.frameRate;
    params.encodings[0].scaleResolutionDownBy = (q.scale && q.scale > 1) ? q.scale : 1;
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

// ==================== PWA INSTALL (celular) ====================

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('btn-install-mobile');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Instalar no celular';
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('btn-install-mobile');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Já instalado ✓';
  }
  showToast('MaxCord instalado no celular!', 'success');
});

function setupMobileInstallButton() {
  const btn = document.getElementById('btn-install-mobile');
  const hint = document.getElementById('install-mobile-hint');
  if (!btn) return;

  // Já está em modo standalone?
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (isStandalone) {
    btn.disabled = true;
    btn.textContent = 'Já instalado ✓';
    if (hint) hint.textContent = 'Você já está usando o app instalado.';
    return;
  }

  btn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          showToast('Instalando…', 'success');
        }
      } catch (_) {}
      deferredInstallPrompt = null;
      return;
    }
    // Fallback: instruções manuais
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      showToast('No iPhone: toque em Compartilhar → “Adicionar à Tela de Início”.', 'info');
      if (hint) hint.textContent = 'iPhone (Safari): Compartilhar → Adicionar à Tela de Início';
    } else {
      showToast('No Android: menu ⋮ do Chrome → “Instalar aplicativo” ou “Adicionar à tela inicial”.', 'info');
      if (hint) hint.textContent = 'Android Chrome: menu ⋮ → Instalar app / Adicionar à tela inicial';
    }
  });
}

// ==================== ADMIN / AVISOS FLUTUANTES ====================

function isLocalAdmin() {
  return !!window.__mcIsAdmin || (loadName() || '').trim().toLowerCase() === 'exibidoofc';
}

function updateAdminUI() {
  const btnAnn = document.getElementById('btn-admin-announce');
  const btnAcc = document.getElementById('btn-admin-accounts');
  const show = isLocalAdmin();
  if (show) {
    window.__mcIsAdmin = true;
    window.__mcUserId = '01';
    try { localStorage.setItem('mc_user_id', '01'); } catch (_) {}
  }
  if (btnAnn) btnAnn.classList.toggle('hidden', !show);
  if (btnAcc) btnAcc.classList.toggle('hidden', !show);
}

function showSiteAnnouncement(ann, opts) {
  if (!ann || !ann.id) return;
  const root = document.getElementById('site-announcements');
  if (!root) return;
  // Evita duplicar
  if (document.getElementById('ann-' + ann.id)) return;

  // Respeita fechamentos locais desta sessão
  try {
    const closed = JSON.parse(sessionStorage.getItem('mc_closed_anns') || '[]');
    if (closed.includes(ann.id)) return;
  } catch (_) {}

  const el = document.createElement('div');
  el.className = 'site-announcement';
  el.id = 'ann-' + ann.id;
  el.setAttribute('role', 'status');

  const body = document.createElement('div');
  body.className = 'site-announcement-body';
  const text = document.createElement('div');
  text.className = 'site-announcement-text';
  text.textContent = ann.text || '';
  // Permite texto longo sem cortar visualmente demais
  text.style.whiteSpace = 'pre-wrap';
  text.style.wordBreak = 'break-word';
  const meta = document.createElement('div');
  meta.className = 'site-announcement-meta';
  const when = ann.at ? new Date(ann.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  meta.textContent = (ann.from ? 'Por ' + ann.from : 'Administração') + (when ? ' · ' + when : '');
  body.appendChild(text);
  body.appendChild(meta);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'site-announcement-close';
  close.setAttribute('aria-label', 'Fechar aviso');
  close.textContent = '✕';
  close.addEventListener('click', () => {
    removeSiteAnnouncement(ann.id);
    try {
      const closed = JSON.parse(sessionStorage.getItem('mc_closed_anns') || '[]');
      if (!closed.includes(ann.id)) {
        closed.push(ann.id);
        sessionStorage.setItem('mc_closed_anns', JSON.stringify(closed.slice(-30)));
      }
    } catch (_) {}
  });

  el.appendChild(body);
  el.appendChild(close);
  root.appendChild(el);
  // Som só em aviso ao vivo (não ao carregar avisos antigos)
  if (!opts || opts.silent !== true) {
    playSound('announce');
  }
}

function removeSiteAnnouncement(id) {
  const el = document.getElementById('ann-' + id);
  if (el) el.remove();
}

function clearAllSiteAnnouncements() {
  const root = document.getElementById('site-announcements');
  if (root) root.innerHTML = '';
}

async function openAdminAnnounceModal() {
  if (!isLocalAdmin()) {
    showToast('Apenas a conta admin pode criar avisos', 'error');
    return;
  }
  await ensureAdminSession();
  const modal = document.getElementById('modal-admin-announce');
  const ta = document.getElementById('admin-announce-text');
  if (modal) modal.classList.remove('hidden');
  if (ta) { ta.value = ''; ta.focus(); }
}

function closeAdminAnnounceModal() {
  const modal = document.getElementById('modal-admin-announce');
  if (modal) modal.classList.add('hidden');
}

async function sendAdminAnnouncement() {
  if (!isLocalAdmin()) return;
  const ta = document.getElementById('admin-announce-text');
  const text = (ta && ta.value || '').trim();
  if (!text) {
    showToast('Escreva o texto do aviso', 'error');
    return;
  }
  await ensureAdminSession();
  if (!socket || !socket.connected) {
    showToast('Sem conexão com o servidor', 'error');
    return;
  }
  socket.emit('admin-announce', {
    text,
    userName: (loadName() || '').trim()
  }, (res) => {
    if (res && res.success) {
      showToast('Aviso publicado!', 'success');
      closeAdminAnnounceModal();
      // Garante que o admin também veja o aviso na hora
      if (res.announcement) showSiteAnnouncement(res.announcement);
    } else {
      showToast((res && res.message) || 'Falha ao publicar aviso', 'error');
    }
  });
}

async function ensureAdminSession() {
  const name = (loadName() || '').trim();
  if (name.toLowerCase() !== 'exibidoofc') return false;
  window.__mcIsAdmin = true;
  window.__mcUserId = '01';
  if (!(await connectSocket())) return false;
  if (!socket || !socket.connected) return false;
  await new Promise(resolve => {
    socket.emit('claim-name', { userName: name, photoUrl: loadPhoto() }, (res) => {
      if (res && res.success) {
        window.__mcIsAdmin = !!res.isAdmin || true;
        window.__mcUserId = res.userId || '01';
      }
      resolve(res || {});
    });
    setTimeout(resolve, 2000);
  });
  return true;
}

async function openAdminAccountsModal() {
  if (!isLocalAdmin()) {
    showToast('Apenas a conta admin pode gerenciar contas', 'error');
    return;
  }
  const modal = document.getElementById('modal-admin-accounts');
  if (modal) modal.classList.remove('hidden');
  await ensureAdminSession();
  refreshAdminAccountsList();
}

function closeAdminAccountsModal() {
  const modal = document.getElementById('modal-admin-accounts');
  if (modal) modal.classList.add('hidden');
}

function getAdminAccountsSearch() {
  const el = document.getElementById('admin-accounts-search');
  return el ? (el.value || '').trim() : '';
}

async function refreshAdminAccountsList() {
  if (!isLocalAdmin()) return;
  if (!(await connectSocket())) {
    showToast('Sem conexão com o servidor', 'error');
    return;
  }
  if (!socket || !socket.connected) {
    showToast('Sem conexão com o servidor', 'error');
    return;
  }
  const search = getAdminAccountsSearch();
  const userName = (loadName() || '').trim();
  socket.emit('admin-list-accounts', {
    search,
    userName,
    photoUrl: loadPhoto()
  }, (res) => {
    if (!res || !res.success) {
      showToast((res && res.message) || 'Falha ao listar contas', 'error');
      return;
    }
    renderAdminAccountsList(res.accounts || []);
  });
}

function renderAdminAccountsList(list) {
  const root = document.getElementById('admin-accounts-list');
  const countEl = document.getElementById('admin-accounts-count');
  if (!root) return;
  root.innerHTML = '';
  const onlineN = (list || []).filter(a => a.online).length;
  const totalN = (list || []).length;
  if (countEl) {
    const q = getAdminAccountsSearch();
    countEl.textContent = q
      ? (totalN + ' resultado' + (totalN !== 1 ? 's' : '') + ' · ' + onlineN + ' online')
      : (totalN + ' conta' + (totalN !== 1 ? 's' : '') + ' · ' + onlineN + ' online');
  }

  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'admin-accounts-empty';
    empty.textContent = getAdminAccountsSearch()
      ? 'Nenhuma conta encontrada para essa pesquisa.'
      : 'Nenhuma conta criada ainda.';
    root.appendChild(empty);
    return;
  }

  list.forEach(acc => {
    const item = document.createElement('div');
    item.className = 'admin-account-item'
      + (acc.isAdmin ? ' is-admin' : '')
      + (acc.online ? '' : ' is-offline');

    const av = document.createElement('div');
    av.className = 'admin-account-av';
    if (acc.photoUrl && isSafePhotoUrl(acc.photoUrl)) {
      const img = document.createElement('img');
      img.src = acc.photoUrl;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.textContent = (acc.name || '?').charAt(0).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'admin-account-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'admin-account-name';
    nameEl.textContent = acc.name || '(sem nome)';
    if (acc.isAdmin) nameEl.textContent += ' · ADMIN';
    const status = document.createElement('span');
    status.className = 'admin-status ' + (acc.online ? 'admin-status-online' : 'admin-status-offline');
    status.textContent = acc.online ? 'ONLINE' : 'OFFLINE';
    nameEl.appendChild(status);

    const meta = document.createElement('div');
    meta.className = 'admin-account-meta';
    const parts = [];
    if (acc.userId || acc.accountId) parts.push('ID ' + (acc.userId || acc.accountId));
    if (acc.online) {
      if (acc.roomId) parts.push('Sala ' + acc.roomId);
      else parts.push('No lobby');
    } else {
      parts.push('Offline');
    }
    const when = acc.lastSeen || acc.createdAt || acc.claimedAt;
    if (when) {
      try {
        parts.push((acc.online ? 'visto ' : 'último acesso ') + new Date(when).toLocaleString('pt-BR', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        }));
      } catch (_) {}
    }
    meta.textContent = parts.join(' · ');
    info.appendChild(nameEl);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'admin-account-actions';

    const myAccId = window.__mcUserId || null;
    const isMe = (acc.socketId && (acc.socketId === myId || (socket && acc.socketId === socket.id)))
      || (myAccId && (acc.accountId === myAccId || acc.userId === myAccId));
    const isTargetAdmin = !!acc.isAdmin || acc.userId === '01' || acc.accountId === '01';

    if (!isTargetAdmin) {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'admin-btn-rename';
      renameBtn.textContent = 'Renomear';
      renameBtn.addEventListener('click', () => adminRenameAccount(acc));
      actions.appendChild(renameBtn);
    }

    if (!isMe && !isTargetAdmin) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'admin-btn-delete';
      delBtn.textContent = 'Apagar';
      delBtn.addEventListener('click', () => adminDeleteAccount(acc));
      actions.appendChild(delBtn);
    }

    item.appendChild(av);
    item.appendChild(info);
    item.appendChild(actions);
    root.appendChild(item);
  });
}

function adminRenameAccount(acc) {
  if (!acc || !(acc.accountId || acc.userId || acc.socketId)) return;
  const novo = prompt('Novo nome para "' + (acc.name || '') + '":', acc.name || '');
  if (novo === null) return;
  const name = sanitizeUserText(novo, 20);
  if (!name) {
    showToast('Nome inválido', 'error');
    return;
  }
  if (!socket || !socket.connected) {
    showToast('Sem conexão', 'error');
    return;
  }
  socket.emit('admin-rename-account', {
    accountId: acc.accountId || acc.userId || null,
    targetId: acc.socketId || null,
    newName: name,
    search: getAdminAccountsSearch(),
    userName: (loadName() || '').trim()
  }, (res) => {
    if (res && res.success) {
      showToast('Nome atualizado', 'success');
      renderAdminAccountsList(res.accounts || []);
    } else {
      showToast((res && res.message) || 'Falha ao renomear', 'error');
    }
  });
}

async function adminResetAllAccounts() {
  if (!isLocalAdmin()) {
    showToast('Apenas a conta admin pode zerar as contas', 'error');
    return;
  }
  const ok = window.confirm(
    'Zerar TODAS as contas do site?\n\n' +
    '• Todas as contas (online e offline) serão apagadas\n' +
    '• Usuários conectados serão desconectados\n' +
    '• Avisos flutuantes também serão limpos\n' +
    '• Sua conta admin (exibidoofc) permanece\n\n' +
    'Novas contas criadas depois disso aparecerão na lista.'
  );
  if (!ok) return;
  await ensureAdminSession();
  if (!socket || !socket.connected) {
    showToast('Sem conexão com o servidor', 'error');
    return;
  }
  socket.emit('admin-reset-accounts', {
    userName: (loadName() || '').trim(),
    photoUrl: loadPhoto(),
    clearAnnouncements: true
  }, (res) => {
    if (res && res.success) {
      showToast('Todas as contas foram resetadas', 'success');
      clearAllSiteAnnouncements();
      renderAdminAccountsList(res.accounts || []);
    } else {
      showToast((res && res.message) || 'Falha ao zerar contas', 'error');
    }
  });
}

function adminDeleteAccount(acc) {
  if (!acc || !(acc.accountId || acc.userId || acc.socketId)) return;
  const msg = acc.online
    ? 'Apagar a conta de "' + (acc.name || '') + '"?\nA pessoa será desconectada e o nome liberado.'
    : 'Apagar a conta offline de "' + (acc.name || '') + '"?\nO nome será liberado permanentemente.';
  if (!confirm(msg)) return;
  if (!socket || !socket.connected) {
    showToast('Sem conexão', 'error');
    return;
  }
  socket.emit('admin-delete-account', {
    accountId: acc.accountId || acc.userId || null,
    targetId: acc.socketId || null,
    search: getAdminAccountsSearch(),
    userName: (loadName() || '').trim()
  }, (res) => {
    if (res && res.success) {
      showToast('Conta removida', 'success');
      renderAdminAccountsList(res.accounts || []);
    } else {
      showToast((res && res.message) || 'Falha ao apagar conta', 'error');
    }
  });
}

function setupAdminUI() {
  const btn = document.getElementById('btn-admin-announce');
  if (btn) btn.addEventListener('click', openAdminAnnounceModal);
  const closeBtn = document.getElementById('btn-admin-announce-close');
  if (closeBtn) closeBtn.addEventListener('click', closeAdminAnnounceModal);
  const sendBtn = document.getElementById('btn-admin-announce-send');
  if (sendBtn) sendBtn.addEventListener('click', sendAdminAnnouncement);
  const modal = document.getElementById('modal-admin-announce');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAdminAnnounceModal();
    });
  }

  const btnAcc = document.getElementById('btn-admin-accounts');
  if (btnAcc) btnAcc.addEventListener('click', openAdminAccountsModal);
  const closeAcc = document.getElementById('btn-admin-accounts-close');
  if (closeAcc) closeAcc.addEventListener('click', closeAdminAccountsModal);
  const refreshAcc = document.getElementById('btn-admin-accounts-refresh');
  if (refreshAcc) refreshAcc.addEventListener('click', refreshAdminAccountsList);
  const resetAcc = document.getElementById('btn-admin-accounts-reset');
  if (resetAcc) resetAcc.addEventListener('click', adminResetAllAccounts);
  const searchAcc = document.getElementById('admin-accounts-search');
  if (searchAcc) {
    let searchTimer = null;
    searchAcc.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => refreshAdminAccountsList(), 250);
    });
    searchAcc.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        refreshAdminAccountsList();
      }
    });
  }
  const modalAcc = document.getElementById('modal-admin-accounts');
  if (modalAcc) {
    modalAcc.addEventListener('click', (e) => {
      if (e.target === modalAcc) closeAdminAccountsModal();
    });
  }

  updateAdminUI();
}

// ==================== INIT ====================

(function init() {
  // Aplicar tema salvo ANTES de tudo (evita flash de tema errado)
  applyTheme(loadTheme());

  // Zera perfis antigos do navegador: site recomeçou contagem de contas
  const wiped = ensureFreshAccountsEpoch();
  if (wiped) {
    console.info('[MaxCord] Contas resetadas — crie o perfil novamente.');
  }

  // Restaura GIF/foto grande do IndexedDB (não cabe no localStorage)
  hydratePhotoFromIdb().then((photo) => {
    if (!photo) return;
    const photoEl = document.getElementById('profile-photo-url');
    if (photoEl && !photoEl.value) photoEl.value = photo;
    try { showProfileView(); } catch (_) {}
    try { updateAvatarPreview(); } catch (_) {}
  }).catch(() => {});

  // Restaurar qualidade salva
  try {
    const savedQ = localStorage.getItem('mc_quality');
    if (savedQ && ['high','medium','low'].includes(savedQ)) {
      streamQuality = savedQ;
      const sel = document.getElementById('quality-select');
      if (sel) sel.value = savedQ;
    }
  } catch (_) {}

  // Restaura flag admin se o perfil local for o especial
  try {
    const n = loadName();
    if ((n || '').trim().toLowerCase() === 'exibidoofc' || localStorage.getItem('mc_user_id') === '01') {
      window.__mcIsAdmin = true;
      window.__mcUserId = '01';
    }
  } catch (_) {}

  const saved = loadName();
  const nameEl = document.getElementById('global-username');
  if (nameEl) nameEl.value = saved || '';
  const photoEl = document.getElementById('profile-photo-url');
  if (photoEl && !loadPhoto()) photoEl.value = '';
  updateTermsUI();
  showProfileView();
  setupAdminUI();
  function claimAndLoadAnnouncements() {
    if (!socket || !socket.connected) return;
    const n = loadName();
    if (n) {
      socket.emit('claim-name', { userName: n, photoUrl: loadPhoto() }, (res) => {
        if (res && res.success) {
          window.__mcIsAdmin = !!res.isAdmin;
          window.__mcUserId = res.userId || null;
          updateAdminUI();
        }
      });
    }
    socket.emit('get-announcements', (res) => {
      const list = (res && res.announcements) || [];
      list.forEach(a => showSiteAnnouncement(a, { silent: true }));
    });
  }

  connectSocket().then(() => {
    fetchRooms();
    claimAndLoadAnnouncements();
    // Em reconexão (ex.: servidor acordou no Render), reivindica nome e puxa avisos de novo
    if (socket && !socket.__mcAnnReconnectBound) {
      socket.__mcAnnReconnectBound = true;
      socket.on('connect', () => {
        claimAndLoadAnnouncements();
      });
    }
  });

  // Navegação lateral do lobby arena
  document.querySelectorAll('.arena-nav-item[data-scroll]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.arena-nav-item[data-scroll]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const id = btn.getAttribute('data-scroll');
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  setupMobileInstallButton();

  // Service worker (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
