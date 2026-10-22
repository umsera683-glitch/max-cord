'use strict';
// =====================================================================
//  StreamHub — app.js  (versão corrigida)
//
//  Bugs corrigidos:
//  1. stopScreenShare: onended=null antes de .stop() evita double-call
//  2. request-peer handler: isInitiator=true para criar offer
//  3. renegotiateWithPeer: sempre usa mapa peers para encontrar peerId
//  4. broadcastVideoTrack: renegocia após addTrack
//  5. handleRemoteTrack: cria stream local se event.streams[0] undefined
//  6. toggleMic: funciona sem câmera/tela ativa
//  7. onnegotiationneeded: configurado em cada PC para renegociação automática
//  8. Tile self-preview: updateSelfPreview decide criar/atualizar/remover
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

// peerId -> { pc: RTCPeerConnection, streams: Map }
const peers = new Map();
const pendingIce = new Map();

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
    // STUN Google
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },

    // STUN Open Relay
    { urls: 'stun:openrelay.metered.ca:80' },

    // TURN Open Relay — funciona mesmo em 4G e NAT restrito
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:80?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'relay'   // Força TURN — funciona em qualquer rede/4G/NAT
};

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

    socket = io(window.SOCKET_URL || location.origin, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5
    });

    socket.on('connect', () => { myId = socket.id; setupSocketListeners(); resolve(true); });
    socket.on('connect_error', err => {
      console.warn('Socket connect_error:', err.message);
      resolve(false);
    });
    socket.on('disconnect', () => showToast('Conexão perdida. Reconectando...', 'error'));
    socket.on('reconnect', () => { myId = socket.id; showToast('Reconectado!', 'success'); });
    setTimeout(() => { if (!socket.connected) resolve(false); }, 10000);
  });
}

// ==================== LISTENERS DO SOCKET ====================

function setupSocketListeners() {

  socket.on('user-joined', (data) => {
    participants.set(data.id, {
      name: data.name, isOwner: data.isOwner,
      isBroadcasting: false, broadcastType: null, hasMic: false, micMuted: true,
      photoUrl: data.photoUrl || ''
    });
    updateParticipantCount();
    renderParticipantsList();
    showToast(`${data.name} entrou na sala`, 'info');
    // Quem JÁ ESTAVA na sala faz offer para o recém-chegado
    initPeerConnection(data.id, true);
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

  // FIX 2a: quem recebe request-peer também faz offer (isInitiator=true)
  // Ambos os lados criam offer — o lado que chegar primeiro com setRemoteDescription vence
  socket.on('request-peer', ({ fromId }) => {
    initPeerConnection(fromId, true);
  });

  socket.on('offer',         async ({ fromId, sdp })       => handleOffer(fromId, sdp));
  socket.on('answer',        async ({ fromId, sdp })       => handleAnswer(fromId, sdp));
  socket.on('ice-candidate', async ({ fromId, candidate }) => handleIceCandidate(fromId, candidate));
}

// ==================== PEER CONNECTIONS ====================

function getPeerEntry(peerId) {
  if (!peers.has(peerId)) peers.set(peerId, { pc: null, streams: new Map() });
  return peers.get(peerId);
}

// Dado um PC, retorna o peerId consultando o mapa
function findPeerId(pc) {
  for (const [id, entry] of peers) {
    if (entry.pc === pc) return id;
  }
  return null;
}

function initPeerConnection(peerId, isInitiator) {
  const entry = getPeerEntry(peerId);

  // Fechar PC anterior
  if (entry.pc) { try { entry.pc.close(); } catch (_) {} entry.pc = null; }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  entry.pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { targetId: peerId, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeer(peerId);
    }
  };

  // FIX 7: onnegotiationneeded — protegido contra estados inválidos e glare
  pc.onnegotiationneeded = async () => {
    if (pc.signalingState !== 'stable') return; // Não criar offer se já em negociação
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return; // Checar novamente após await
      await pc.setLocalDescription(offer);
      socket.emit('offer', { targetId: peerId, sdp: offer });
    } catch (err) {
      if (!err.message.includes('InvalidStateError')) {
        console.error('onnegotiationneeded:', err);
      }
    }
  };

  pc.ontrack = (e) => handleRemoteTrack(peerId, e);

  // Adicionar tracks locais existentes
  addLocalTracksToPeer(pc);

  if (isInitiator) {
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { targetId: peerId, sdp: offer });
      } catch (err) {
        console.error('initPeer offer:', err);
      }
    }, 200);
  }

  return pc;
}

