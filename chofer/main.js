import { io } from "socket.io-client";
import { registerPlugin } from "@capacitor/core";

const BackgroundGeolocation = registerPlugin("BackgroundGeolocation");
let backgroundWatcherId = null; 

const SERVIDOR = 'https://ubergps.onrender.com';
let socket, libre = false, watchId = null;
let servicioActual = null, serviciosHoy = 0, kmHoy = 0;
let miNombre = '', miPlaca = '', miTel = '';

function mostrarLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function conectar() {
  miPlaca = document.getElementById('inp-placa').value.trim().toUpperCase();
  document.getElementById('login-error').style.display = 'none';

  if (!miPlaca) {
    mostrarLoginError('⚠️ Ingresa la placa de tu vehículo');
    return;
  }

  const btn = document.querySelector('#pantalla-login .btn-verde');
  btn.textContent = 'CONECTANDO...';
  btn.disabled = true;

  socket = io(SERVIDOR);

  socket.on('connect', () => {
    socket.emit('chofer_conectado', { placa: miPlaca });
  });

  socket.on('login_ok', (choferDB) => {
    miNombre = choferDB.nombre || miPlaca;
    miTel    = choferDB.telefono || choferDB.tel || '';

    document.getElementById('pantalla-login').style.display = 'none';
    document.getElementById('pantalla-dashboard').style.display = 'block';
    document.getElementById('lbl-nombre').textContent = miNombre;
    document.getElementById('lbl-placa').textContent  = miPlaca;
    toast('✅ Conectado al sistema');
  });

  socket.on('login_error', (mensaje) => {
    mostrarLoginError('❌ ' + mensaje);
    btn.textContent = 'ENTRAR AL SISTEMA';
    btn.disabled = false;
    socket.disconnect();
  });

  socket.on('servicio_asignado', (svc) => {
    servicioActual = svc;
    document.getElementById('svc-origen').textContent  = svc.origen;
    document.getElementById('svc-destino').textContent = svc.destino;
    document.getElementById('svc-tel').textContent     = svc.telefono || 'No indicado';
    document.getElementById('svc-dist').textContent    = `${svc.distancia} km · ~${svc.eta} min`;
    document.getElementById('servicio-card').classList.add('visible');

    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
    toast('🔔 ¡Nuevo servicio asignado!');
  });

  socket.on('disconnect', () => {
    toast('⚠️ Desconectado del servidor');
    detenerGPS();
  });
}

function toggleEstado() {
  libre = !libre;
  const btn = document.getElementById('btn-estado');

  if (libre) {
    btn.className = 'btn-estado libre';
    btn.innerHTML = 'DISPONIBLE<span class="btn-estado-sub">Recibiendo servicios</span>';
    iniciarGPS();
  } else {
    btn.className = 'btn-estado ocupado';
    btn.innerHTML = 'NO DISPONIBLE<span class="btn-estado-sub">Toca para activarte</span>';
    detenerGPS();
  }
}

async function iniciarGPS() {
  document.getElementById('gps-dot').className   = 'gps-dot activo';
  document.getElementById('gps-label').textContent = 'GPS activo — enviando ubicación';

  const esNativo = window.Capacitor && window.Capacitor.isNativePlatform();

  if (esNativo) {
    // 🚀 MODO NATIVO: Rastreo indestructible en segundo plano
    try {
      backgroundWatcherId = await BackgroundGeolocation.addWatcher(
        {
          backgroundMessage: "Compartiendo ubicación en tiempo real.",
          backgroundTitle: "UBERGPS Chofer Activo",
          requestPermissions: true,
          staleLinearDistance: 0 
        },
        (location, error) => {
          if (error) {
            toast('⚠️ Error GPS Nativo: ' + error.message);
            return;
          }
          if (location) {
            const lat = location.latitude;
            const lng = location.longitude;
            const precision = Math.round(location.accuracy || 0);

            document.getElementById('gps-coords').textContent =
              `${lat.toFixed(5)}, ${lng.toFixed(5)} · ±${precision}m`;

            if (socket && socket.connected) {
              socket.emit('ubicacion', { lat, lng });
            }
          }
        }
      );
    } catch (err) {
      toast('⚠️ Error al iniciar GPS nativo: ' + err.message);
    }
  } else {
    // 🌐 MODO NAVEGADOR: Por si lo abres en la PC para pruebas rápidas
    if (!navigator.geolocation) {
      toast('⚠️ GPS no disponible en este dispositivo');
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const precision = Math.round(pos.coords.accuracy);

        document.getElementById('gps-coords').textContent =
          `${lat.toFixed(5)}, ${lng.toFixed(5)} · ±${precision}m`;

        if (socket && socket.connected) {
          socket.emit('ubicacion', { lat, lng });
        }
      },
      (err) => {
        toast('⚠️ Error GPS Browser: ' + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }
}

async function detenerGPS() {
  const esNativo = window.Capacitor && window.Capacitor.isNativePlatform();

  if (esNativo && backgroundWatcherId) {
    await BackgroundGeolocation.removeWatcher({ id: backgroundWatcherId });
    backgroundWatcherId = null;
  } else if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  document.getElementById('gps-dot').className    = 'gps-dot inactivo';
  document.getElementById('gps-label').textContent  = 'GPS inactivo';
  document.getElementById('gps-coords').textContent = 'Activa tu disponibilidad';
}

function completarServicio() {
  if (!servicioActual) return;

  socket.emit('servicio_completado', servicioActual.id);

  serviciosHoy++;
  kmHoy += parseFloat(servicioActual.distancia || 0);

  document.getElementById('cnt-servicios').textContent = serviciosHoy;
  document.getElementById('cnt-km').textContent = kmHoy.toFixed(1);

  document.getElementById('servicio-card').classList.remove('visible');
  servicioActual = null;

  libre = true;
  const btn = document.getElementById('btn-estado');
  btn.className = 'btn-estado libre';
  btn.innerHTML = 'DISPONIBLE<span class="btn-estado-sub">Recibiendo servicios</span>';
  iniciarGPS();

  toast('✅ Servicio completado');
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 3000);
}

// Globalizar funciones para los clicks del HTML
window.conectar = conectar;
window.toggleEstado = toggleEstado;
window.completarServicio = completarServicio;