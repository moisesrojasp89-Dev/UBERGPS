require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.json());

const path = require('path');
// Antes
app.use('/chofer', express.static(path.join(__dirname, '../chofer')));
app.use('/operadora', express.static(path.join(__dirname, '../operadora')));

// Después
app.get('/chofer', (req, res) => {
  res.sendFile(path.join(__dirname, '../chofer/index.html'));
});
app.get('/operadora', (req, res) => {
  res.sendFile(path.join(__dirname, '../operadora/index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin.html'));
});

// ── Supabase ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Almacén en memoria (sockets activos) ──
const choferes = {};  // { socketId: { id, nombre, placa, telefono, lat, lng, libre } }

// ── REST: choferes disponibles ──
app.get('/choferes', (req, res) => {
  const disponibles = Object.values(choferes).filter(c => c.libre);
  res.json(disponibles);
});

// ── REST: historial de servicios ──
app.get('/servicios', async (req, res) => {
  const { data, error } = await supabase
    .from('servicios')
    .select('*, choferes(nombre, placa)')
    .order('creado_en', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── REST: crear servicio y asignar chofer ──
app.post('/servicio', async (req, res) => {
  const { origen, destino, telefono, lat, lng } = req.body;

  const disponibles = Object.values(choferes).filter(c => c.libre);
  if (!disponibles.length) {
    return res.status(404).json({ error: 'No hay choferes disponibles' });
  }

  // Haversine — chofer más cercano
  const haversine = (la1,lo1,la2,lo2) => {
    const R=6371000, p=Math.PI/180;
    const a = Math.sin((la2-la1)*p/2)**2 +
              Math.cos(la1*p)*Math.cos(la2*p)*Math.sin((lo2-lo1)*p/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  };

  let mejor = null, minD = Infinity;
  disponibles.forEach(c => {
    const d = haversine(lat, lng, c.lat, c.lng);
    if (d < minD) { minD = d; mejor = c; }
  });

  // Marcar ocupado en memoria
  mejor.libre = false;

  // Marcar ocupado en Supabase
  await supabase
    .from('choferes')
    .update({ libre: false })
    .eq('id', mejor.id);

  // Guardar servicio en Supabase
  const { data: svcData, error } = await supabase
    .from('servicios')
    .insert({
      origen,
      destino,
      telefono_cliente: telefono,
      chofer_id: mejor.id,
      estado: 'activo'
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const servicio = {
    ...svcData,
    chofer: mejor,
    distancia: (minD/1000).toFixed(1),
    eta: Math.ceil(minD/350),
    hora: new Date().toLocaleTimeString('es-VE',{hour:'2-digit',minute:'2-digit'})
  };

  // Notificar al chofer
  io.to(mejor.socketId).emit('servicio_asignado', servicio);

  // Notificar a operadoras
  io.emit('choferes_actualizado', Object.values(choferes));

  res.json(servicio);
});

// ── REST: Webhook WhatsApp (Twilio) ──
// Twilio envía POST cuando el chofer responde por WhatsApp
app.post('/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  const from = (req.body.From || '').replace('whatsapp:', '').trim();
  const body = (req.body.Body || '').trim().toLowerCase();

  console.log(`📱 WhatsApp de ${from}: "${body}"`);

  const chofer = Object.values(choferes).find(c => {
    const tel = (c.telefono || c.tel || '').replace(/\D/g, '');
    const fromClean = from.replace(/\D/g, '');
    return fromClean.endsWith(tel) || tel.endsWith(fromClean);
  });

  const twiml = (msg) =>
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;

  if (!chofer) {
    return res.type('text/xml').send(twiml('No encontré tu registro en el sistema.'));
  }

  if (body === '1') {
    return res.type('text/xml').send(twiml('✅ Servicio aceptado. ¡Buen viaje!'));
  }

  if (body === '2') {
    if (chofer.id) {
      await supabase.from('choferes').update({ libre: true }).eq('id', chofer.id);
      chofer.libre = true;
      io.emit('choferes_actualizado', Object.values(choferes));
    }
    return res.type('text/xml').send(twiml('Servicio rechazado. Quedas disponible nuevamente.'));
  }

  // "listo" = servicio completado (antes era "completado")
  if (body === 'listo') {
    const socketId = Object.keys(choferes).find(k => choferes[k].id === chofer.id);
    if (socketId) choferes[socketId].libre = true;
    if (chofer.id) {
      await supabase.from('choferes').update({ libre: true }).eq('id', chofer.id);
    }

    const { data: svcActivo } = await supabase
      .from('servicios')
      .select('id')
      .eq('chofer_id', chofer.id)
      .eq('estado', 'activo')
      .order('creado_en', { ascending: false })
      .limit(1)
      .single();

    if (svcActivo) {
      await supabase
        .from('servicios')
        .update({ estado: 'completado', completado_en: new Date() })
        .eq('id', svcActivo.id);
    }

    io.emit('choferes_actualizado', Object.values(choferes));

    const { data: serviciosActualizados } = await supabase
      .from('servicios').select('*').order('creado_en', { ascending: false });
    io.emit('servicio_actualizado', serviciosActualizados || []);

    return res.type('text/xml').send(twiml('✅ Servicio completado. ¡Gracias!'));
  }

  res.type('text/xml').send(twiml('Responde:\n1 = Aceptar\n2 = Rechazar\nListo = Completar servicio'));
});

// ── WebSockets ──
io.on('connection', (socket) => {
  console.log(`🔌 Conectado: ${socket.id}`);

  // Chofer se registra — busca sus datos en Supabase
  socket.on('chofer_conectado', async (data) => {
    // data debe traer { id } o { placa } para identificarlo
    let choferDB = null;

    if (data.placa) {
  const { data: row } = await supabase
    .from('choferes')
    .select('*')
    .eq('placa', data.placa)
    .single();
  choferDB = row;
}

    if (choferDB) {
      // Verificar que el chofer esté activo en el sistema
      if (choferDB.activo === false) {
        socket.emit('login_error', 'Tu cuenta está desactivada. Contacta al administrador.');
        return;
      }

      choferes[socket.id] = {
        ...choferDB,
        socketId: socket.id,
        libre: true
      };
      // Marcar libre en BD al conectarse
      await supabase
        .from('choferes')
        .update({ libre: true })
        .eq('id', choferDB.id);

      socket.emit('login_ok', choferDB);
    } else {
      // Placa no encontrada en la BD
      socket.emit('login_error', 'Placa no registrada en el sistema. Verifica e intenta de nuevo.');
      return;
    }

    console.log(`🚕 Chofer online: ${choferes[socket.id].nombre}`);
    io.emit('choferes_actualizado', Object.values(choferes));
  });

  // Chofer envía GPS — actualiza en memoria y BD
  socket.on('ubicacion', async (data) => {
    if (choferes[socket.id]) {
      choferes[socket.id].lat = data.lat;
      choferes[socket.id].lng = data.lng;

      // Actualizar coordenadas en Supabase
      if (choferes[socket.id].id) {
        await supabase
          .from('choferes')
          .update({ lat: data.lat, lng: data.lng, actualizado_en: new Date() })
          .eq('id', choferes[socket.id].id);
      }

      io.emit('choferes_actualizado', Object.values(choferes));
    }
  });

  // Chofer completa servicio
  socket.on('servicio_completado', async (id) => {
    if (choferes[socket.id]) {
      choferes[socket.id].libre = true;

      // Actualizar en Supabase
      if (choferes[socket.id].id) {
        await supabase
          .from('choferes')
          .update({ libre: true })
          .eq('id', choferes[socket.id].id);
      }

      await supabase
        .from('servicios')
        .update({ estado: 'completado', completado_en: new Date() })
        .eq('id', id);

      io.emit('choferes_actualizado', Object.values(choferes));

      const { data: serviciosActualizados } = await supabase
        .from('servicios')
        .select('*')
        .order('creado_en', { ascending: false });

      io.emit('servicio_actualizado', serviciosActualizados || []);
    }
  });

  // Chofer se desconecta
  socket.on('disconnect', async () => {
    console.log(`❌ Desconectado: ${socket.id}`);
    const chofer = choferes[socket.id];
    if (chofer?.id) {
      await supabase
        .from('choferes')
        .update({ libre: false })
        .eq('id', chofer.id);
    }
    delete choferes[socket.id];
    io.emit('choferes_actualizado', Object.values(choferes));
  });
});

// ── Arrancar servidor ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ UBERGPS backend corriendo en http://localhost:${PORT}`);
});