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

// Origens permitidas (o próprio Render + localhost p/ dev)
const ALLOWED_ORIGINS = [
  'https://max-cord.onrender.com',
  'https://max-cord.netlify.app',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

// ==================== SOCKET.IO ====================
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // Permite sem origin (apps mobile/desktop nativos) e origens conhecidas
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Origem não permitida: ' + origin));
    },
    methods: ['GET', 'POST']
  },
  // SDP/ICE cabem com folga; fotos de perfil grandes são recusadas no cliente
  maxHttpBufferSize: 1.5e6
});

// ==================== MIDDLEWARES DE SEGURANÇA ====================

// Helmet — headers HTTP de segurança
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdn.socket.io', 'https://max-cord.onrender.com'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
      connectSrc:     ["'self'", 'https://max-cord.onrender.com', 'wss://max-cord.onrender.com',
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
  // Impede que o site seja colocado em iframe (clickjacking)
  frameguard: { action: 'deny' },
  // Esconde que usa Express
  hidePoweredBy: true,
  // HSTS — força HTTPS por 1 ano
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// CORS para rotas HTTP
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origem não permitida'));
  },
  methods: ['GET', 'POST']
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

/** Foto/GIF de perfil: permite data URL ou https (limite maior que texto). */
function sanitizePhotoUrl(val) {
  if (typeof val !== 'string') return '';
  const s = val.trim();
  if (!s) return '';
  // data:image (jpg/png/gif/webp) — até ~200KB em base64
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) {
    return s.slice(0, 220000);
  }
  // URL http(s)
  if (/^https?:\/\//i.test(s)) {
    return s.slice(0, 2000).replace(/[<>]/g, '');
  }
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
function broadcastRoomList() {
  if (_broadcastTimer) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    const list = [];
    for (const [id, room] of rooms) {
      list.push({
        id,
        name:             room.name,
        hasPassword:      room.hasPassword,
        participantCount: room.participants.size,
        ownerName:        room.ownerName
      });
    }
    io.emit('room-list-update', { rooms: list });
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

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} (${socket.handshake.address})`);

  // ---------- Listar salas ----------
  socket.on('list-rooms', (callback) => {
    if (typeof callback !== 'function') return;
    const list = [];
    for (const [id, room] of rooms) {
      list.push({
        id,
        name:             room.name,
        hasPassword:      room.hasPassword,
        participantCount: room.participants.size,
        ownerName:        room.ownerName
      });
    }
    callback({ rooms: list });
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
    const photoUrl = sanitizePhotoUrl((data || {}).photoUrl || '');

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

    callback({ success: true, roomId, isOwner: true });
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
    const photoUrl = sanitizePhotoUrl((data || {}).photoUrl || '');

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

    socket.to(roomId).emit('user-joined', { id: socket.id, name: userName, isOwner: joiningAsOwner, photoUrl });

    callback({ success: true, roomId, roomName: room.name, isOwner: joiningAsOwner, participants });
    broadcastRoomList();
    console.log(`[Sala] ${userName} entrou em ${roomId}`);
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
    const room = rooms.get(socket.roomId);
    return !!(room && room.participants.has(socket.id) && room.participants.has(targetId));
  }

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
    const targetId = sanitizeStr((data || {}).targetId, 30);
    if (targetId && sameRoomAs(targetId)) {
      io.to(targetId).emit('request-peer', { fromId: socket.id });
    }
  });

  socket.on('offer', (data) => {
    const targetId = sanitizeStr((data || {}).targetId, 30);
    if (targetId && (data || {}).sdp && sameRoomAs(targetId)) {
      io.to(targetId).emit('offer', { fromId: socket.id, sdp: data.sdp });
    }
  });

  socket.on('answer', (data) => {
    const targetId = sanitizeStr((data || {}).targetId, 30);
    if (targetId && (data || {}).sdp && sameRoomAs(targetId)) {
      io.to(targetId).emit('answer', { fromId: socket.id, sdp: data.sdp });
    }
  });

  socket.on('ice-candidate', (data) => {
    const targetId = sanitizeStr((data || {}).targetId, 30);
    if (targetId && (data || {}).candidate && sameRoomAs(targetId)) {
      io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate: data.candidate });
    }
  });

  socket.on('leave-room', () => handleLeave(socket));

  socket.on('disconnect', () => {
    handleLeave(socket);
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
