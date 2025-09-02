// server.js (CommonJS) — matching em lote com "Quick Test Mode" + ride_subscribe
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.get('/', (_req, res) => res.status(200).send('OK'));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: (o, cb) => cb(null, true), credentials: true },
  transports: ['websocket', 'polling'],
  path: '/socket.io',
});

// ---------- helpers ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);
const toRide = (id) => `ride:${id}`;
const now = () => Date.now();

// distância Haversine (em km)
function distKm(a, b) {
  if (!a || !b) return 9999;
  const R = 6371;
  const dLat = (Math.PI / 180) * (b.lat - a.lat);
  const dLng = (Math.PI / 180) * (b.lng - a.lng);
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 = Math.cos((Math.PI / 180) * a.lat) * Math.cos((Math.PI / 180) * b.lat) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}
function uid() { return Math.random().toString(36).slice(2, 10); }

// ---------- parâmetros de matching ----------
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);
const OFFER_TTL_MS = Number(process.env.OFFER_TTL_MS || 12000);
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 3);
const DRIVER_STALE_MS = Number(process.env.DRIVER_STALE_MS || 30000);

// 🚀 QUICK TEST MODE (para dev): ignora filtros de distância/heartbeat
const QUICK_TEST_MODE = process.env.QUICK_TEST_MODE === '1';

// ---------- memória ----------
const driversBySocket = new Map();
/**
 * rides: rideId -> {
 *   status, passengerSid, pickup, dest, routePolyline, fare,
 *   offered(Map), offeredSockets(Set), winnerSid, round, timer
 * }
 */
const rides = new Map();

// ---------- núcleo de matching ----------
function listCandidateDrivers(pickup) {
  const out = [];
  for (const [sid, info] of driversBySocket.entries()) {
    if (QUICK_TEST_MODE) {
      out.push({ socketId: sid, info, d: 0 });
      continue;
    }
    if (!info.available) continue;
    const hasFresh = info.last && (now() - info.last.at) <= DRIVER_STALE_MS;
    if (hasFresh) out.push({ socketId: sid, info, d: distKm(info.last, pickup) });
  }
  out.sort((a, b) => a.d - b.d);
  if (!QUICK_TEST_MODE && out.length === 0) {
    for (const [sid, info] of driversBySocket.entries()) {
      if (!info.available) continue;
      out.push({ socketId: sid, info, d: 9999 });
    }
  }
  return out;
}

function dispatchRound(rideId) {
  const r = rides.get(rideId);
  if (!r || r.status !== 'searching') return;

  const all = listCandidateDrivers(r.pickup);
  const already = r.offeredSockets || new Set();
  let candidates = all.filter(c => !already.has(c.socketId)).slice(0, BATCH_SIZE);

  if (QUICK_TEST_MODE && candidates.length === 0) {
    for (const [sid, info] of driversBySocket.entries()) {
      if (already.has(sid)) continue;
      candidates.push({ socketId: sid, info, d: 0 });
      if (candidates.length >= BATCH_SIZE) break;
    }
  }

  if (candidates.length === 0) {
    if (r.round >= MAX_ROUNDS - 1) {
      log('🙅 sem motoristas para', rideId, QUICK_TEST_MODE ? '(QuickTest: nenhum motorista conectado?)' : '');
      io.to(r.passengerSid).emit('sem_motoristas', { rideId });
      r.status = 'failed';
      clearTimer(r);
      return;
    }
    r.round++;
    r.timer = setTimeout(() => dispatchRound(rideId), 2000);
    return;
  }

  log(`📦 round ${r.round + 1}/${MAX_ROUNDS} -> enviando para ${candidates.length} motoristas`, rideId, QUICK_TEST_MODE ? '(QuickTest ON)' : '');
  const expiresAt = now() + OFFER_TTL_MS;

  for (const c of candidates) {
    const offerId = uid();
    r.offered.set(offerId, { socketId: c.socketId, at: now(), status: 'pending' });
    r.offeredSockets.add(c.socketId);

    const payload = {
      offerId,
      rideId,
      passengerName: r.passengerName || 'Passageiro',
      pickupAddress: r.pickupAddress,
      pickupLocation: r.pickup,
      destinationAddress: r.destinationAddress,
      destinationLocation: r.dest,
      routePolyline: r.routePolyline || null,
      fare: r.fare,
      expiresAt
    };
    io.to(c.socketId).emit('corrida_disponivel', payload);
    // Se quiser forçar visual em dev:
    // if (QUICK_TEST_MODE) io.to('motoristas').emit('corrida_disponivel', payload);
  }

  clearTimer(r);
  r.timer = setTimeout(() => {
    const rr = rides.get(rideId);
    if (!rr || rr.status !== 'searching') return;
    rr.round++;
    dispatchRound(rideId);
  }, OFFER_TTL_MS);
}