// Adiciona todas as tracks locais ativas ao PC
function addLocalTracksToPeer(pc) {
  const videoTrack = getCurrentVideoTrack();
  const audioTrack = getMicAudioTrack();

  if (!videoTrack && !audioTrack) return;

  const ls = new MediaStream();
  if (videoTrack) ls.addTrack(videoTrack);
  if (audioTrack) ls.addTrack(audioTrack);

  ls.getTracks().forEach(track => {
    // Verificar se já foi adicionado
    const already = pc.getSenders().find(s => s.track === track);
    if (!already) pc.addTrack(track, ls);
  });
}

// FIX 2b/3: replaceVideoTrackInPeer não precisa mais de renegotiateWithPeer manual
// pois onnegotiationneeded é disparado automaticamente após addTrack
function replaceVideoTrackInPeer(pc, newTrack) {
  const senders = pc.getSenders();
  const vs = senders.find(s => s.track && s.track.kind === 'video');
  if (vs) {
    vs.replaceTrack(newTrack).catch(err => console.error('replaceVideoTrack:', err));
  } else {
    const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
    const ls = new MediaStream([newTrack]);
    if (audioSender && audioSender.track) ls.addTrack(audioSender.track);
    pc.addTrack(newTrack, ls);
    // onnegotiationneeded será disparado automaticamente
  }
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
    // onnegotiationneeded será disparado automaticamente
  }
}

async function handleOffer(fromId, sdp) {
  const entry = getPeerEntry(fromId);
  if (!entry.pc) initPeerConnection(fromId, false);
  const pc = entry.pc;

  try {
    // Se já tem oferta local pendente (glare), o lado com menor ID vence
    if (pc.signalingState === 'have-local-offer') {
      if (myId < fromId) {
        // Eu tenho precedência — ignorar a oferta remota
        return;
      }
      // O outro lado tem precedência — descartar minha oferta
      await pc.setLocalDescription({ type: 'rollback' });
    }

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    flushIce(fromId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { targetId: fromId, sdp: answer });
  } catch (err) {
    console.error('handleOffer:', err);
  }
}

async function handleAnswer(fromId, sdp) {
  const entry = peers.get(fromId);
  if (!entry || !entry.pc) return;
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

// FIX 5: cria stream local se event.streams[0] for undefined
// FIX ÁUDIO: quem transmite não ouve o próprio áudio de volta
function handleRemoteTrack(peerId, event) {
  const stream = event.streams[0] || (() => {
    const s = new MediaStream();
    s.addTrack(event.track);
    return s;
  })();

  const entry = getPeerEntry(peerId);
  entry.streams.set(stream.id, stream);

  const hasVideo = stream.getVideoTracks().length > 0;
  const hasAudio = stream.getAudioTracks().length > 0;

  // Se este stream veio do próprio usuário (eco), ignorar áudio
  const isOwnEcho = (peerId === myId);

  if (hasVideo) {
    upsertVideoTile(peerId, stream);
  } else if (hasAudio && !isOwnEcho) {
    const p = participants.get(peerId);
    upsertAudioTile(peerId, stream, p ? p.name : 'Remoto');
  }

  // Mutar: eco próprio SEMPRE mudo; outros obedecem isAudioMuted
  document.querySelectorAll('#streams-grid video, #streams-grid audio').forEach(el => {
    if (el.srcObject === stream) {
      el.muted = isOwnEcho ? true : isAudioMuted;
    }
  });
}

// ==================== TILES ====================

function upsertVideoTile(peerId, stream) {
  const tileId = `${peerId}-video`;
  let tile = document.getElementById(tileId);

  if (!tile) {
    tile = document.createElement('div');
    tile.id = tileId;
    tile.className = 'stream-tile type-screen';
    tile.dataset.peerId = peerId;
    tile.addEventListener('click', () => makeTileFullscreen(tile));

    // ── Loader (visível enquanto o vídeo não tem frames) ──
    const loader = document.createElement('div');
    loader.className = 'tile-loader';
    loader.innerHTML = `
      <div class="tile-loader-spinner"></div>
      <span class="tile-loader-text">Conectando...</span>`;
    tile.appendChild(loader);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.muted = (peerId === myId) ? true : isAudioMuted;
    video.srcObject = stream;
    video.style.opacity = '0';  // Esconde até ter frames
    tile.appendChild(video);

    // Quando o primeiro frame chegar, esconde o loader e mostra o vídeo
    video.addEventListener('loadeddata', function onLoaded() {
      video.style.opacity = '1';
      video.style.transition = 'opacity 0.4s ease';
      loader.style.display = 'none';
      video.removeEventListener('loadeddata', onLoaded);
    });

    // Fallback: se demorar mais de 15s ainda aguardando, mostrar mensagem
    const timeout = setTimeout(() => {
      if (video.style.opacity === '0') {
        loader.querySelector('.tile-loader-text').textContent = 'Aguardando stream...';
      }
    }, 15000);

    video.addEventListener('loadeddata', () => clearTimeout(timeout), { once: true });

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
      video.srcObject = stream;
      // Resetar opacity se stream foi trocado
      if (video.style.opacity === '1') return; // já estava visível
      video.style.opacity = '0';
      const loader = tile.querySelector('.tile-loader');
      if (loader) loader.style.display = '';
      video.addEventListener('loadeddata', function onLoaded() {
        video.style.opacity = '1';
        if (loader) loader.style.display = 'none';
        video.removeEventListener('loadeddata', onLoaded);
      });
    }
  }

  const p = participants.get(peerId);
  const name = peerId === myId ? myName + ' (você)' : (p ? p.name : 'Remoto');
  const type = (p && p.broadcastType) || 'screen';
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
  compScreenEl.play().catch(() => {});
  compCameraEl.play().catch(() => {});

  compositeStream = compositeCanvas.captureStream(25);

  let loaded = 0;
  const onReady = () => { if (++loaded >= 2 && !compRAF) drawComposite(); };
  compScreenEl.readyState >= 1 ? onReady() : compScreenEl.addEventListener('loadedmetadata', onReady, { once: true });
  compCameraEl.readyState >= 1 ? onReady() : compCameraEl.addEventListener('loadedmetadata', onReady, { once: true });

  return compositeStream;
}

