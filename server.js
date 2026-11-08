const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');
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

// Origens permitidas — libera o próprio domínio + variantes comuns de deploy
const ALLOWED_ORIGINS = [
  'https://max-cord.onrender.com',
  'https://max-cord.netlify.app',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // apps nativos / same-origin sem header
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    const h = (u.hostname || '').toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (h.endsWith('.onrender.com')) return true;
    if (h.endsWith('.netlify.app')) return true;
    if (h.endsWith('.netlify.com')) return true;
  } catch (_) {}
  return false;
}

// ==================== SOCKET.IO ====================
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      console.warn('[CORS] Origem bloqueada no Socket.IO:', origin);
      cb(new Error('Origem não permitida: ' + origin));
    },
    methods: ['GET', 'POST']
  },
  // SDP/ICE cabem com folga; fotos de perfil grandes são recusadas no cliente
  maxHttpBufferSize: 2.5e6
});

// ==================== MIDDLEWARES DE SEGURANÇA ====================

// Helmet — headers HTTP de segurança
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      baseUri:        ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdn.socket.io'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
      connectSrc:     ["'self'", 'https://max-cord.onrender.com', 'wss://max-cord.onrender.com',
                       'https://*.onrender.com', 'wss://*.onrender.com',
                       'https://*.netlify.app', 'wss://*.netlify.app',
                       'https://cdn.socket.io', 'wss://cdn.socket.io',
                       'https://stun.l.google.com', 'https://stun1.l.google.com',
                       'https://stun2.l.google.com', 'https://stun3.l.google.com',
                       'https://stun.cloudflare.com'],
      mediaSrc:       ["'self'", 'blob:', 'mediastream:'],
      imgSrc:         ["'self'", 'data:', 'blob:', 'https:'],
      workerSrc:      ["'self'", 'blob:'],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      formAction:     ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  // Impede que o site seja colocado em iframe (clickjacking)
  frameguard: { action: 'deny' },
  // Esconde que usa Express
  hidePoweredBy: true,
  // HSTS — força HTTPS por 1 ano
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// Permissions-Policy: só câmera/mic/tela no próprio origin
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()'
  );
  next();
});

// CORS para rotas HTTP
app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
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
  // data:image (jpg/png/gif/webp) — até ~900KB em base64
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) {
    return s.slice(0, 1200000);
  }
  // URL http(s) — Tenor/Giphy podem ser longas
  if (/^https?:\/\//i.test(s)) {
    return s.slice(0, 4000).replace(/[<>"']/g, '');
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

/** Nome de exibição reservado do administrador do site (ID fixo 01). */
const ADMIN_DISPLAY_NAME = 'exibidoofc';
const ADMIN_USER_ID = '01';

/** Nomes online no momento (lowercase → socketId). */
const activeNames = new Map();

/** socketId → accountId (vínculo da sessão atual). */
const socketToAccount = new Map();

/** Contas persistentes (accountId → registro). Online e offline. */
const accountRegistry = new Map();
const ACCOUNTS_FILE = path.join(__dirname, 'data', 'accounts.json');
let accountSeq = 100;
let saveAccountsTimer = null;

/** Avisos flutuantes ativos no site (id → { id, text, from, at }). */
const siteAnnouncements = new Map();
const ANNOUNCEMENTS_FILE = path.join(__dirname, 'data', 'announcements.json');
let announcementSeq = 1;
let saveAnnouncementsTimer = null;

function isAdminName(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === ADMIN_DISPLAY_NAME;
}

function loadAnnouncementsFromDisk() {
  try {
    if (!fs.existsSync(ANNOUNCEMENTS_FILE)) return;
    const raw = fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.announcements)) return;
    for (const ann of data.announcements) {
      if (!ann || !ann.id || !ann.text) continue;
      siteAnnouncements.set(String(ann.id), {
        id: String(ann.id),
        text: String(ann.text).slice(0, 20000),
        from: String(ann.from || ADMIN_DISPLAY_NAME).slice(0, 40),
        at: ann.at || Date.now()
      });
      const num = parseInt(String(ann.id).replace(/\D/g, ''), 10);
      if (!isNaN(num) && num >= announcementSeq) announcementSeq = num + 1;
    }
    console.log(`[Avisos] ${siteAnnouncements.size} aviso(s) carregado(s) do disco`);
  } catch (err) {
    console.warn('[Avisos] Falha ao carregar announcements.json:', err.message);
  }
}

function saveAnnouncementsToDisk() {
  try {
    const dir = path.dirname(ANNOUNCEMENTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const list = Array.from(siteAnnouncements.values());
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify({ announcements: list }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Avisos] Falha ao salvar announcements.json:', err.message);
  }
}

function scheduleSaveAnnouncements() {
  if (saveAnnouncementsTimer) return;
  saveAnnouncementsTimer = setTimeout(() => {
    saveAnnouncementsTimer = null;
    saveAnnouncementsToDisk();
  }, 300);
}

function loadAccountsFromDisk() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.accounts)) return;
    for (const acc of data.accounts) {
      if (!acc || !acc.id || !acc.name) continue;
      accountRegistry.set(acc.id, {
        id: String(acc.id),
        name: String(acc.name).slice(0, 20),
        nameKey: String(acc.name).trim().toLowerCase(),
        photoUrl: typeof acc.photoUrl === 'string' ? acc.photoUrl.slice(0, 4000) : '',
        isAdmin: !!acc.isAdmin || isAdminName(acc.name),
        createdAt: acc.createdAt || Date.now(),
        lastSeen: acc.lastSeen || acc.createdAt || Date.now()
      });
      const num = parseInt(String(acc.id).replace(/\D/g, ''), 10);
      if (!isNaN(num) && num >= accountSeq) accountSeq = num + 1;
    }
    console.log(`[Contas] ${accountRegistry.size} conta(s) carregada(s) do disco`);
  } catch (err) {
    console.warn('[Contas] Falha ao carregar accounts.json:', err.message);
  }
}

