// server.js (CommonJS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// CORS para HTTP (ajuste ALLOWED_ORIGINS depois se quiser restringir)
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true
}));

// Healthcheck
app.get('/', (_req, res) => res.status(200).send('OK'));

// Servidor HTTP
const httpServer = http.createServer(app);

// Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, true),
    credentials: true
  },
  transports: ['websocket', 'polling'],
  path: '/socket.io'
});

const log = (...a) => console.log(new Date().toISOString(), ...a);
const toRide = (id) => `ride:${id}`;

// ====== Eventos ======
io.on('connection', (socket) => {
  log('📱 Conectado:', socket.id);

  // identificar cliente
  // payload: { tipo: 'motorista' | 'passageiro' }
  socket.on('identificar', (data = {}) => {
    try {
      const tipo = (data.tipo || '').toString();
      socket.data.tipo = tipo;

      if (tipo === 'motorista') {
        socket.join('motoristas');
        log('🚗 Motorista:', socket.id);
        socket.emit('status', { ok: true, tipo });
      } else if (tipo === 'passageiro') {
        socket.join('passageiros');
        log('👤 Passageiro:', socket.id);
        socket.emit('status', { ok: true, tipo });
      } else {
        log('ℹ️ Tipo inválido:', socket.id, data);
        socket.emit('status', { ok: false, error: 'tipo_invalido' });
      }
    } catch (e) {
      log('identificar erro:', e);
    }
  });

  // passageiro cria corrida → notifica motoristas
  // payload: { rideId, passengerId, passengerName, pickupAddress, pickupLocation, destinationAddress, destinationLocation, fare }
  socket.on('nova_corrida', (data = {}) => {
    try {
      if (!data.rideId) return;
      log('🆕 nova_corrida:', data.rideId, 'passageiro:', data.passengerId);

      socket.join(toRide(data.rideId));

      io.to('motoristas').emit('corrida_disponivel', {
        rideId: data.rideId,
        passengerId: data.passengerId,
        passengerName: data.passengerName || 'Passageiro',
        pickupAddress: data.pickupAddress,
        pickupLocation: data.pickupLocation,
        destinationAddress: data.destinationAddress,
        destinationLocation: data.destinationLocation,
        fare: data.fare,
        timestamp: new Date().toISOString(),
        status: 'pending'
      });
    } catch (e) {
      log('nova_corrida erro:', e);
    }
  });

  // motorista aceita → avisa sala da corrida (passageiro + motorista)
  // payload: { rideId, driverId, driverName }
  socket.on('corrida_aceita', (data = {}) => {
    try {
      if (!data.rideId || !data.driverId) return;
      log('👍 corrida_aceita:', data.rideId, 'driver:', data.driverId);

      socket.join(toRide(data.rideId));

      io.to(toRide(data.rideId)).emit('corrida_aceita', {
        ...data,
        message: 'Motorista a caminho!'
      });
    } catch (e) {
      log('corrida_aceita erro:', e);
    }
  });

  // chat por corrida
  // payload: { rideId, from, message }
  socket.on('enviar_mensagem', (data = {}) => {
    try {
      if (!data.rideId || !data.message) return;
      io.to(toRide(data.rideId)).emit('nova_mensagem', {
        from: data.from,
        message: data.message,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      log('enviar_mensagem erro:', e);
    }
  });

  // status da corrida
  // payload: { rideId, by: 'motorista'|'passageiro'|'sistema', status: 'arrived'|'ongoing'|'completed'|'canceled' }
  socket.on('corrida_status', (data = {}) => {
    try {
      if (!data.rideId || !data.status) return;
      io.to(toRide(data.rideId)).emit('corrida_status_atualizada', {
        ...data,
        timestamp: new Date().toISOString()
      });

      if (['completed', 'canceled'].includes(data.status)) {
        setTimeout(() => {
          io.in(toRide(data.rideId)).socketsLeave(toRide(data.rideId));
        }, 3000);
      }
    } catch (e) {
      log('corrida_status erro:', e);
    }
  });

  socket.on('disconnect', () => {
    log('❌ Desconectado:', socket.id);
  });
});

// start
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => log(`🚀 Socket.IO no ar na porta ${PORT}`));

// graceful shutdown (Render)
const shutdown = (signal) => {
  log(`Recebido ${signal}, encerrando...`);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