function drawComposite() {
  if (!compositeCtx || !isScreenSharing || !isCameraOn) { compRAF = null; return; }
  const w = compositeCanvas.width, h = compositeCanvas.height;

  compositeCtx.fillStyle = '#000';
  compositeCtx.fillRect(0, 0, w, h);

  if (compScreenEl && compScreenEl.videoWidth > 0) compositeCtx.drawImage(compScreenEl, 0, 0, w, h);

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
      echoCancellation:   true,
      noiseSuppression:   true,
      autoGainControl:    true,
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
    micStream = await navigator.mediaDevices.getUserMedia(getMicConstraints());
    isMicOn = true;
    socket.emit('mic-update', { hasMic: true, micMuted: false });

    const track = micStream.getAudioTracks()[0];
    for (const [, entry] of peers) {
      if (entry.pc) replaceAudioTrackInPeer(entry.pc, track);
    }
    return true;
  } catch (err) {
    // Fallback sem constraints avançadas (alguns Android mais antigos)
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
    // Mobile: câmera frontal com resolução adaptada
    // Desktop: câmera HD padrão
    const constraints = isMobile()
      ? {
          video: {
            facingMode:  'user',
            width:       { ideal: 640 },
            height:      { ideal: 480 },
            frameRate:   { ideal: 24 }
          },
          audio: false
        }
      : {
          video: {
            width:     { ideal: 1280 },
            height:    { ideal: 720 },
            frameRate: { ideal: 30 }
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
  showToast('Câmera desligada', 'info');
}

async function startScreenShare() {
  if (!supportsScreenShare()) {
    showToast('No celular use a Câmera para transmitir 📹', 'info');
    return;
  }
  try {
    // Pede áudio do sistema junto com a tela (funciona no Chrome/Edge desktop)
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: { ideal: 30 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false
      }
    });
    isScreenSharing = true;

    const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

    // Garantir microfone ativo
    if (!micStream) await startMic();

    // FIX 1: cancelar onended antes de parar para evitar double-call
    screenStream.getVideoTracks()[0].onended = () => {
      if (isScreenSharing) stopScreenShare();
    };

    const videoTrack = getCurrentVideoTrack();
    broadcastVideoTrack(videoTrack);

    // ---- ÁUDIO: mesclar áudio do sistema + microfone ----
    let audioTrackToSend = getMicAudioTrack();

    if (screenAudioTrack && audioTrackToSend) {
      // Mesclar áudio do sistema com microfone via AudioContext
      audioTrackToSend = await mergeAudioTracks(screenAudioTrack, audioTrackToSend);
    } else if (screenAudioTrack) {
      // Só áudio do sistema (sem mic)
      audioTrackToSend = screenAudioTrack;
    }
    // Se só mic e sem áudio do sistema, audioTrackToSend já é o mic

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
    if (err.name === 'NotAllowedError') {
      showToast('Permissão negada para compartilhar a tela', 'error');
    } else {
      showToast('Não foi possível compartilhar a tela', 'error');
    }
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
    // Nunca mutar o próprio preview
    if (el.muted !== true || el.id !== `${myId}-video`) el.muted = isAudioMuted;
  });
  updateToolbarUI();
  showToast(isAudioMuted ? 'Áudio silenciado' : 'Áudio ativado', isAudioMuted ? 'info' : 'success');
}

