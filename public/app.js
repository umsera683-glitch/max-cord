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

let isScreenSharing = false;
let isCameraOn = false;
let isMicOn = false;
let isAudioMuted = false;
let noiseSuppressionOn = true;   // supressão de ruído ligada por padrão
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

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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

function supportsScreenShare() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function saveName(n) { try { localStorage.setItem('sh_username', n); } catch (_) {} }
function loadName()  { try { return localStorage.getItem('sh_username') || ''; } catch (_) { return ''; } }
function savePhoto(url) { try { localStorage.setItem('sh_photo', url); } catch (_) {} }
function loadPhoto()    { try { return localStorage.getItem('sh_photo') || ''; } catch (_) { return ''; } }

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
      photoUrl: data.photoUrl || ''
    });
    updateParticipantCount();
    renderParticipantsList();
    showToast(`${data.name} entrou na sala`, 'info');
    connectToPeer(data.id);
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

  // Receber foto de perfil de outro participante (enviada diretamente, não via servidor)
  socket.on('photo-share', (data) => {
    const p = participants.get(data.id);
    if (p && data.photoUrl) {
      p.photoUrl = data.photoUrl;
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
    if (pc.connectionState === 'failed') {
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
  const videoTrack = getCurrentVideoTrack();
  const audioTrack = getMicAudioTrack();
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
      pc.addTrack(track, ls);
    }
    if (track.kind === 'video') {
      const vs = pc.getSenders().find(s => s.track === track);
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
    params.encodings[0].maxBitrate = isScreen
      ? Math.round(Math.min(2_500_000, Math.max(700_000, 2_200_000 / Math.sqrt(n))))
      : Math.round(Math.min(1_200_000, Math.max(350_000, 900_000 / Math.sqrt(n))));
    params.encodings[0].maxFramerate = isScreen ? 24 : 24;
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
  }

  event.track.addEventListener('unmute', () => {
    if (event.track.kind === 'video') upsertVideoTile(peerId, stream);
  });
  event.track.addEventListener('ended', () => {
    if (event.track.kind === 'video' && !stream.getVideoTracks().some(t => t.readyState === 'live')) {
      removeVideoTile(peerId);
    }
  });

  if (event.track.kind === 'video') {
    upsertVideoTile(peerId, stream);
  } else if (event.track.kind === 'audio') {
    // Tentar adicionar o áudio ao vídeo tile existente
    const videoTile = document.getElementById(`${peerId}-video`);
    if (videoTile) {
      const video = videoTile.querySelector('video');
      if (video) {
        // Garantir que o track de áudio está no srcObject do vídeo
        if (video.srcObject && video.srcObject !== stream) {
          // Streams diferentes — adicionar o track de áudio ao stream do vídeo
          try {
            video.srcObject.addTrack(event.track);
          } catch (_) {
            // Fallback: trocar para o stream que tem vídeo+áudio
            if (stream.getVideoTracks().length > 0) {
              bindVideoPlayback(video, stream, peerId);
            }
          }
        } else if (video.srcObject === stream) {
          // Mesmo stream — apenas garantir play com áudio
        } else {
          // Sem srcObject ainda — atribuir agora
          bindVideoPlayback(video, stream, peerId);
        }
        // Desmutar e dar play
        if (!isAudioMuted) video.muted = false;
        video.play().catch(() => {});
        return;
      }
    }
    // Sem tile de vídeo — criar tile de áudio puro
    const p = participants.get(peerId);
    upsertAudioTile(peerId, stream, p ? p.name : 'Remoto');
  }
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
  // Remoto: começa mutado para passar a autoplay policy,
  // mas desmuta imediatamente após o play resolver
  video.muted = isSelf ? true : true;

  const reveal = () => revealVideoEl(video);

  const tryPlay = async () => {
    try {
      await video.play();
      // Play ok — desmutar remoto se áudio global não estiver silenciado
      if (!isSelf && !isAudioMuted) {
        video.muted = false;
      }
      reveal();
    } catch (err) {
      // Autoplay bloqueado (mobile sem interação) — tentar com muted
      if (!video.muted) {
        video.muted = true;
        try {
          await video.play();
          reveal();
          // Aguardar interação do usuário para desmutar
          const unmute = () => {
            if (!isSelf && !isAudioMuted) video.muted = false;
            document.removeEventListener('click', unmute);
            document.removeEventListener('touchend', unmute);
          };
          document.addEventListener('click', unmute, { once: true });
          document.addEventListener('touchend', unmute, { once: true });
        } catch (_) {}
      }
    }
  };

  video.addEventListener('loadedmetadata', reveal, { once: true });
  video.addEventListener('loadeddata',     reveal, { once: true });
  video.addEventListener('playing',        reveal, { once: true });

  // Quando um novo track é adicionado ao stream (ex: áudio chegou depois)
  stream.addEventListener('addtrack', () => {
    const hasAudio = stream.getAudioTracks().some(t => t.readyState === 'live');
    if (hasAudio && !isSelf && !isAudioMuted) {
      video.muted = false;
      video.play().catch(() => {});
    }
  });

  tryPlay();

  // Fallback: revelar após 2.5s mesmo sem frames
  setTimeout(() => {
    if (video.style.opacity !== '1') { reveal(); tryPlay(); }
  }, 2500);
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
}

function upsertAudioTile(peerId, stream, name) {
  // Áudio puro — usar elemento <audio> invisível (não criar tile visual)
  // mas mostrar tile de "mic ativo" para indicar a presença de áudio
  const tileId = `${peerId}-mic`;
  if (document.getElementById(tileId)) {
    // Atualizar srcObject
    const audio = document.getElementById(tileId).querySelector('audio');
    if (audio) audio.srcObject = stream;
    return;
  }

  const col = nameColor(name);
  const tile = document.createElement('div');
  tile.id = tileId;
  tile.className = 'stream-tile audio-only';
  tile.dataset.peerId = peerId;
  tile.innerHTML = `
    <div class="mic-avatar" style="background:linear-gradient(135deg,${col},${col}88)">🎙️</div>
    <div class="mic-name">${name}</div>
  `;

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.srcObject = stream;
  audio.muted = isAudioMuted;
  audio.style.display = 'none';
  tile.appendChild(audio);
  audio.play().catch(() => {});

  document.getElementById('streams-grid').appendChild(tile);
  tiles.set(tileId, tile);
  updateGridClass();
  hideNoStream();
}

function updateTileLabel(tile, name, type) {
  const label = tile.querySelector('.stream-tile-label');
  if (!label) return;
  const col = nameColor(name);
  const icon = type === 'camera' ? '📹' : '🖥️';
  label.innerHTML = `
    <div class="tile-avatar" style="background:linear-gradient(135deg,${col},${col}88)">${nameInitial(name)}</div>
    <span class="tile-name">${name}</span>
    <span class="tile-type-badge">${icon}</span>
  `;
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(`${peerId}-video`);
  if (tile) { const v = tile.querySelector('video'); if (v) v.srcObject = null; tile.remove(); tiles.delete(`${peerId}-video`); }
  updateGridClass(); checkNoStream();
}

function removeMicTile(peerId) {
  const tile = document.getElementById(`${peerId}-mic`);
  if (tile) { const a = tile.querySelector('audio'); if (a) a.srcObject = null; tile.remove(); tiles.delete(`${peerId}-mic`); }
  updateGridClass(); checkNoStream();
}

function removeTilesByPeer(peerId) { removeVideoTile(peerId); removeMicTile(peerId); }

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

    for (const [, entry] of peers) {
      if (entry.pc) replaceAudioTrackInPeer(entry.pc, trackToSend);
    }
    return true;
  } catch (err) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      isMicOn = true;
      socket.emit('mic-update', { hasMic: true, micMuted: false });
      const track = micStream.getAudioTracks()[0];
      for (const [, entry] of peers) {
        if (entry.pc) replaceAudioTrackInPeer(entry.pc, track);
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
    if (screenAudioTrack && audioTrackToSend) {
      audioTrackToSend = await mergeAudioTracks(screenAudioTrack, audioTrackToSend);
    } else if (screenAudioTrack) {
      audioTrackToSend = screenAudioTrack;
    }

    if (audioTrackToSend) {
      for (const [, entry] of peers) {
        if (entry.pc) replaceAudioTrackInPeer(entry.pc, audioTrackToSend);
      }
    }

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

    // Guardar contexto para fechar ao parar
    window._mergeAudioCtx = ctx;

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
    if (micTrack) {
      for (const [, entry] of peers) {
        if (entry.pc) replaceAudioTrackInPeer(entry.pc, micTrack);
      }
    }
    socket.emit('stream-started', { type: 'camera', hasAudio: !!micStream });
  } else {
    clearVideoInAllPeers();
    socket.emit('stream-stopped');
  }

  updateSelfPreview();
  updateToolbarUI();
  showToast('Compartilhamento de tela encerrado', 'info');
}

