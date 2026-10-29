const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
require('dotenv').config();

/** POST JSON via https nativo (compatível com Node antigo, sem fetch). */
function httpsPostJson(urlStr, bodyObj, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = JSON.stringify(bodyObj);
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }, extraHeaders || {});
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: timeoutMs || 25000
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

const app    = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 8080;

// CORS aberto: qualquer navegador/usuário pode conectar (necessário para
// vários dispositivos, Netlify, Render, domínio customizado, etc.)
const ALLOWED_ORIGINS = true; // true = aceita qualquer origin

// ==================== SOCKET.IO ====================
const io = new Server(server, {
  cors: {
    origin: true, // reflete a origin do cliente — todos os usuários conseguem conectar
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 3e6
});

// ==================== MIDDLEWARES DE SEGURANÇA ====================

// Helmet — headers HTTP de segurança
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdn.socket.io', 'https://*.onrender.com'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
      // Permite WebSocket/HTTP para o próprio host e CDNs (qualquer usuário/navegador)
      connectSrc:     ["'self'", 'https:', 'wss:', 'http:', 'ws:',
                       'https://cdn.socket.io', 'wss://cdn.socket.io',
                       'https://stun.l.google.com', 'https://stun1.l.google.com',
                       'https://stun2.l.google.com', 'https://stun3.l.google.com',
                       'https://stun.cloudflare.com'],
      mediaSrc:       ["'self'", 'blob:', 'mediastream:'],
      imgSrc:         ["'self'", 'data:', 'blob:', 'https:'],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// CORS para rotas HTTP — aberto para todos os usuários
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  credentials: true
}));

// Rate limiting global — máx 120 req/min por IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' }
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== SANITIZAÇÃO ====================

function sanitizeStr(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen || 100).replace(/[<>]/g, '');
}

// Fotos/GIFs: NÃO usar sanitizeStr(500) — cortava data:image e deixava avatar preto
const MAX_PHOTO_LEN = 500000;
function sanitizePhoto(url) {
  if (typeof url !== 'string') return '';
  url = url.trim();
  if (!url || url.length > MAX_PHOTO_LEN) return '';
  if (url.startsWith('data:image/')) return url;
  if (/^https?:\/\//i.test(url)) return url.slice(0, 2000);
  return '';
}

function isValidRoomId(id) {
  return typeof id === 'string' && /^[A-Z0-9]{2,12}$/.test(id);
}

// ==================== GESTÃO DE SALAS ====================

const rooms = new Map();
const EMPTY_ROOM_TTL    = 30 * 60 * 1000; // 30 min vazia
const MAX_ROOMS         = 200;
const MAX_PARTICIPANTS  = 50;

// Rate limit de eventos Socket.io por socket (criar/entrar sala)
const socketEventCounts = new Map();
function checkSocketRate(socketId, event, limit, windowMs) {
  const key  = `${socketId}:${event}`;
  const now  = Date.now();
  const data = socketEventCounts.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > data.resetAt) { data.count = 0; data.resetAt = now + windowMs; }
  data.count++;
  socketEventCounts.set(key, data);
  return data.count <= limit;
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Limpeza periódica
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, room] of rooms) {
    if (room.participants.size === 0 && (now - room.emptyAt) > EMPTY_ROOM_TTL) {
      rooms.delete(id);
      changed = true;
      console.log(`[Sala] ${id} expirou`);
    }
  }
  if (changed) broadcastRoomList();
  // Limpar contadores de rate do socket
  for (const [key, data] of socketEventCounts) {
    if (Date.now() > data.resetAt + 60000) socketEventCounts.delete(key);
  }
}, 5 * 60 * 1000);

// ==================== BROADCAST DE SALAS (tempo real) ====================

// Emite lista atualizada para TODOS os clientes conectados
// Throttle de 300ms para evitar spam quando muitos eventos acontecem juntos
let _broadcastTimer = null;

/** Remove da sala sockets que já desconectaram (evita contagem 0 errada / fantasmas). */
function pruneRoomParticipants(room) {
  if (!room || !room.participants) return;
  for (const pid of [...room.participants.keys()]) {
    const s = io.sockets.sockets.get(pid);
    if (!s || !s.connected) {
      room.participants.delete(pid);
    }
  }
  if (room.participants.size === 0) {
    if (!room.emptyAt) room.emptyAt = Date.now();
  } else {
    room.emptyAt = null;
  }
}

function buildRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    pruneRoomParticipants(room);
    const count = room.participants.size;
    // Não listar salas vazias — evita mostrar "0 pessoas"
    if (count === 0) continue;
    list.push({
      id,
      name:             room.name,
      hasPassword:      room.hasPassword,
      participantCount: count,
      ownerName:        room.ownerName
    });
  }
  list.sort((a, b) => b.participantCount - a.participantCount);
  return list;
}

function broadcastRoomList() {
  if (_broadcastTimer) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    io.emit('room-list-update', { rooms: buildRoomList() });
  }, 300);
}

// ==================== LÓGICA DE DESCONEXÃO ====================

function handleLeave(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) { socket.roomId = null; return; }

  const participant    = room.participants.get(socket.id);
  const wasBroadcasting = participant ? participant.isBroadcasting : false;

  room.participants.delete(socket.id);
  socket.leave(roomId);

  socket.to(roomId).emit('user-left', {
    id:   socket.id,
    name: participant ? participant.name : 'Alguém'
  });

  if (wasBroadcasting) {
    socket.to(roomId).emit('stream-stopped', { id: socket.id });
  }

  if (room.participants.size === 0) {
    room.emptyAt = Date.now();
  }

  socket.roomId = null;
  broadcastRoomList();
}


// ==================== COMUNIDADE ====================
const communityServers = new Map();
const userBySocket = new Map();
const socketsByUser = new Map();
const dmMessages = new Map();
const inviteIndex = new Map();
const voicePeers = new Map();
function genId(p){const c='abcdefghijklmnopqrstuvwxyz0123456789';let id=p||'';for(let i=0;i<10;i++)id+=c[Math.floor(Math.random()*c.length)];return id;}
function genInvite(){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let id='';for(let i=0;i<8;i++)id+=c[Math.floor(Math.random()*c.length)];return id;}
function dmKey(a,b){return [a,b].sort().join(':');}
function publicUser(u){return {userId:u.userId,name:u.name,photoUrl:u.photoUrl||''};}
function channelPublic(ch){return {id:ch.id,name:ch.name,type:ch.type||'text'};}
function serverPublic(s){return {id:s.id,name:s.name,icon:s.icon||'',iconUrl:s.iconUrl||'',ownerId:s.ownerId,inviteCode:s.inviteCode,memberCount:s.members.size,channels:Array.from(s.channels.values()).map(channelPublic)};}
function emitToUser(userId,event,payload){const set=socketsByUser.get(userId);if(!set)return;for(const sid of set)io.to(sid).emit(event,payload);}
function onlineUsersList(){const seen=new Map();for(const u of userBySocket.values()){if(!seen.has(u.userId))seen.set(u.userId,publicUser(u));}return Array.from(seen.values());}
function broadcastOnlineUsers(){io.emit('community-online',{users:onlineUsersList()});}
function registerUser(socket,data){
  const userId=sanitizeStr((data||{}).userId,48);const name=sanitizeStr((data||{}).name,20);const photoUrl=sanitizePhoto((data||{}).photoUrl||'');
  if(!userId||!name)return null;
  const prev=userBySocket.get(socket.id);
  if(prev){const set=socketsByUser.get(prev.userId);if(set){set.delete(socket.id);if(!set.size)socketsByUser.delete(prev.userId);}}
  const user={userId,name,photoUrl};userBySocket.set(socket.id,user);
  if(!socketsByUser.has(userId))socketsByUser.set(userId,new Set());socketsByUser.get(userId).add(socket.id);socket.userId=userId;return user;
}
function leaveAllVoice(socket){
  const channelId=socket.voiceChannelId;if(!channelId)return;
  const peers=voicePeers.get(channelId);
  if(peers&&peers.has(socket.id)){peers.delete(socket.id);socket.leave('voice:'+channelId);io.to('voice:'+channelId).emit('voice-user-left',{channelId,socketId:socket.id});if(!peers.size)voicePeers.delete(channelId);}
  socket.voiceChannelId=null;
}
function unregisterSocket(socket){
  leaveAllVoice(socket);const u=userBySocket.get(socket.id);if(!u)return;userBySocket.delete(socket.id);
  const set=socketsByUser.get(u.userId);if(set){set.delete(socket.id);if(!set.size)socketsByUser.delete(u.userId);}socket.userId=null;
}

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} (${socket.handshake.address})`);

  // ---------- Listar salas ----------
  socket.on('list-rooms', (callback) => {
    if (typeof callback !== 'function') return;
    callback({ rooms: buildRoomList() });
  });

  // ---------- Verificar sala ----------
  socket.on('check-room', (data, callback) => {
    if (typeof callback !== 'function') return;
    const roomId = sanitizeStr((data || {}).roomId, 12).toUpperCase();
    const room   = rooms.get(roomId);
    if (!room) return callback({ exists: false });
    callback({
      exists:           true,
      name:             room.name,
      hasPassword:      room.hasPassword,
      participantCount: room.participants.size,
      ownerName:        room.ownerName
    });
  });

  // ---------- Redefinir senha ----------
  socket.on('reset-password', (data, callback) => {
    if (typeof callback !== 'function') return;
    const roomId      = sanitizeStr((data || {}).roomId, 12).toUpperCase();
    const ownerName   = sanitizeStr((data || {}).ownerName, 20);
    const newPassword = sanitizeStr((data || {}).newPassword, 60);

    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, message: 'Sala não encontrada.' });

    const nameMatch = room.ownerName.toLowerCase() === ownerName.toLowerCase();
    if (!nameMatch) {
      return callback({ success: false, message: 'Nome de dono incorreto.' });
    }

    room.password    = newPassword ? bcrypt.hashSync(newPassword, 10) : null;
    room.hasPassword = !!newPassword;
    callback({ success: true });
  });

  // ---------- Criar sala ----------
  socket.on('create-room', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (!checkSocketRate(socket.id, 'create-room', 5, 60000)) {
      return callback({ success: false, message: 'Criando salas muito rápido. Aguarde.' });
    }
    if (rooms.size >= MAX_ROOMS) {
      return callback({ success: false, message: 'Limite de salas atingido.' });
    }

    const roomId   = sanitizeStr((data || {}).roomId, 12).toUpperCase() || generateRoomId();
    const roomName = sanitizeStr((data || {}).roomName, 50) || roomId;
    const password = sanitizeStr((data || {}).password, 60);
    const userName = sanitizeStr((data || {}).userName, 20);
    const photoUrl = sanitizePhoto((data || {}).photoUrl || '');

    if (!userName)           return callback({ success: false, message: 'Nome inválido.' });
    if (!isValidRoomId(roomId)) return callback({ success: false, message: 'ID de sala inválido.' });
    if (rooms.has(roomId))   return callback({ success: false, message: 'Já existe uma sala com este ID.' });

    const room = {
      id:          roomId,
      name:        roomName,
      password:    password ? bcrypt.hashSync(password, 10) : null,
      hasPassword: !!password,
      ownerId:     socket.id,
      ownerName:   userName,
      participants: new Map(),
      emptyAt:     null
    };

    room.participants.set(socket.id, {
      name: userName, isOwner: true,
      isBroadcasting: false, broadcastType: null,
      hasMic: false, micMuted: true,
      photoUrl: photoUrl
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    callback({
      success: true,
      roomId,
      isOwner: true,
      roomName: roomName,
      participants: [{
        id: socket.id, name: userName, isOwner: true,
        isBroadcasting: false, broadcastType: null,
        hasMic: false, micMuted: true, photoUrl: photoUrl || ''
      }]
    });
    broadcastRoomList();
    console.log(`[Sala] ${roomId} criada por ${userName}`);
  });

  // ---------- Entrar na sala ----------
  socket.on('join-room', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (!checkSocketRate(socket.id, 'join-room', 10, 60000)) {
      return callback({ success: false, message: 'Muitas tentativas. Aguarde.' });
    }

    const roomId   = sanitizeStr((data || {}).roomId, 12).toUpperCase();
    const password = sanitizeStr((data || {}).password, 60);
    const userName = sanitizeStr((data || {}).userName, 20);
    const photoUrl = sanitizePhoto((data || {}).photoUrl || '');

    if (!userName) return callback({ success: false, message: 'Nome inválido.' });

    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, message: 'Sala não encontrada.' });

    if (socket.roomId && socket.roomId !== roomId) handleLeave(socket);

    if (room.participants.size >= MAX_PARTICIPANTS && !room.participants.has(socket.id)) {
      return callback({ success: false, message: 'Sala cheia.' });
    }

    if (room.hasPassword && !bcrypt.compareSync(password, room.password)) {
      return callback({ success: false, message: 'Senha incorreta.' });
    }

    // Reconexão do dono: se entrou com o mesmo nome do criador original
    // e o dono original não está mais conectado → restaurar privilégio
    const ownerCurrentlyOnline = room.participants.has(room.ownerId);
    if (!ownerCurrentlyOnline && userName.toLowerCase() === room.ownerName.toLowerCase()) {
      room.ownerId = socket.id;
    }

    // SEGURANÇA: ownership verificado pelo socket.id atual
    const joiningAsOwner = room.ownerId === socket.id;

    room.participants.set(socket.id, {
      name: userName, isOwner: joiningAsOwner,
      isBroadcasting: false, broadcastType: null,
      hasMic: false, micMuted: true,
      photoUrl: photoUrl
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    const participants = [];
    for (const [id, p] of room.participants) {
      participants.push({
        id, name: p.name, isOwner: p.isOwner,
        isBroadcasting: p.isBroadcasting,
        broadcastType:  p.broadcastType,
        hasMic:         p.hasMic,
        micMuted:       p.micMuted,
        photoUrl:       p.photoUrl || ''
      });
    }

    // Estado completo do novo participante (mídia + avatar) para quem já está na sala
    const joinerInfo = room.participants.get(socket.id);
    const joinedPayload = {
      id: socket.id,
      name: userName,
      isOwner: joiningAsOwner,
      photoUrl: photoUrl || '',
      isBroadcasting: !!(joinerInfo && joinerInfo.isBroadcasting),
      broadcastType: (joinerInfo && joinerInfo.broadcastType) || null,
      hasMic: !!(joinerInfo && joinerInfo.hasMic),
      micMuted: joinerInfo ? joinerInfo.micMuted !== false : true
    };

    // Emite user-joined por socket id (mais confiável que só room broadcast)
    for (const [pid] of room.participants) {
      if (pid === socket.id) continue;
      io.to(pid).emit('user-joined', joinedPayload);
    }
    // Também via room (redundância)
    socket.to(roomId).emit('user-joined', joinedPayload);

    // Lista completa de participantes
    const syncList = [];
    for (const [id, p] of room.participants) {
      syncList.push({
        id, name: p.name, isOwner: p.isOwner,
        isBroadcasting: p.isBroadcasting, broadcastType: p.broadcastType,
        hasMic: p.hasMic, micMuted: p.micMuted, photoUrl: p.photoUrl || ''
      });
    }
    const syncPayload = { roomId, participants: syncList };

    // Envia room-sync DIRETAMENTE para cada socket da sala (não depende só do adapter de room)
    for (const [pid] of room.participants) {
      io.to(pid).emit('room-sync', syncPayload);
    }
    io.to(roomId).emit('room-sync', syncPayload);

    callback({ success: true, roomId, roomName: room.name, isOwner: joiningAsOwner, participants: syncList });
    broadcastRoomList();
    console.log(`[Sala] ${userName} entrou em ${roomId} (${syncList.length} participantes)`);
  });

  // ---------- Sync sob demanda (cliente pede lista atualizada) ----------
  socket.on('sync-room', (callback) => {
    const roomId = socket.roomId;
    if (!roomId) {
      if (typeof callback === 'function') callback({ success: false, message: 'Fora de sala.' });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      socket.roomId = null;
      if (typeof callback === 'function') callback({ success: false, message: 'Sala não existe.' });
      return;
    }
    // Garante membership no adapter
    try { socket.join(roomId); } catch (_) {}

    pruneRoomParticipants(room);

    // Se este socket sumiu do Map (reconectou com outro id), recoloca
    if (!room.participants.has(socket.id)) {
      room.participants.set(socket.id, {
        name: sanitizeStr((socket.userName || 'Usuário'), 20) || 'Usuário',
        isOwner: room.ownerId === socket.id,
        isBroadcasting: false, broadcastType: null,
        hasMic: false, micMuted: true, photoUrl: ''
      });
    }

    const syncList = [];
    for (const [id, p] of room.participants) {
      syncList.push({
        id, name: p.name, isOwner: p.isOwner,
        isBroadcasting: p.isBroadcasting, broadcastType: p.broadcastType,
        hasMic: p.hasMic, micMuted: p.micMuted, photoUrl: p.photoUrl || ''
      });
    }
    const syncPayload = { roomId, participants: syncList };
    // Atualiza quem pediu e todos os outros
    for (const [pid] of room.participants) {
      io.to(pid).emit('room-sync', syncPayload);
    }
    if (typeof callback === 'function') {
      callback({ success: true, roomId, participants: syncList });
    }
    broadcastRoomList();
  });

  // ---------- Deletar sala ----------
  socket.on('delete-room', (callback) => {
    const roomId = socket.roomId;
    if (!roomId) return callback && callback({ success: false });
    const room = rooms.get(roomId);
    if (!room || room.ownerId !== socket.id) return callback && callback({ success: false, message: 'Sem permissão.' });

    io.to(roomId).emit('room-deleted', { message: 'A sala foi deletada pelo dono.' });
    for (const [id] of room.participants) {
      const s = io.sockets.sockets.get(id);
      if (s) { s.leave(roomId); s.roomId = null; }
    }
    rooms.delete(roomId);
    socket.roomId = null;
    callback && callback({ success: true });
    broadcastRoomList();
  });

  // ---------- Transmissão ----------
  socket.on('stream-started', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const type = sanitizeStr((data || {}).type, 10);
    const p    = room.participants.get(socket.id);
    if (p) { p.isBroadcasting = true; p.broadcastType = type; }
    socket.to(socket.roomId).emit('stream-started', {
      id: socket.id, name: p ? p.name : '?', type, hasAudio: !!(data || {}).hasAudio
    });
  });

  socket.on('stream-stopped', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) { p.isBroadcasting = false; p.broadcastType = null; }
    socket.to(socket.roomId).emit('stream-stopped', { id: socket.id });
  });

  socket.on('mic-update', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) { p.hasMic = !!(data || {}).hasMic; p.micMuted = !!(data || {}).micMuted; }
    socket.to(socket.roomId).emit('mic-update', {
      id: socket.id, hasMic: p.hasMic, micMuted: p.micMuted
    });
  });

  function sameRoomAs(targetId) {
    if (!targetId || !socket.roomId) return false;
    const room = rooms.get(socket.roomId);
    if (!room) return false;
    // Mesmo sala no Map OU ambos presentes nos participantes
    if (room.participants.has(socket.id) && room.participants.has(targetId)) return true;
    return false;
  }

  // ---------- Foto de perfil (relay para a sala) ----------
  socket.on('photo-share', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;
    const photoUrl = sanitizePhoto((data || {}).photoUrl || '');
    if (!photoUrl) return;
    p.photoUrl = photoUrl;
    // Envia para os outros na sala (não precisa ecoar de volta pro remetente)
    socket.to(socket.roomId).emit('photo-share', { id: socket.id, photoUrl });
  });

  // ---------- Chat ----------
  socket.on('chat-message', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p    = room.participants.get(socket.id);
    const text = sanitizeStr((data || {}).text || '', 500);
    if (!text) return;

    const msg = {
      id:        socket.id,
      name:      p ? p.name : 'Anônimo',
      photoUrl:  p ? (p.photoUrl || '') : '',
      text,
      time:      Date.now()
    };

    // Enviar para todos na sala (incluindo o remetente)
    io.to(socket.roomId).emit('chat-message', msg);
  });

  // ---------- Sinalização WebRTC ----------
  socket.on('request-peer', (data) => {
    const targetId = sanitizeStr((data || {}).targetId, 64);
    if (targetId && sameRoomAs(targetId)) {
      io.to(targetId).emit('request-peer', { fromId: socket.id });
    }
  });

  socket.on('offer', (data) => {
    const targetId = sanitizeStr((data || {}).targetId, 64);
    if (targetId && (data || {}).sdp && sameRoomAs(targetId)) {
      io.to(targetId).emit('offer', { fromId: socket.id, sdp: data.sdp });
    }
  });

  socket.on('answer', (data) => {
    const targetId = sanitizeStr((data || {}).targetId, 64);
    if (targetId && (data || {}).sdp && sameRoomAs(targetId)) {
      io.to(targetId).emit('answer', { fromId: socket.id, sdp: data.sdp });
    }
  });

  socket.on('ice-candidate', (data) => {
    const targetId = sanitizeStr((data || {}).targetId, 64);
    if (targetId && (data || {}).candidate && sameRoomAs(targetId)) {
      io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate: data.candidate });
    }
  });


  socket.on('community-register',(data,cb)=>{const user=registerUser(socket,data);if(!user){if(typeof cb==='function')cb({success:false,message:'Dados inválidos.'});return;}broadcastOnlineUsers();const myServers=[];for(const s of communityServers.values()){if(s.members.has(user.userId))myServers.push(serverPublic(s));}if(typeof cb==='function')cb({success:true,user:publicUser(user),servers:myServers,online:onlineUsersList()});});
  socket.on('community-list-servers',(cb)=>{if(typeof cb!=='function')return;cb({servers:Array.from(communityServers.values()).map(serverPublic),online:onlineUsersList()});});
  socket.on('community-search-users',(data,cb)=>{if(typeof cb!=='function')return;const q=sanitizeStr((data||{}).query,40).toLowerCase();if(!q)return cb({users:[]});cb({users:onlineUsersList().filter(u=>u.name.toLowerCase().includes(q)).slice(0,40)});});
  socket.on('community-create-server',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Registre-se primeiro.'});if(communityServers.size>=120)return cb({success:false,message:'Limite.'});if(!checkSocketRate(socket.id,'create-server',6,60000))return cb({success:false,message:'Aguarde.'});const name=sanitizeStr((data||{}).name,40);const icon=sanitizeStr((data||{}).icon,8);const iconUrl=sanitizePhoto((data||{}).iconUrl||'');if(!name)return cb({success:false,message:'Nome obrigatório.'});const id=genId('s_');let inviteCode=genInvite();while(inviteIndex.has(inviteCode))inviteCode=genInvite();const textId=genId('c_');const voiceId=genId('c_');const channels=new Map();channels.set(textId,{id:textId,name:'geral',type:'text',messages:[]});channels.set(voiceId,{id:voiceId,name:'Geral',type:'voice',messages:[]});const server={id,name,icon:icon||name.slice(0,2).toUpperCase(),iconUrl,ownerId:user.userId,inviteCode,members:new Set([user.userId]),channels};communityServers.set(id,server);inviteIndex.set(inviteCode,id);socket.join('server:'+id);cb({success:true,server:serverPublic(server)});});
  socket.on('community-update-server',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const serverId=sanitizeStr((data||{}).serverId,24);const server=communityServers.get(serverId);if(!server||server.ownerId!==user.userId)return cb({success:false,message:'Sem permissão.'});const name=sanitizeStr((data||{}).name,40);const icon=sanitizeStr((data||{}).icon,8);if(name)server.name=name;if(icon)server.icon=icon;if((data||{}).iconUrl!==undefined)server.iconUrl=sanitizePhoto((data||{}).iconUrl||'');const pub=serverPublic(server);io.emit('community-server-updated',{server:pub});cb({success:true,server:pub});});
  socket.on('community-join-server',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const serverId=sanitizeStr((data||{}).serverId,24);const server=communityServers.get(serverId);if(!server)return cb({success:false,message:'Não encontrado.'});server.members.add(user.userId);socket.join('server:'+serverId);cb({success:true,server:serverPublic(server)});});
  socket.on('community-join-invite',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const code=sanitizeStr((data||{}).code,16).toUpperCase();const serverId=inviteIndex.get(code);if(!serverId)return cb({success:false,message:'Convite inválido.'});const server=communityServers.get(serverId);if(!server)return cb({success:false,message:'Não encontrado.'});server.members.add(user.userId);socket.join('server:'+serverId);cb({success:true,server:serverPublic(server)});});
  socket.on('community-delete-server',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const serverId=sanitizeStr((data||{}).serverId,24);const server=communityServers.get(serverId);if(!server||server.ownerId!==user.userId)return cb({success:false,message:'Sem permissão.'});for(const ch of server.channels.values()){if(ch.type==='voice'){io.to('voice:'+ch.id).emit('voice-channel-closed',{channelId:ch.id});voicePeers.delete(ch.id);}}inviteIndex.delete(server.inviteCode);communityServers.delete(serverId);io.emit('community-server-deleted',{serverId});cb({success:true});});
  socket.on('community-create-channel',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const serverId=sanitizeStr((data||{}).serverId,24);let name=sanitizeStr((data||{}).name,30);let type=sanitizeStr((data||{}).type,10)||'text';if(type!=='voice')type='text';const server=communityServers.get(serverId);if(!server||server.ownerId!==user.userId)return cb({success:false,message:'Sem permissão.'});if(!name)return cb({success:false,message:'Nome inválido.'});if(type==='text')name=name.toLowerCase().replace(/\s+/g,'-');const id=genId('c_');const ch={id,name,type,messages:[]};server.channels.set(id,ch);io.emit('community-channel-created',{serverId,channel:channelPublic(ch)});cb({success:true,channel:channelPublic(ch)});});
  socket.on('community-open-channel',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const serverId=sanitizeStr((data||{}).serverId,24);const channelId=sanitizeStr((data||{}).channelId,24);const server=communityServers.get(serverId);if(!server||!server.members.has(user.userId))return cb({success:false,message:'Sem acesso.'});const ch=server.channels.get(channelId);if(!ch||ch.type!=='text')return cb({success:false,message:'Canal inválido.'});for(const other of server.channels.values()){if(other.type==='text'&&other.id!==channelId)socket.leave('channel:'+other.id);}socket.join('channel:'+channelId);cb({success:true,channel:channelPublic(ch),messages:(ch.messages||[]).slice(-100)});});
  socket.on('community-channel-message',(data,cb)=>{const user=userBySocket.get(socket.id);if(!user)return;if(!checkSocketRate(socket.id,'ch-msg',30,10000))return;const serverId=sanitizeStr((data||{}).serverId,24);const channelId=sanitizeStr((data||{}).channelId,24);const text=sanitizeStr((data||{}).text,1000);if(!text)return;const server=communityServers.get(serverId);if(!server||!server.members.has(user.userId))return;const ch=server.channels.get(channelId);if(!ch||ch.type!=='text')return;const msg={id:genId('m_'),userId:user.userId,name:user.name,photoUrl:user.photoUrl||'',text,time:Date.now()};ch.messages.push(msg);if(ch.messages.length>200)ch.messages=ch.messages.slice(-200);io.to('channel:'+channelId).emit('community-channel-message',{serverId,channelId,message:msg});if(typeof cb==='function')cb({success:true,id:msg.id});});
  socket.on('community-open-dm',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const peerId=sanitizeStr((data||{}).peerId,48);if(!peerId||peerId===user.userId)return cb({success:false,message:'Destino inválido.'});cb({success:true,peerId,messages:(dmMessages.get(dmKey(user.userId,peerId))||[]).slice(-100)});});
  socket.on('community-dm-message',(data,cb)=>{const user=userBySocket.get(socket.id);if(!user)return;if(!checkSocketRate(socket.id,'dm-msg',30,10000))return;const peerId=sanitizeStr((data||{}).peerId,48);const text=sanitizeStr((data||{}).text,1000);if(!peerId||!text||peerId===user.userId)return;const key=dmKey(user.userId,peerId);if(!dmMessages.has(key))dmMessages.set(key,[]);const list=dmMessages.get(key);const msg={id:genId('m_'),fromId:user.userId,toId:peerId,name:user.name,photoUrl:user.photoUrl||'',text,time:Date.now()};list.push(msg);if(list.length>200)dmMessages.set(key,list.slice(-200));emitToUser(user.userId,'community-dm-message',{peerId,message:msg});emitToUser(peerId,'community-dm-message',{peerId:user.userId,message:msg});if(typeof cb==='function')cb({success:true,id:msg.id});});
  socket.on('voice-join',(data,cb)=>{if(typeof cb!=='function')return;const user=userBySocket.get(socket.id);if(!user)return cb({success:false,message:'Não registrado.'});const serverId=sanitizeStr((data||{}).serverId,24);const channelId=sanitizeStr((data||{}).channelId,24);const server=communityServers.get(serverId);if(!server||!server.members.has(user.userId))return cb({success:false,message:'Sem acesso.'});const ch=server.channels.get(channelId);if(!ch||ch.type!=='voice')return cb({success:false,message:'Canal inválido.'});if(socket.voiceChannelId&&socket.voiceChannelId!==channelId)leaveAllVoice(socket);if(!voicePeers.has(channelId))voicePeers.set(channelId,new Map());const peersMap=voicePeers.get(channelId);const info={socketId:socket.id,userId:user.userId,name:user.name,photoUrl:user.photoUrl||'',muted:!!(data||{}).muted,camera:false,screen:false,speaking:false};peersMap.set(socket.id,info);socket.voiceChannelId=channelId;socket.join('voice:'+channelId);const others=[];for(const [sid,p] of peersMap){if(sid!==socket.id)others.push(p);}socket.to('voice:'+channelId).emit('voice-user-joined',{channelId,peer:info});cb({success:true,channelId,peers:others,self:info});});
  socket.on('voice-leave',()=>leaveAllVoice(socket));
  socket.on('voice-state',(data)=>{const channelId=socket.voiceChannelId;if(!channelId)return;const peersMap=voicePeers.get(channelId);if(!peersMap||!peersMap.has(socket.id))return;const p=peersMap.get(socket.id);if(typeof (data||{}).muted==='boolean')p.muted=data.muted;if(typeof (data||{}).camera==='boolean')p.camera=data.camera;if(typeof (data||{}).screen==='boolean')p.screen=data.screen;if(typeof (data||{}).speaking==='boolean')p.speaking=data.speaking;io.to('voice:'+channelId).emit('voice-state',{channelId,socketId:socket.id,muted:p.muted,camera:p.camera,screen:p.screen,speaking:p.speaking});});
  socket.on('voice-offer',(data)=>{const targetId=sanitizeStr((data||{}).targetId,40);const channelId=socket.voiceChannelId;if(!targetId||!channelId||!(data||{}).sdp)return;const peersMap=voicePeers.get(channelId);if(!peersMap||!peersMap.has(socket.id)||!peersMap.has(targetId))return;io.to(targetId).emit('voice-offer',{fromId:socket.id,sdp:data.sdp});});
  socket.on('voice-answer',(data)=>{const targetId=sanitizeStr((data||{}).targetId,40);const channelId=socket.voiceChannelId;if(!targetId||!channelId||!(data||{}).sdp)return;const peersMap=voicePeers.get(channelId);if(!peersMap||!peersMap.has(socket.id)||!peersMap.has(targetId))return;io.to(targetId).emit('voice-answer',{fromId:socket.id,sdp:data.sdp});});
  socket.on('voice-ice',(data)=>{const targetId=sanitizeStr((data||{}).targetId,40);const channelId=socket.voiceChannelId;if(!targetId||!channelId||!(data||{}).candidate)return;const peersMap=voicePeers.get(channelId);if(!peersMap||!peersMap.has(socket.id)||!peersMap.has(targetId))return;io.to(targetId).emit('voice-ice',{fromId:socket.id,candidate:data.candidate});});

  socket.on('leave-room', () => handleLeave(socket));

  socket.on('disconnect', () => {
    handleLeave(socket);
    try { unregisterSocket(socket); broadcastOnlineUsers(); } catch (_) {}
    socketEventCounts.delete(`${socket.id}:create-room`);
    socketEventCounts.delete(`${socket.id}:join-room`);
    console.log(`[-] ${socket.id}`);
  });
});

// ==================== ROTAS HTTP ====================

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    rooms: rooms.size,
    uptime: Math.floor(process.uptime())
  });
});

// Bloquear acesso a arquivos sensíveis
app.get(['/server.js', '/.env', '/package.json', '/package-lock.json'], (req, res) => {
  res.status(403).json({ error: 'Proibido' });
});

// ==================== INICIALIZAÇÃO ====================

server.listen(PORT, () => {
  console.log('');
  console.log('================================');
  console.log('     MaxCord - Servidor         ');
  console.log('================================');
  console.log(`  Porta:   ${PORT}`);
  console.log(`  Salas:   max ${MAX_ROOMS}`);
  console.log(`  Peers:   max ${MAX_PARTICIPANTS}/sala`);
  console.log('  Segurança: helmet + rate limit');
  console.log('================================');
  console.log('');
});
