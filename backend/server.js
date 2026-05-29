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

app.get('/chofer',    (req, res) => res.sendFile(path.join(__dirname, '../chofer/index.html')));
app.get('/operadora', (req, res) => res.sendFile(path.join(__dirname, '../operadora/index.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(__dirname, '../admin.html')));

// ── Supabase ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Almacén en memoria ──
const choferes = {};

// ── Haversine (reutilizable) ──
const haversine = (la1,lo1,la2,lo2) => {
  const R=6371000, p=Math.PI/180;
  const a = Math.sin((la2-la1)*p/2)**2 +
            Math.cos(la1*p)*Math.cos(la2*p)*Math.sin((lo2-lo1)*p/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
};

// ── REST: choferes disponibles ──
app.get('/choferes', (req, res) => {
  res.json(Object.values(choferes).filter(c => c.libre));
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
// Si viene chofer_id_forzado la operadora eligió uno manualmente (puede estar ocupado)
// Si no, se asigna automáticamente al libre más cercano
app.post('/servicio', async (req, res) => {
  const { origen, destino, telefono, lat, lng, chofer_id_forzado } = req.body;

  const todos = Object.values(choferes);
  if (!todos.length) {
    return res.status(404).json({ error: 'No hay choferes conectados' });
  }

  let mejor = null;
  let distMetros = 0;

  if (chofer_id_forzado) {
    // Operadora eligió chofer específico — sin restricción de estado
    mejor = todos.find(c => c.id === chofer_id_forzado);
    if (!mejor) return res.status(404).json({ error: 'Chofer no encontrado' });
    distMetros = haversine(lat, lng, mejor.lat, mejor.lng);
  } else {
    // Auto: más cercano entre los libres
    const libres = todos.filter(c => c.libre);
    if (!libres.length) {
      return res.status(404).json({ error: 'No hay choferes libres' });
    }
    let minD = Infinity;
    libres.forEach(c => {
      const d = haversine(lat, lng, c.lat, c.lng);
      if (d < minD) { minD = d; mejor = c; }
    });
    distMetros = minD;
  }

  // Marcar ocupado en memoria y BD
  mejor.libre = false;
  await supabase.from('choferes').update({ libre: false }).eq('id', mejor.id);

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
    distancia: (distMetros/1000).toFixed(1),
    eta: Math.ceil(distMetros/350),
    hora: new Date().toLocaleTimeString('es-VE',{hour:'2-digit',minute:'2-digit'})
  };

  io.to(mejor.socketId).emit('servicio_asignado', servicio);
  io.emit('choferes_actualizado', Object.values(choferes));
  res.json(servicio);
});

// ── REST: liberar chofer manualmente (desde operadora) ──
app.post('/liberar-chofer', async (req, res) => {
  const { choferId } = req.body;
  if (!choferId) return res.status(400).json({ error: 'Falta choferId' });

  const socketId = Object.keys(choferes).find(k => choferes[k].id === choferId);
  if (socketId) choferes[socketId].libre = true;

  await supabase.from('choferes').update({ libre: true }).eq('id', choferId);

  const { data: svcActivo } = await supabase
    .from('servicios').select('id')
    .eq('chofer_id', choferId).eq('estado', 'activo')
    .order('creado_en', { ascending: false }).limit(1).single();

  if (svcActivo) {
    await supabase.from('servicios')
      .update({ estado: 'completado', completado_en: new Date() })
      .eq('id', svcActivo.id);
  }

  io.emit('choferes_actualizado', Object.values(choferes));
  const { data: serviciosActualizados } = await supabase
    .from('servicios').select('*').order('creado_en', { ascending: false });
  io.emit('servicio_actualizado', serviciosActualizados || []);

  res.json({ ok: true });
});

// ── REST: Webhook WhatsApp (Twilio) ──
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

  if (!chofer) return res.type('text/xml').send(twiml('No encontré tu registro en el sistema.'));

  if (body === '1') return res.type('text/xml').send(twiml('✅ Servicio aceptado. ¡Buen viaje!'));

  if (body === '2') {
    if (chofer.id) {
      await supabase.from('choferes').update({ libre: true }).eq('id', chofer.id);
      chofer.libre = true;
      io.emit('choferes_actualizado', Object.values(choferes));
    }
    return res.type('text/xml').send(twiml('Servicio rechazado. Quedas disponible nuevamente.'));
  }

  if (body === 'listo') {
    const socketId = Object.keys(choferes).find(k => choferes[k].id === chofer.id);
    if (socketId) choferes[socketId].libre = true;
    if (chofer.id) await supabase.from('choferes').update({ libre: true }).eq('id', chofer.id);

    const { data: svcActivo } = await supabase
      .from('servicios').select('id')
      .eq('chofer_id', chofer.id).eq('estado', 'activo')
      .order('creado_en', { ascending: false }).limit(1).single();

    if (svcActivo) {
      await supabase.from('servicios')
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

  socket.on('chofer_conectado', async (data) => {
    let choferDB = null;
    if (data.placa) {
      const { data: row } = await supabase
        .from('choferes').select('*').eq('placa', data.placa).single();
      choferDB = row;
    }

    if (choferDB) {
      if (choferDB.activo === false) {
        socket.emit('chofer_validado', { ok: false, mensaje: '❌ Tu cuenta está desactivada. Contacta al administrador.' });
        return;
      }
      choferes[socket.id] = { ...choferDB, socketId: socket.id, libre: true };
      await supabase.from('choferes').update({ libre: true }).eq('id', choferDB.id);
      socket.emit('chofer_validado', { ok: true, nombre: choferDB.nombre });
      console.log(`🚕 Chofer online: ${choferDB.nombre}`);
      io.emit('choferes_actualizado', Object.values(choferes));
    } else {
      socket.emit('chofer_validado', { ok: false, mensaje: '❌ Placa no registrada. Verifica e intenta de nuevo.' });
    }
  });

  socket.on('ubicacion', async (data) => {
    if (choferes[socket.id]) {
      choferes[socket.id].lat = data.lat;
      choferes[socket.id].lng = data.lng;
      if (choferes[socket.id].id) {
        await supabase.from('choferes')
          .update({ lat: data.lat, lng: data.lng, actualizado_en: new Date() })
          .eq('id', choferes[socket.id].id);
      }
      io.emit('choferes_actualizado', Object.values(choferes));
    }
  });

  socket.on('servicio_completado', async (id) => {
    if (choferes[socket.id]) {
      choferes[socket.id].libre = true;
      if (choferes[socket.id].id) {
        await supabase.from('choferes').update({ libre: true }).eq('id', choferes[socket.id].id);
      }
      await supabase.from('servicios')
        .update({ estado: 'completado', completado_en: new Date() }).eq('id', id);
      io.emit('choferes_actualizado', Object.values(choferes));
      const { data: serviciosActualizados } = await supabase
        .from('servicios').select('*').order('creado_en', { ascending: false });
      io.emit('servicio_actualizado', serviciosActualizados || []);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`❌ Desconectado: ${socket.id}`);
    const chofer = choferes[socket.id];
    if (chofer?.id) await supabase.from('choferes').update({ libre: false }).eq('id', chofer.id);
    delete choferes[socket.id];
    io.emit('choferes_actualizado', Object.values(choferes));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ UBERGPS backend corriendo en http://localhost:${PORT}`));