function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  document.querySelectorAll('#streams-grid video, #streams-grid audio').forEach(el => {
    const tile = el.closest('.stream-tile');
    const isSelf = tile && tile.dataset.peerId === myId;
    if (isSelf) return; // nunca desmutar o próprio preview
    el.muted = isAudioMuted;
    // Ao desmutar, forçar play para garantir que o áudio começa
    if (!isAudioMuted) {
      el.play().catch(() => {
        // se play falhar, deixar mutado por ora
        el.muted = true;
      });
    }
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

  if (!rName) {
    showToast('Digite o nome da sala antes de criar', 'error');
    document.getElementById('create-room-name').focus();
    return;
  }

  if (!(await connectSocket())) return;
  myName = name; saveName(name);
  lastJoinPassword = password || '';

  socket.emit('create-room', { roomId, roomName: rName, password, userName: name, photoUrl: loadPhoto() }, (res) => {
    if (res.success) { isOwner = true; enterRoom(res.roomId, rName, true); }
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

  socket.emit('join-room', { roomId, password, userName: name, photoUrl: loadPhoto() }, (res) => {
    if (res.success) {
      isOwner = res.isOwner;
      participants.clear();
      res.participants.forEach(p => participants.set(p.id, {
        name: p.name, isOwner: p.isOwner,
        isBroadcasting: p.isBroadcasting, broadcastType: p.broadcastType,
        hasMic: p.hasMic, micMuted: p.micMuted,
        photoUrl: p.photoUrl || ''
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

  if (owner) {
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
    const at = getMicAudioTrack();
    if (at) {
      for (const [, entry] of peers) {
        if (entry.pc) replaceAudioTrackInPeer(entry.pc, at);
      }
    }
    if (isScreenSharing || isCameraOn) {
      socket.emit('stream-started', {
        type: isScreenSharing ? 'screen' : 'camera',
        hasAudio: !!micStream
      });
    }
    if (micStream) socket.emit('mic-update', { hasMic: true, micMuted: !isMicOn });
    showToast('Reconectado à sala', 'success');
  });
}

function leaveRoom(notify = true) {
  stopAllMedia();
  for (const [, e] of peers) { if (e.pc) try { e.pc.close(); } catch (_) {} }
  peers.clear(); pendingIce.clear(); participants.clear(); tiles.clear();

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
  document.getElementById('participant-count').textContent = participants.size + 1;
}

function renderParticipantsList() {
  const list = document.getElementById('participants-list');
  list.innerHTML = '';

  const renderItem = (id, name, owner, broadcasting, broadType, hasMic, micMuted, isMe, photoUrl) => {
    const col = nameColor(name);
    const micIcon = hasMic ? (micMuted ? '🔇' : '🎙️') : '';
    const vidIcon = broadcasting ? (broadType === 'screen' ? '🖥️' : '📹') : '';
    const div = document.createElement('div');
    div.className = 'participant-item';

    // Avatar: foto/GIF se disponível, senão inicial com cor
    const avatarHtml = photoUrl
      ? `<div class="avatar avatar-sm" style="background:transparent;padding:0">
           <img src="${photoUrl}" alt="${nameInitial(name)}"
             style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block"
             onerror="this.parentElement.innerHTML='${nameInitial(name)}';this.parentElement.style.background='linear-gradient(135deg,${col},${col}88)'">
         </div>`
      : `<div class="avatar avatar-sm" style="background:linear-gradient(135deg,${col},${col}88)">${nameInitial(name)}</div>`;

    div.innerHTML = `
      ${avatarHtml}
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
  if (!roomsArr || !roomsArr.length) {
    c.innerHTML = '<p class="rooms-empty">Nenhuma sala disponível no momento.</p>';
    return;
  }
  c.innerHTML = '';
  roomsArr.forEach(room => {
    const item = document.createElement('div');
    item.className = 'room-list-item';
    item.innerHTML = `
      <div class="room-info">
        <div class="room-title">${room.name || room.id}</div>
        <div class="room-meta">${room.hasPassword ? '🔒 ' : ''}${room.participantCount} participante${room.participantCount !== 1 ? 's' : ''} · ${room.ownerName}</div>
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

function saveProfile() {
  const nameEl  = document.getElementById('global-username');
  const photoEl = document.getElementById('profile-photo-url');
  const name    = nameEl ? nameEl.value.trim() : '';
  const photo   = photoEl ? photoEl.value.trim() : '';

  if (!name) {
    showToast('Digite seu apelido', 'error');
    if (nameEl) nameEl.focus();
    return;
  }
  saveName(name);
  savePhoto(photo);
  showProfileView();
  showToast('Perfil salvo!', 'success');
}

function handlePhotoUpload(file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    showToast('Arquivo muito grande. Use até 3MB ou cole uma URL.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const photoEl = document.getElementById('profile-photo-url');
    if (photoEl) photoEl.value = e.target.result;
    updateAvatarPreview();
  };
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
document.addEventListener('touchend', e => { const now = Date.now(); if (now - lastTap < 300) e.preventDefault(); lastTap = now; }, { passive: false });
document.addEventListener('contextmenu', e => { if (e.target.tagName === 'VIDEO') e.preventDefault(); });

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

  const avatarHtml = msg.photoUrl
    ? `<div class="chat-msg-avatar"><img src="${msg.photoUrl}" onerror="this.parentElement.textContent='${nameInitial(msg.name)}'"></div>`
    : `<div class="chat-msg-avatar" style="background:linear-gradient(135deg,${col},${col}88)">${nameInitial(msg.name)}</div>`;

  div.innerHTML = `
    ${avatarHtml}
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
  if (noiseSuppressionOn) {
    btn.className = 'toolbar-btn active-noise';
    btn.querySelector('.btn-label').textContent = 'RNNoise';
  } else {
    btn.className = 'toolbar-btn off-noise';
    btn.querySelector('.btn-label').textContent = 'Ruído Off';
  }
}

document.getElementById('btn-noise').addEventListener('click', toggleNoiseSuppression);

// ==================== QUALIDADE DE TRANSMISSÃO ====================

const QUALITY_PRESETS = {
  high:   { width: 1920, height: 1080, frameRate: 30, bitrate: 2500000 },
  medium: { width: 1280, height: 720,  frameRate: 30, bitrate: 1200000 },
  low:    { width: 854,  height: 480,  frameRate: 15, bitrate:  500000 }
};

// ==================== SELECT DE QUALIDADE (inline na toolbar) ====================

document.getElementById('quality-select').addEventListener('change', async (e) => {
  streamQuality = e.target.value;
  try { localStorage.setItem('mc_quality', streamQuality); } catch (_) {}

  const q = QUALITY_PRESETS[streamQuality];
  if (!q) return;

  // Se câmera ativa, reaplicar constraints em tempo real
  if (isCameraOn && cameraStream) {
    const videoTrack = cameraStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        await videoTrack.applyConstraints({
          width:     { ideal: isMobile() ? Math.min(q.width, 640)  : q.width  },
          height:    { ideal: isMobile() ? Math.min(q.height, 480) : q.height },
          frameRate: { ideal: q.frameRate }
        });
        // Atualizar bitrate nos senders
        for (const [, entry] of peers) {
          if (!entry.pc) continue;
          const vs = entry.pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (vs) optimizeVideoSenderWithPreset(vs, q);
        }
        showToast(`Qualidade: ${e.target.options[e.target.selectedIndex].text}`, 'success');
      } catch (err) {
        console.warn('applyConstraints falhou, recriando câmera:', err);
        await stopCamera();
        await startCamera();
      }
    }
  } else if (isScreenSharing && screenStream) {
    showToast(`Qualidade ${e.target.options[e.target.selectedIndex].text} salva`, 'info');
  } else {
    showToast(`Qualidade definida: ${e.target.options[e.target.selectedIndex].text}`, 'info');
  }
});

async function optimizeVideoSenderWithPreset(sender, q) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate  = q.bitrate;
    params.encodings[0].maxFramerate = q.frameRate;
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