// ==================== HELPERS DE BROADCAST ====================

// FIX 4: broadcastVideoTrack — sem offer manual, deixa só o onnegotiationneeded trabalhar
// O offer manual criava conflito com onnegotiationneeded (2 offers simultâneos → tela preta)
function broadcastVideoTrack(videoTrack) {
  if (!videoTrack) return;
  const audioTrack = getMicAudioTrack();

  for (const [, entry] of peers) {
    if (!entry.pc) continue;
    const vs = entry.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (vs) {
      // Já tem sender — só trocar o track (replaceTrack não dispara onnegotiationneeded)
      vs.replaceTrack(videoTrack).catch(err => console.error('broadcast replaceTrack:', err));
    } else {
      // Sem sender — addTrack dispara onnegotiationneeded automaticamente (agora protegido)
      const ls = new MediaStream([videoTrack]);
      if (audioTrack) ls.addTrack(audioTrack);
      entry.pc.addTrack(videoTrack, ls);
      // onnegotiationneeded (protegido com signalingState) vai criar e enviar o offer
    }
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
    const senders = entry.pc.getSenders();
    const vs = senders.find(s => s.track && s.track.kind === 'video');
    if (vs) entry.pc.removeTrack(vs);
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
  if (isCameraOn && cameraStream) {
    video.srcObject = cameraStream;
    tile.className = 'stream-tile type-camera';
    updateTileLabel(tile, myName + ' (você)', 'camera');
  } else if (isScreenSharing && screenStream) {
    video.srcObject = screenStream;
    tile.className = 'stream-tile type-screen';
    updateTileLabel(tile, myName + ' (você)', 'screen');
  }
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
      showToast(res.message, 'error');
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

  // Conectar com todos os peers já na sala
  for (const [pid] of participants) {
    if (pid !== myId) socket.emit('request-peer', { targetId: pid });
  }

  // BUG FIX: solicitar stream de quem já está transmitindo
  // request-peer dispara offer → ontrack → tile aparece
  // Mas se o broadcaster já adicionou tracks antes, precisamos garantir
  // que ele vai re-enviar o offer com as tracks ao receber request-peer.
  // O servidor já repassa request-peer → broadcaster chama initPeerConnection(isInitiator=true)
  // que chama addLocalTracksToPeer → se tiver tracks, o offer vai com elas. ✓

  showToast(`Você entrou em ${rName || roomId}`, 'success');
}

function leaveRoom(notify = true) {
  stopAllMedia();
  for (const [, e] of peers) { if (e.pc) try { e.pc.close(); } catch (_) {} }
  peers.clear(); pendingIce.clear(); participants.clear(); tiles.clear();

  if (notify && socket) socket.emit('leave-room');

  isOwner = false; currentRoomId = null; roomName = '';
  isAudioMuted = false;

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
  isScreenSharing ? stopScreenShare() : startScreenShare();
});
document.getElementById('btn-camera').addEventListener('click', () => isCameraOn ? stopCamera() : startCamera());
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

// beforeunload: dispara ao fechar aba, fechar navegador ou recarregar
window.addEventListener('beforeunload', () => {
  if (currentRoomId && socket) {
    stopAllMedia();
    socket.emit('leave-room');
  }
});

// pagehide: fallback para mobile (iOS Safari não dispara beforeunload confiável)
window.addEventListener('pagehide', () => {
  if (currentRoomId && socket) {
    stopAllMedia();
    socket.emit('leave-room');
  }
});

// visibilitychange: detecta quando app vai para background no mobile
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && currentRoomId && socket) {
    // No mobile, quando o usuário sai do app a página fica "hidden"
    // Apenas emite leave sem parar a mídia (pode ter voltado)
    socket.emit('leave-room');
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

// ==================== INIT ====================

(function init() {
  // Aplicar tema salvo ANTES de tudo (evita flash de tema errado)
  applyTheme(loadTheme());

  const saved = loadName();
  if (saved) {
    const el = document.getElementById('global-username');
    if (el) el.value = saved;
  }
  showProfileView();
  connectSocket().then(() => fetchRooms());
})();