function saveAccountsToDisk() {
  try {
    const dir = path.dirname(ACCOUNTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const list = [];
    for (const acc of accountRegistry.values()) {
      list.push({
        id: acc.id,
        name: acc.name,
        photoUrl: acc.photoUrl || '',
        isAdmin: !!acc.isAdmin,
        createdAt: acc.createdAt,
        lastSeen: acc.lastSeen
      });
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Contas] Falha ao salvar accounts.json:', err.message);
  }
}

function scheduleSaveAccounts() {
  if (saveAccountsTimer) return;
  saveAccountsTimer = setTimeout(() => {
    saveAccountsTimer = null;
    saveAccountsToDisk();
  }, 400);
}

function findAccountByNameKey(nameKey) {
  for (const acc of accountRegistry.values()) {
    if (acc.nameKey === nameKey) return acc;
  }
  return null;
}

function findAccountBySocket(socketId) {
  const id = socketToAccount.get(socketId);
  return id ? accountRegistry.get(id) : null;
}

function nextAccountId(admin) {
  if (admin) return ADMIN_USER_ID;
  const id = 'u' + accountSeq;
  accountSeq += 1;
  return id;
}

function registerActiveName(socketId, userName, extra) {
  const key = (userName || '').trim().toLowerCase();
  if (!key) return null;
  // Remove nome anterior deste socket
  for (const [k, sid] of activeNames) {
    if (sid === socketId) activeNames.delete(k);
  }
  activeNames.set(key, socketId);

  const admin = isAdminName(userName);
  let acc = findAccountByNameKey(key);
  // Se este socket já tinha outra conta e mudou de nome, só atualiza a existente se for a mesma
  const prevAcc = findAccountBySocket(socketId);

  if (!acc) {
    // Novo perfil: cria conta persistente
    const id = (prevAcc && !admin && prevAcc.id !== ADMIN_USER_ID && !findAccountByNameKey(key))
      ? prevAcc.id
      : nextAccountId(admin);
    // Se reutiliza id antigo, remove registro anterior com outro nome
    if (prevAcc && prevAcc.id === id && prevAcc.nameKey !== key) {
      accountRegistry.delete(prevAcc.id);
    }
    acc = {
      id: admin ? ADMIN_USER_ID : id,
      name: userName,
      nameKey: key,
      photoUrl: (extra && extra.photoUrl) || '',
      isAdmin: admin,
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    // Garante admin único com id 01
    if (admin) {
      for (const [aid, a] of accountRegistry) {
        if (a.isAdmin && aid !== ADMIN_USER_ID) accountRegistry.delete(aid);
      }
      acc.id = ADMIN_USER_ID;
    }
    accountRegistry.set(acc.id, acc);
  } else {
    acc.name = userName;
    acc.nameKey = key;
    acc.isAdmin = admin;
    acc.lastSeen = Date.now();
    if (extra && extra.photoUrl) acc.photoUrl = extra.photoUrl;
    if (admin) acc.id = ADMIN_USER_ID;
    accountRegistry.set(acc.id, acc);
  }

  socketToAccount.set(socketId, acc.id);
  scheduleSaveAccounts();
  return acc;
}

function releaseActiveName(socketId) {
  for (const [k, sid] of activeNames) {
    if (sid === socketId) activeNames.delete(k);
  }
  const acc = findAccountBySocket(socketId);
  if (acc) {
    acc.lastSeen = Date.now();
    scheduleSaveAccounts();
  }
  socketToAccount.delete(socketId);
}

function isNameTaken(userName, exceptSocketId) {
  const key = (userName || '').trim().toLowerCase();
  if (!key) return false;
  // Só bloqueia se outro socket ONLINE já estiver com esse nome.
  // Conta offline com o mesmo nome pode ser retomada (atualiza o registro).
  const ownerSid = activeNames.get(key);
  return !!(ownerSid && ownerSid !== exceptSocketId);
}

function listAccountsSnapshot(searchQuery) {
  const q = (searchQuery || '').trim().toLowerCase();
  const list = [];
  const seenIds = new Set();

  for (const acc of accountRegistry.values()) {
    if (q && !String(acc.name || '').toLowerCase().includes(q) && !String(acc.id || '').toLowerCase().includes(q)) {
      continue;
    }
    const onlineSid = activeNames.get(acc.nameKey) || null;
    const sock = onlineSid ? io.sockets.sockets.get(onlineSid) : null;
    seenIds.add(acc.id);
    list.push({
      accountId: acc.id,
      socketId: onlineSid,
      name: acc.name,
      userId: acc.id,
      isAdmin: !!acc.isAdmin,
      photoUrl: acc.photoUrl || '',
      createdAt: acc.createdAt || null,
      lastSeen: acc.lastSeen || null,
      claimedAt: acc.createdAt || null,
      roomId: (sock && sock.roomId) || null,
      online: !!sock
    });
  }

  // Segurança extra: inclui sockets online com nome que ainda não entraram no registry
  for (const [sid, sock] of io.sockets.sockets) {
    if (!sock || !sock.userName) continue;
    const key = String(sock.userName).trim().toLowerCase();
    if (!key) continue;
    let acc = findAccountByNameKey(key) || findAccountBySocket(sid);
    if (!acc) {
      // Registra na hora para o painel e persistência
      acc = registerActiveName(sid, sock.userName, { photoUrl: sock.photoUrl || '' });
    }
    if (!acc || seenIds.has(acc.id)) continue;
    if (q && !String(acc.name || '').toLowerCase().includes(q) && !String(acc.id || '').toLowerCase().includes(q)) {
      continue;
    }
    seenIds.add(acc.id);
    list.push({
      accountId: acc.id,
      socketId: sid,
      name: acc.name,
      userId: acc.id,
      isAdmin: !!acc.isAdmin || !!sock.isAdmin,
      photoUrl: acc.photoUrl || '',
      createdAt: acc.createdAt || null,
      lastSeen: acc.lastSeen || Date.now(),
      claimedAt: acc.createdAt || null,
      roomId: sock.roomId || null,
      online: true
    });
  }

  list.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });
  return list;
}

