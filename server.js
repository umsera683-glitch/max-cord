const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;

// ==================== GESTÃO DE SALAS ====================
// Salas são persistentes: não são deletadas quando o criador sai.
// Só são deletadas via evento 'delete-room' pelo dono ou se ficar
// 30 minutos sem nenhum participante (limpeza automática).

const rooms = new Map();
const EMPTY_ROOM_TTL = 30 * 60 * 1000; // 30 min

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Limpeza de salas vazias há mais de 30 minutos
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.participants.size === 0 && (now - room.emptyAt) > EMPTY_ROOM_TTL) {
      rooms.delete(id);
      console.log(`[Sala] ${id} expirou (vazia por 30min)`);
    }
  }
}, 5 * 60 * 1000);

// ==================== LÓGICA DE DESCONEXÃO ====================

function handleLeave(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) { socket.roomId = null; return; }

  const participant = room.participants.get(socket.id);
  const wasBroadcasting = participant ? participant.isBroadcasting : false;

  room.participants.delete(socket.id);
  socket.leave(roomId);

  // Notificar saída
  socket.to(roomId).emit('user-left', {
    id: socket.id,
    name: participant ? participant.name : 'Alguém'
  });

  // Notificar que parou de transmitir
  if (wasBroadcasting) {
    socket.to(roomId).emit('stream-stopped', { id: socket.id });
  }

  // Sala não é deletada — fica persistente
  if (room.participants.size === 0) {
    room.emptyAt = Date.now();
    console.log(`[Sala] ${roomId} ficou vazia (persistente por 30min)`);
  }

  socket.roomId = null;
}

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log(`[+] Conectado: ${socket.id}`);

  // Listar salas públicas (sem senha)
  socket.on('list-rooms', (callback) => {
    const list = [];
    for (const [id, room] of rooms) {
      list.push({
        id,
        name: room.name,
        hasPassword: room.hasPassword,
        participantCount: room.participants.size,
        ownerName: room.ownerName
      });
    }
    callback({ rooms: list });
  });

  // Verificar sala
  socket.on('check-room', ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ exists: false });
    callback({
      exists: true,
      name: room.name,
      hasPassword: room.hasPassword,
      participantCount: room.participants.size,
      ownerName: room.ownerName
    });
  });

  // Redefinir senha — só o dono pode, provando identidade pelo nome
  // O "token de dono" é: ownerName + roomId (sem senha, pois ela foi esquecida)
  socket.on('reset-password', ({ roomId, ownerName, newPassword }, callback) => {
    const room = rooms.get(roomId);

    if (!room) {
      return callback({ success: false, message: 'Sala não encontrada.' });
    }

    // Validar que o solicitante é o dono pelo nome (case-insensitive)
    const nameMatch = room.ownerName.trim().toLowerCase() === (ownerName || '').trim().toLowerCase();
    if (!nameMatch) {
      return callback({ success: false, message: 'Nome de dono incorreto. Apenas o criador da sala pode redefinir a senha.' });
    }

    // Atualizar a senha
    if (newPassword && newPassword.trim()) {
      room.password = bcrypt.hashSync(newPassword.trim(), 10);
      room.hasPassword = true;
    } else {
      // Nova senha vazia = remover senha
      room.password = null;
      room.hasPassword = false;
    }

    console.log(`[Sala] ${roomId} senha redefinida por ${ownerName}`);
    callback({ success: true });
  });

  // Criar sala
  socket.on('create-room', ({ roomId, roomName, password, userName }, callback) => {
    if (rooms.has(roomId)) {
      return callback({ success: false, message: 'Já existe uma sala com este ID.' });
    }

    const hashedPassword = password ? bcrypt.hashSync(password, 10) : null;

    const room = {
      id: roomId,
      name: roomName || roomId,
      password: hashedPassword,
      hasPassword: !!password,
      ownerId: socket.id,         // dono atual (pode mudar se ele sair)
      ownerOriginalId: socket.id, // dono original (para identificação)
      ownerName: userName,
      participants: new Map(),
      emptyAt: null
    };

    room.participants.set(socket.id, {
      name: userName,
      isOwner: true,
      isBroadcasting: false,
      broadcastType: null,
      hasMic: false,
      micMuted: true
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;

    callback({ success: true, roomId, isOwner: true });
    console.log(`[Sala] ${roomId} criada por ${userName}`);
  });

  // Entrar na sala
  socket.on('join-room', ({ roomId, password, userName }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, message: 'Sala não encontrada.' });

    if (room.hasPassword) {
      const valid = bcrypt.compareSync(password || '', room.password);
      if (!valid) return callback({ success: false, message: 'Senha incorreta.' });
    }

    room.participants.set(socket.id, {
      name: userName,
      isOwner: false,
      isBroadcasting: false,
      broadcastType: null,
      hasMic: false,
      micMuted: true
    });

    socket.join(roomId);
    socket.roomId = roomId;

    // Lista de participantes atual
    const participants = [];
    for (const [id, p] of room.participants) {
      participants.push({
        id,
        name: p.name,
        isOwner: p.isOwner,
        isBroadcasting: p.isBroadcasting,
        broadcastType: p.broadcastType,
        hasMic: p.hasMic,
        micMuted: p.micMuted
      });
    }

    // Notificar outros
    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      name: userName,
      isOwner: false
    });

    callback({
      success: true,
      roomId,
      roomName: room.name,
      isOwner: room.ownerId === socket.id,
      participants
    });

    console.log(`[Sala] ${userName} entrou em ${roomId}`);
  });

  // Deletar sala (só o dono pode)
  socket.on('delete-room', (callback) => {
    const roomId = socket.roomId;
    if (!roomId) return callback && callback({ success: false });

    const room = rooms.get(roomId);
    if (!room) return callback && callback({ success: false });

    if (room.ownerId !== socket.id) {
      return callback && callback({ success: false, message: 'Apenas o dono pode deletar a sala.' });
    }

    // Notificar todos e desconectar
    io.to(roomId).emit('room-deleted', { message: 'A sala foi deletada pelo dono.' });

    // Remover todos os sockets da sala
    for (const [id] of room.participants) {
      const s = io.sockets.sockets.get(id);
      if (s) { s.leave(roomId); s.roomId = null; }
    }

    rooms.delete(roomId);
    socket.roomId = null;

    callback && callback({ success: true });
    console.log(`[Sala] ${roomId} deletada por ${room.ownerName}`);
  });

  // Atualizar estado de transmissão
  socket.on('stream-started', ({ type, hasAudio }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) {
      p.isBroadcasting = true;
      p.broadcastType = type;
    }
    socket.to(socket.roomId).emit('stream-started', {
      id: socket.id,
      name: p ? p.name : '?',
      type,
      hasAudio: !!hasAudio
    });
  });

  socket.on('stream-stopped', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) { p.isBroadcasting = false; p.broadcastType = null; }
    socket.to(socket.roomId).emit('stream-stopped', { id: socket.id });
  });

  // Atualizar estado do microfone
  socket.on('mic-update', ({ hasMic, micMuted }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) {
      p.hasMic = hasMic;
      p.micMuted = micMuted;
    }
    socket.to(socket.roomId).emit('mic-update', {
      id: socket.id,
      hasMic,
      micMuted
    });
  });

  // ---- Sinalização WebRTC (todos com todos) ----

  // Solicitar conexão com outro peer
  socket.on('request-peer', ({ targetId }) => {
    socket.to(targetId).emit('request-peer', { fromId: socket.id });
  });

  socket.on('offer', ({ targetId, sdp }) => {
    socket.to(targetId).emit('offer', { fromId: socket.id, sdp });
  });

  socket.on('answer', ({ targetId, sdp }) => {
    socket.to(targetId).emit('answer', { fromId: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    socket.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  // Sair da sala manualmente
  socket.on('leave-room', () => handleLeave(socket));

  // Desconexão
  socket.on('disconnect', () => {
    handleLeave(socket);
    console.log(`[-] Desconectado: ${socket.id}`);
  });
});

// ==================== ROTAS HTTP ====================

app.get('/health', (req, res) => {
  res.json({ status: 'online', rooms: rooms.size, uptime: Math.floor(process.uptime()) });
});

// ==================== INICIALIZAÇÃO ====================

server.listen(PORT, () => {
  console.log('');
  console.log('==================================');
  console.log('       MaxCord - Servidor         ');
  console.log('==================================');
  console.log(`  Porta:  ${PORT}`);
  console.log('  Auth:   Aberta (sem token)');
  console.log('==================================');
  console.log('');
});