function clearTimer(r) { if (r && r.timer) { clearTimeout(r.timer); r.timer = null; } }

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  log('📱 Conectado:', socket.id);

  socket.on('identificar', (data = {}) => {
    try {
      const tipo = String(data.tipo || '');
      socket.data.tipo = tipo;

      if (tipo === 'motorista') {
        socket.join('motoristas');
        driversBySocket.set(socket.id, {
          driverId: data.driverId || null,
          available: false,
          last: null
        });
        socket.emit('status', { ok: true, tipo, quickTest: QUICK_TEST_MODE });
        log('🚗 Motorista entrou:', socket.id, QUICK_TEST_MODE ? '(QuickTest ON)' : '');
      } else if (tipo === 'passageiro') {
        socket.join('passageiros');
        socket.emit('status', { ok: true, tipo, quickTest: QUICK_TEST_MODE });
        log('👤 Passageiro entrou:', socket.id, QUICK_TEST_MODE ? '(QuickTest ON)' : '');
      } else {
        socket.emit('status', { ok: false, error: 'tipo_invalido' });
      }
    } catch (e) { log('identificar erro:', e); }
  });

  // ✅ (NOVO) cliente garante inscrição na sala da corrida
  // payload: { rideId }
  socket.on('ride_subscribe', (data = {}) => {
    const rideId = String(data.rideId || '');
    if (!rideId) return;
    socket.join(toRide(rideId));
    log('🔔', socket.id, 'subscribed ride', rideId);
  });

  socket.on('driver_status', (data = {}) => {
    const rec = driversBySocket.get(socket.id);
    if (!rec) return;
    rec.available = !!data.available;
    driversBySocket.set(socket.id, rec);
  });

  // localização do motorista (presença + telemetria durante a corrida)
  socket.on('driver_localizacao', (data = {}) => {
    try {
      const lat = Number(data.lat);
      const lng = Number(data.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const rec = driversBySocket.get(socket.id);
      if (rec) {
        rec.last = { lat, lng, at: now() };
        driversBySocket.set(socket.id, rec);
      }

      if (data.rideId) {
        io.to(toRide(String(data.rideId))).emit('driver_localizacao', {
          rideId: String(data.rideId), lat, lng,
          heading: (typeof data.heading === 'number' ? data.heading : null),
          speed: (typeof data.speed === 'number' ? data.speed : null),
          timestamp: new Date().toISOString(),
        });
      }
    } catch (e) { log('driver_localizacao erro:', e); }
  });

  // PASSAGEIRO cria corrida
  socket.on('nova_corrida', (data = {}) => {
    try {
      const rideId = String(data.rideId || '');
      if (!rideId) return;

      const r = {
        status: 'searching',
        passengerSid: socket.id,
        passengerName: data.passengerName || 'Passageiro',
        pickupAddress: data.pickupAddress || '',
        destinationAddress: data.destinationAddress || '',
        pickup: {
          lat: Number(data.pickupLocation?.latitude ?? data.pickupLocation?.lat),
          lng: Number(data.pickupLocation?.longitude ?? data.pickupLocation?.lng),
        },
        dest: {
          lat: Number(data.destinationLocation?.latitude ?? data.destinationLocation?.lat),
          lng: Number(data.destinationLocation?.longitude ?? data.destinationLocation?.lng),
        },
        routePolyline: data.routePolyline || null,
        fare: data.fare || null,
        offered: new Map(),
        offeredSockets: new Set(),
        winnerSid: null,
        round: 0,
        timer: null,
      };
      rides.set(rideId, r);

      socket.join(toRide(rideId));          // passageiro entra na sala
      dispatchRound(rideId);
    } catch (e) { log('nova_corrida erro:', e); }
  });

  // MOTORISTA aceita (primeiro vence)
  socket.on('corrida_aceita', (data = {}) => {
    try {
      const rideId = String(data.rideId || '');
      const offerId = String(data.offerId || '');
      if (!rideId || !offerId) return;

      const r = rides.get(rideId);
      if (!r || r.status !== 'searching') {
        socket.emit('offer_lost', { rideId, reason: 'not_searching' });
        return;
      }

      const off = r.offered.get(offerId);
      if (!off || off.socketId !== socket.id || off.status !== 'pending') {
        socket.emit('offer_lost', { rideId, reason: 'offer_invalid' });
        return;
      }

      // vencedor
      r.status = 'accepted';
      r.winnerSid = socket.id;
      off.status = 'won';
      clearTimer(r);

      // perdedores
      for (const [oid, o] of r.offered.entries()) {
        if (oid === offerId) continue;
        if (o.status === 'pending') {
          o.status = 'lost';
          io.to(o.socketId).emit('offer_lost', { rideId, reason: 'already_taken' });
        }
      }

      socket.join(toRide(rideId));

      const payload = {
        rideId,
        driverId: data.driverId,
        driverName: data.driverName,
        driverPhone: data.driverPhone,
        vehicleModel: data.vehicleModel,
        vehiclePlate: data.vehiclePlate,
        status: 'accepted',
        message: 'Motorista a caminho',
        timestamp: new Date().toISOString(),
        approachPolyline: data.approachPolyline || null,
      };

      // ✅ avisa sala da corrida
      io.to(toRide(rideId)).emit('corrida_aceita', payload);
      // ✅ redundância: também avisa diretamente o socket do passageiro registrado no início
      if (r.passengerSid) io.to(r.passengerSid).emit('corrida_aceita', payload);

      io.to(socket.id).emit('offer_won', { rideId });
    } catch (e) { log('corrida_aceita erro:', e); }
  });

  // chat
  socket.on('enviar_mensagem', (data = {}) => {
    try {
      if (!data.rideId || !data.message) return;
      io.to(toRide(String(data.rideId))).emit('nova_mensagem', {
        from: data.from,
        message: data.message,
        timestamp: new Date().toISOString()
      });
    } catch (e) { log('enviar_mensagem erro:', e); }
  });

  // status de corrida
  socket.on('corrida_status', (data = {}) => {
    try {
      const rideId = String(data.rideId || '');
      if (!rideId || !data.status) return;
      io.to(toRide(rideId)).emit('corrida_status_atualizada', {
        ...data,
        rideId,
        timestamp: new Date().toISOString()
      });

      if (['completed', 'canceled'].includes(data.status)) {
        setTimeout(() => io.in(toRide(rideId)).socketsLeave(toRide(rideId)), 3000);
        rides.delete(rideId);
      }
    } catch (e) { log('corrida_status erro:', e); }
  });

  socket.on('disconnect', () => {
    const rec = driversBySocket.get(socket.id);
    if (rec) { rec.available = false; driversBySocket.set(socket.id, rec); }
    log('❌ Desconectado:', socket.id);
  });
});

// start
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => log(`🚀 Socket.IO no ar na porta ${PORT} ${QUICK_TEST_MODE ? '(QuickTest ON)' : ''}`));

// graceful shutdown (Render)
function shutdown(sig) {
  log(`Recebido ${sig}, encerrando...`);
  io.close(() => httpServer.close(() => process.exit(0)));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