function requireAdmin(socket) {
  if (!socket) return false;
  if (socket.isAdmin || isAdminName(socket.userName)) {
    socket.isAdmin = true;
    return true;
  }
  // Fallback: conta persistente vinculada a este socket é admin (ID 01)
  const acc = findAccountBySocket(socket.id);
  if (acc && (acc.isAdmin || acc.id === ADMIN_USER_ID || isAdminName(acc.name))) {
    socket.isAdmin = true;
    if (!socket.userName) socket.userName = acc.name || ADMIN_DISPLAY_NAME;
    return true;
  }
  // Fallback: este socket está no activeNames como exibidoofc
  for (const [nameKey, sid] of activeNames) {
    if (sid === socket.id && nameKey === ADMIN_DISPLAY_NAME) {
      socket.isAdmin = true;
      socket.userName = ADMIN_DISPLAY_NAME;
      return true;
    }
  }
  return false;
}

// Carrega contas e avisos salvos ao subir o servidor
loadAccountsFromDisk();
loadAnnouncementsFromDisk();

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

  // Empurra avisos ativos assim que o cliente conecta (não depende só do pedido do browser)
  if (siteAnnouncements.size > 0) {
    socket.emit('site-announcements-sync', {
      announcements: Array.from(siteAnnouncements.values())
    });
  }

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
    const termsAccepted = !!(data || {}).termsAccepted;

    if (!userName)           return callback({ success: false, message: 'Nome inválido.' });
    if (!isValidRoomId(roomId)) return callback({ success: false, message: 'ID de sala inválido.' });
    if (rooms.has(roomId))   return callback({ success: false, message: 'Já existe uma sala com este ID.' });
    if (isNameTaken(userName, socket.id)) {
      return callback({ success: false, message: 'Este nome de perfil já está em uso. Escolha outro.' });
    }

    const admin = isAdminName(userName);
    socket.userName = userName;
    socket.isAdmin = admin;
    socket.photoUrl = photoUrl;
    const acc = registerActiveName(socket.id, userName, { photoUrl });
    const displayUserId = (acc && acc.id) || (admin ? ADMIN_USER_ID : null);

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
      photoUrl: photoUrl,
      termsAccepted: termsAccepted,
      isAdmin: admin,
      userId: displayUserId
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;

    callback({
      success: true,
      roomId,
      isOwner: true,
      isAdmin: admin,
      userId: displayUserId
    });
    broadcastRoomList();
    console.log(`[Sala] ${roomId} criada por ${userName}${admin ? ' [ADMIN]' : ''}`);
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
    const termsAccepted = !!(data || {}).termsAccepted;

    if (!userName) return callback({ success: false, message: 'Nome inválido.' });
    if (isNameTaken(userName, socket.id)) {
      return callback({ success: false, message: 'Este nome de perfil já está em uso. Escolha outro.' });
    }

    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, message: 'Sala não encontrada.' });

    if (socket.roomId && socket.roomId !== roomId) handleLeave(socket);

    if (room.participants.size >= MAX_PARTICIPANTS && !room.participants.has(socket.id)) {
      return callback({ success: false, message: 'Sala cheia.' });
    }

    const admin = isAdminName(userName);

    // Admin (exibidoofc) entra em qualquer sala mesmo com senha
    if (room.hasPassword && !admin && !bcrypt.compareSync(password, room.password)) {
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

    socket.userName = userName;
    socket.isAdmin = admin;
    socket.photoUrl = photoUrl;
    const acc = registerActiveName(socket.id, userName, { photoUrl });
    const displayUserId = (acc && acc.id) || (admin ? ADMIN_USER_ID : null);

    room.participants.set(socket.id, {
      name: userName, isOwner: joiningAsOwner,
      isBroadcasting: false, broadcastType: null,
      hasMic: false, micMuted: true,
      photoUrl: photoUrl,
      termsAccepted: termsAccepted,
      isAdmin: admin,
      userId: displayUserId
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
        photoUrl:       p.photoUrl || '',
        termsAccepted:  !!p.termsAccepted,
        isAdmin:        !!p.isAdmin,
        userId:         p.userId || null
      });
    }

    socket.to(roomId).emit('user-joined', {
      id: socket.id, name: userName, isOwner: joiningAsOwner, photoUrl, termsAccepted,
      isAdmin: admin, userId: displayUserId
    });

    callback({
      success: true,
      roomId,
      roomName: room.name,
      isOwner: joiningAsOwner,
      participants,
      isAdmin: admin,
      userId: displayUserId
    });
    broadcastRoomList();
    console.log(`[Sala] ${userName} entrou em ${roomId}${admin ? ' [ADMIN]' : ''}`);
  });

  // ---------- Deletar sala ----------
  // Dono da sala OU admin (exibidoofc) podem deletar.
  // Admin pode informar roomId alvo mesmo sem estar dentro da sala.
  socket.on('delete-room', (data, callback) => {
    // Compat: clients antigos chamam só com callback
    if (typeof data === 'function') { callback = data; data = {}; }
    const targetRoomId = sanitizeStr((data || {}).roomId, 12).toUpperCase() || socket.roomId;
    if (!targetRoomId) return callback && callback({ success: false, message: 'Sala não informada.' });

    const room = rooms.get(targetRoomId);
    if (!room) return callback && callback({ success: false, message: 'Sala não encontrada.' });

    const isOwner = room.ownerId === socket.id;
    const admin = !!socket.isAdmin || isAdminName(socket.userName);
    if (!isOwner && !admin) {
      return callback && callback({ success: false, message: 'Sem permissão.' });
    }

    const msg = admin && !isOwner
      ? 'A sala foi removida pela administração.'
      : 'A sala foi deletada pelo dono.';
    io.to(targetRoomId).emit('room-deleted', { message: msg });
    for (const [id] of room.participants) {
      const s = io.sockets.sockets.get(id);
      if (s) { s.leave(targetRoomId); s.roomId = null; }
    }
    rooms.delete(targetRoomId);
    if (socket.roomId === targetRoomId) socket.roomId = null;
    callback && callback({ success: true });
    broadcastRoomList();
    console.log(`[Sala] ${targetRoomId} deletada por ${socket.userName || socket.id}${admin ? ' [ADMIN]' : ''}`);
  });

  // ---------- Kick / desconectar usuário (somente admin) ----------
  socket.on('admin-kick', (data, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    if (!socket.isAdmin && !isAdminName(socket.userName)) {
      return callback({ success: false, message: 'Sem permissão de administrador.' });
    }
    const targetId = sanitizeStr((data || {}).targetId, 40);
    const targetRoomId = sanitizeStr((data || {}).roomId, 12).toUpperCase() || socket.roomId;
    if (!targetId) return callback({ success: false, message: 'Alvo inválido.' });

    // Procura o alvo em qualquer sala se roomId não informado
    let room = targetRoomId ? rooms.get(targetRoomId) : null;
    if (!room) {
      for (const r of rooms.values()) {
        if (r.participants.has(targetId)) { room = r; break; }
      }
    }
    if (!room || !room.participants.has(targetId)) {
      return callback({ success: false, message: 'Usuário não encontrado em nenhuma sala.' });
    }

    const targetSocket = io.sockets.sockets.get(targetId);
    const targetName = (room.participants.get(targetId) || {}).name || 'Usuário';
    room.participants.delete(targetId);
    if (targetSocket) {
      targetSocket.leave(room.id);
      targetSocket.roomId = null;
      targetSocket.emit('kicked', {
        message: 'Você foi desconectado da sala pela administração.',
        by: socket.userName || ADMIN_DISPLAY_NAME
      });
    }
    io.to(room.id).emit('user-left', { id: targetId, name: targetName, kicked: true });
    if (room.participants.size === 0) room.emptyAt = Date.now();
    callback({ success: true });
    broadcastRoomList();
    console.log(`[Admin] ${socket.userName} kickou ${targetName} (${targetId}) da sala ${room.id}`);
  });

  // ---------- Avisos flutuantes do site (somente admin) ----------
  socket.on('admin-announce', (data, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    // Garante sessão admin (mesmo padrão do painel de contas)
    const claimName = sanitizeStr((data || {}).userName || '', 20);
    if (claimName && isAdminName(claimName)) {
      const prevSid = activeNames.get(ADMIN_DISPLAY_NAME);
      if (prevSid && prevSid !== socket.id) {
        activeNames.delete(ADMIN_DISPLAY_NAME);
        const prevSock = io.sockets.sockets.get(prevSid);
        if (prevSock) {
          prevSock.isAdmin = false;
          if (isAdminName(prevSock.userName)) prevSock.userName = '';
        }
      }
      socket.userName = claimName;
      socket.isAdmin = true;
      registerActiveName(socket.id, claimName, {});
    }
    if (!requireAdmin(socket)) {
      return callback({ success: false, message: 'Sem permissão de administrador.' });
    }
    // Sem limite prático de letras (só proteção básica contra abuso extremo)
    let text = typeof (data || {}).text === 'string' ? (data || {}).text : '';
    text = text.replace(/[<>]/g, '').trim();
    if (text.length > 20000) text = text.slice(0, 20000);
    if (!text) return callback({ success: false, message: 'Texto do aviso vazio.' });

    const id = 'ann-' + (announcementSeq++);
    const ann = {
      id,
      text,
      from: socket.userName || ADMIN_DISPLAY_NAME,
      at: Date.now()
    };
    siteAnnouncements.set(id, ann);
    // Limita quantos avisos ficam guardados
    if (siteAnnouncements.size > 20) {
      const oldest = siteAnnouncements.keys().next().value;
      siteAnnouncements.delete(oldest);
    }
    scheduleSaveAnnouncements();
    // Envia para TODOS os clientes conectados (qualquer página/computador)
    io.emit('site-announcement', ann);
    callback({ success: true, announcement: ann });
    console.log(`[Admin] Aviso publicado por ${ann.from} → ${io.engine.clientsCount} cliente(s): ${text.slice(0, 60)}`);
  });

  socket.on('admin-clear-announcement', (data, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    if (!requireAdmin(socket)) {
      return callback({ success: false, message: 'Sem permissão de administrador.' });
    }
    const id = sanitizeStr((data || {}).id, 40);
    if (id) siteAnnouncements.delete(id);
    else siteAnnouncements.clear();
    scheduleSaveAnnouncements();
    io.emit('site-announcement-cleared', { id: id || null });
    callback({ success: true });
  });

  // Cliente pede avisos ativos ao conectar / abrir o site
  socket.on('get-announcements', (callback) => {
    if (typeof callback !== 'function') return;
    callback({ announcements: Array.from(siteAnnouncements.values()) });
  });

  // Checagem de nome único (ao salvar perfil, antes de entrar em sala)
  socket.on('check-name', (data, callback) => {
    if (typeof callback !== 'function') return;
    const userName = sanitizeStr((data || {}).userName, 20);
    if (!userName) return callback({ available: false, message: 'Nome inválido.' });
    if (isNameTaken(userName, socket.id)) {
      return callback({ available: false, message: 'Este nome de perfil já está em uso.' });
    }
    callback({
      available: true,
      isAdmin: isAdminName(userName),
      userId: isAdminName(userName) ? ADMIN_USER_ID : null
    });
  });

  // Registrar nome ao conectar / atualizar perfil (sem entrar em sala)
  socket.on('claim-name', (data, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    const userName = sanitizeStr((data || {}).userName, 20);
    if (!userName) return callback({ success: false, message: 'Nome inválido.' });
    if (isNameTaken(userName, socket.id)) {
      return callback({ success: false, message: 'Este nome de perfil já está em uso. Escolha outro.' });
    }
    const admin = isAdminName(userName);
    const photoUrl = sanitizePhotoUrl((data || {}).photoUrl || '');
    socket.userName = userName;
    socket.isAdmin = admin;
    const acc = registerActiveName(socket.id, userName, { photoUrl });
    callback({
      success: true,
      isAdmin: admin,
      userId: acc ? acc.id : (admin ? ADMIN_USER_ID : null)
    });
  });

  // ========== Painel admin: todas as contas (online + offline) ==========
  socket.on('admin-list-accounts', (data, callback) => {
    // Compat: pode vir só callback
    if (typeof data === 'function') { callback = data; data = {}; }
    if (typeof callback !== 'function') return;

    // Se o cliente envia o nome admin, registra a sessão antes de checar permissão
    const claimName = sanitizeStr((data || {}).userName || '', 20);
    if (claimName && isAdminName(claimName)) {
      // Admin: a sessão atual assume o nome (libera de outro socket, se houver)
      const prevSid = activeNames.get(ADMIN_DISPLAY_NAME);
      if (prevSid && prevSid !== socket.id) {
        activeNames.delete(ADMIN_DISPLAY_NAME);
        const prevSock = io.sockets.sockets.get(prevSid);
        if (prevSock) {
          prevSock.isAdmin = false;
          if (isAdminName(prevSock.userName)) prevSock.userName = '';
        }
        if (socketToAccount.get(prevSid)) {
          // mantém conta no registro; só troca o socket ativo
        }
      }
      socket.userName = claimName;
      socket.isAdmin = true;
      registerActiveName(socket.id, claimName, {
        photoUrl: sanitizePhotoUrl((data || {}).photoUrl || '')
      });
    }

    if (!requireAdmin(socket)) {
      return callback({ success: false, message: 'Sem permissão de administrador.' });
    }
    const search = sanitizeStr((data || {}).search || '', 40);
    callback({ success: true, accounts: listAccountsSnapshot(search) });
  });

  // Admin renomeia conta (online ou offline) por accountId ou socketId
  socket.on('admin-rename-account', (data, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    const claimName = sanitizeStr((data || {}).userName || '', 20);
    if (claimName && isAdminName(claimName)) {
      const prevSid = activeNames.get(ADMIN_DISPLAY_NAME);
      if (prevSid && prevSid !== socket.id) {
        activeNames.delete(ADMIN_DISPLAY_NAME);
        const prevSock = io.sockets.sockets.get(prevSid);
        if (prevSock) {
          prevSock.isAdmin = false;
          if (isAdminName(prevSock.userName)) prevSock.userName = '';
        }
      }
      socket.userName = claimName;
      socket.isAdmin = true;
      registerActiveName(socket.id, claimName, {});
    }
    if (!requireAdmin(socket)) {
      return callback({ success: false, message: 'Sem permissão de administrador.' });
    }
    const accountId = sanitizeStr((data || {}).accountId, 40);
    const targetSocketId = sanitizeStr((data || {}).targetId, 40);
    const newName = sanitizeStr((data || {}).newName, 20);
    const search = sanitizeStr((data || {}).search || '', 40);
    if (!newName) return callback({ success: false, message: 'Nome inválido.' });
    if (isAdminName(newName)) {
      return callback({ success: false, message: 'O nome de administrador é reservado.' });
    }

    let acc = accountId ? accountRegistry.get(accountId) : null;
    if (!acc && targetSocketId) acc = findAccountBySocket(targetSocketId);
    if (!acc) return callback({ success: false, message: 'Conta não encontrada.' });
    if (acc.isAdmin || acc.id === ADMIN_USER_ID) {
      return callback({ success: false, message: 'Não é possível renomear a conta admin.' });
    }

    const newKey = newName.trim().toLowerCase();
    const conflict = findAccountByNameKey(newKey);
    if (conflict && conflict.id !== acc.id) {
      return callback({ success: false, message: 'Este nome já está em uso.' });
    }

    const oldName = acc.name;
    const oldKey = acc.nameKey;
    acc.name = newName;
    acc.nameKey = newKey;
    acc.lastSeen = Date.now();
    accountRegistry.set(acc.id, acc);
    scheduleSaveAccounts();

    // Se estiver online, atualiza sessão e sala
    const onlineSid = activeNames.get(oldKey) || activeNames.get(newKey) || null;
    // Reindexa activeNames
    if (activeNames.get(oldKey)) {
      const sid = activeNames.get(oldKey);
      activeNames.delete(oldKey);
      activeNames.set(newKey, sid);
    }
    const targetSocket = onlineSid ? io.sockets.sockets.get(onlineSid) : null;
    if (targetSocket) {
      targetSocket.userName = newName;
      targetSocket.isAdmin = false;
      const roomId = targetSocket.roomId;
      if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const p = room.participants.get(onlineSid);
        if (p) {
          p.name = newName;
          p.isAdmin = false;
          p.userId = acc.id;
        }
        if (room.ownerId === onlineSid) room.ownerName = newName;
        io.to(roomId).emit('user-renamed', {
          id: onlineSid,
          oldName,
          name: newName,
          isAdmin: false,
          userId: acc.id
        });
        broadcastRoomList();
      }
      targetSocket.emit('force-rename', {
        name: newName,
        by: socket.userName || ADMIN_DISPLAY_NAME,
        message: 'Seu nome de perfil foi alterado pela administração.'
      });
    }

    callback({ success: true, accounts: listAccountsSnapshot(search) });
    console.log(`[Admin] ${socket.userName} renomeou ${oldName} → ${newName} (acc ${acc.id})`);
  });

  // Admin apaga conta (online ou offline): remove do registro, desconecta se online
  socket.on('admin-delete-account', (data, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    const claimNameDel = sanitizeStr((data || {}).userName || '', 20);
    if (claimNameDel && isAdminName(claimNameDel)) {
      const prevSidDel = activeNames.get(ADMIN_DISPLAY_NAME);
      if (prevSidDel && prevSidDel !== socket.id) {
        activeNames.delete(ADMIN_DISPLAY_NAME);
        const prevSockDel = io.sockets.sockets.get(prevSidDel);
        if (prevSockDel) {
          prevSockDel.isAdmin = false;
          if (isAdminName(prevSockDel.userName)) prevSockDel.userName = '';
        }
      }
      socket.userName = claimNameDel;
      socket.isAdmin = true;
      registerActiveName(socket.id, claimNameDel, {});
    }
    if (!requireAdmin(socket)) {
      return callback({ success: false, message: 'Sem permissão de administrador.' });
    }
    const accountId = sanitizeStr((data || {}).accountId, 40);
    const targetSocketId = sanitizeStr((data || {}).targetId, 40);
    const search = sanitizeStr((data || {}).search || '', 40);

    let acc = accountId ? accountRegistry.get(accountId) : null;
    if (!acc && targetSocketId) acc = findAccountBySocket(targetSocketId);
    if (!acc) return callback({ success: false, message: 'Conta não encontrada.' });

    if (acc.isAdmin || acc.id === ADMIN_USER_ID) {
      return callback({ success: false, message: 'Não é possível apagar a conta admin.' });
    }

    const myAcc = findAccountBySocket(socket.id);
    if (myAcc && myAcc.id === acc.id) {
      return callback({ success: false, message: 'Você não pode apagar a própria conta por aqui.' });
    }

    const targetName = acc.name;
    const onlineSid = activeNames.get(acc.nameKey) || null;
    const targetSocket = onlineSid ? io.sockets.sockets.get(onlineSid) : null;

    if (targetSocket) {
      if (targetSocket.roomId) {
        const room = rooms.get(targetSocket.roomId);
        if (room) {
          room.participants.delete(onlineSid);
          targetSocket.leave(targetSocket.roomId);
          io.to(targetSocket.roomId).emit('user-left', {
            id: onlineSid,
            name: targetName,
            kicked: true
          });
          if (room.participants.size === 0) room.emptyAt = Date.now();
          targetSocket.roomId = null;
        }
      }
      targetSocket.emit('account-deleted', {
        message: 'Sua conta foi removida pela administração. Você precisará criar um novo perfil.',
        by: socket.userName || ADMIN_DISPLAY_NAME
      });
      releaseActiveName(onlineSid);
      setTimeout(() => {
        try { targetSocket.disconnect(true); } catch (_) {}
      }, 300);
    } else {
      // Offline: só limpa índice de nome se houver
      if (activeNames.get(acc.nameKey)) activeNames.delete(acc.nameKey);
    }

    accountRegistry.delete(acc.id);
    scheduleSaveAccounts();
    broadcastRoomList();
    callback({ success: true, accounts: listAccountsSnapshot(search) });
    console.log(`[Admin] ${socket.userName} apagou conta de ${targetName} (acc ${acc.id})`);
  });

  // Admin zera TODAS as contas (exceto a conta admin atual) e limpa o disco
  socket.on('admin-reset-accounts', (data, callback) => {
    if (typeof data === 'function') { callback = data; data = {}; }
    if (typeof callback !== 'function') callback = () => {};
    const claimName = sanitizeStr((data || {}).userName || '', 20);
    if (claimName && isAdminName(claimName)) {
      const prevSid = activeNames.get(ADMIN_DISPLAY_NAME);
      if (prevSid && prevSid !== socket.id) {
        activeNames.delete(ADMIN_DISPLAY_NAME);
        const prevSock = io.sockets.sockets.get(prevSid);
        if (prevSock) {
          prevSock.isAdmin = false;
          if (isAdminName(prevSock.userName)) prevSock.userName = '';
        }
      }
      socket.userName = claimName;
      socket.isAdmin = true;
      registerActiveName(socket.id, claimName, {
        photoUrl: sanitizePhotoUrl((data || {}).photoUrl || '')
      });
    }
    if (!requireAdmin(socket)) {
      return callback({ success: false, message: 'Sem permissão de administrador.' });
    }

    const toKick = [];
    for (const [sid, sock] of io.sockets.sockets) {
      if (!sock || sid === socket.id) continue;
      if (sock.isAdmin || isAdminName(sock.userName)) continue;
      toKick.push(sid);
    }
    for (const sid of toKick) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      const nm = sock.userName || '';
      if (sock.roomId) {
        const room = rooms.get(sock.roomId);
        if (room) {
          room.participants.delete(sid);
          try { sock.leave(sock.roomId); } catch (_) {}
          io.to(sock.roomId).emit('user-left', { id: sid, name: nm, kicked: true });
          if (room.participants.size === 0) room.emptyAt = Date.now();
          sock.roomId = null;
        }
      }
      try {
        sock.emit('account-deleted', {
          message: 'Todas as contas foram resetadas pela administração. Crie um novo perfil.',
          by: socket.userName || ADMIN_DISPLAY_NAME
        });
      } catch (_) {}
      releaseActiveName(sid);
      setTimeout(() => {
        try { sock.disconnect(true); } catch (_) {}
      }, 200);
    }

    // Limpa registry inteiro e recria só o admin atual
    accountRegistry.clear();
    for (const [k] of activeNames) {
      if (k !== ADMIN_DISPLAY_NAME) activeNames.delete(k);
    }
    accountSeq = 100;
    const adminAcc = {
      id: ADMIN_USER_ID,
      name: socket.userName || ADMIN_DISPLAY_NAME,
      nameKey: ADMIN_DISPLAY_NAME,
      photoUrl: sanitizePhotoUrl((data || {}).photoUrl || socket.photoUrl || ''),
      isAdmin: true,
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    accountRegistry.set(ADMIN_USER_ID, adminAcc);
    socketToAccount.clear();
    socketToAccount.set(socket.id, ADMIN_USER_ID);
    activeNames.set(ADMIN_DISPLAY_NAME, socket.id);
    scheduleSaveAccounts();

    // Opcional: limpa avisos antigos no reset geral
    if ((data || {}).clearAnnouncements !== false) {
      siteAnnouncements.clear();
      scheduleSaveAnnouncements();
      io.emit('site-announcement-cleared', { id: null });
    }

    broadcastRoomList();
    callback({ success: true, accounts: listAccountsSnapshot('') });
    console.log(`[Admin] ${socket.userName} resetou TODAS as contas. Registry limpo.`);
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
    releaseActiveName(socket.id);
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
