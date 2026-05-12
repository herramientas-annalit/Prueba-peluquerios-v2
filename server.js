require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const TIMEZONE        = 'Europe/Madrid';
const SLOT_DURATION   = 30; // minutos

// Validación de variables de entorno al arrancar
const missingVars = [];
if (!GHL_API_KEY)     missingVars.push('GHL_API_KEY');
if (!GHL_LOCATION_ID) missingVars.push('GHL_LOCATION_ID');
if (!GHL_CALENDAR_ID) missingVars.push('GHL_CALENDAR_ID');
if (missingVars.length > 0) {
  console.error(`[CONFIG] ERROR: Faltan las siguientes variables de entorno: ${missingVars.join(', ')}`);
  console.error('[CONFIG] El servidor arrancará pero las llamadas a GHL fallarán hasta que se configuren.');
}

// Horario comercial completo para generar todos los slots del día
const HORARIO = [
  { inicio: '09:00', fin: '13:30' },
  { inicio: '16:30', fin: '20:00' },
];

function generarTodosSlots() {
  const slots = [];
  for (const bloque of HORARIO) {
    const [hIni, mIni] = bloque.inicio.split(':').map(Number);
    const [hFin, mFin] = bloque.fin.split(':').map(Number);
    let minutos = hIni * 60 + mIni;
    const finMinutos = hFin * 60 + mFin;
    while (minutos + SLOT_DURATION <= finMinutos) {
      const h = String(Math.floor(minutos / 60)).padStart(2, '0');
      const m = String(minutos % 60).padStart(2, '0');
      slots.push(`${h}:${m}`);
      minutos += SLOT_DURATION;
    }
  }
  return slots;
}

const SERVICIOS = {
  corte:       { nombre: 'Corte',         precio: '15 €' },
  barba:       { nombre: 'Barba',         precio: '10 €' },
  corte_barba: { nombre: 'Corte + Barba', precio: '22 €' },
};

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: '2021-04-15',
    'Content-Type': 'application/json',
    'location-id': GHL_LOCATION_ID,
  },
});

// Traduce errores HTTP de GHL a mensajes legibles
function interpretarErrorGHL(err, contexto) {
  const status = err.response?.status;
  const ghlMsg = err.response?.data?.message || err.response?.data?.msg || '';

  console.error(`[${contexto}] HTTP ${status || 'sin respuesta'} — ${ghlMsg || err.message}`);
  console.error(`[${contexto}] Detalle:`, JSON.stringify(err.response?.data || err.message));

  if (!err.response) {
    return { status: 503, mensaje: `[${contexto}] Sin respuesta de GHL. Comprueba la conexión o que la URL base sea correcta.` };
  }

  switch (status) {
    case 401:
      return { status: 401, mensaje: `[${contexto}] API Key inválida o caducada. Revisa GHL_API_KEY en las variables de entorno.` };
    case 403:
      return { status: 403, mensaje: `[${contexto}] Sin permisos. Comprueba que el API Key tenga los scopes necesarios (contacts.write, calendars.write).` };
    case 404:
      if (contexto === 'disponibilidad') {
        return { status: 404, mensaje: `[${contexto}] Calendario no encontrado. Revisa GHL_CALENDAR_ID en las variables de entorno.` };
      }
      if (contexto === 'buscar-contacto') {
        return { status: 404, mensaje: `[${contexto}] Location no encontrada. Revisa GHL_LOCATION_ID en las variables de entorno.` };
      }
      return { status: 404, mensaje: `[${contexto}] Recurso no encontrado en GHL. Revisa los IDs configurados.` };
    case 422:
      return { status: 422, mensaje: `[${contexto}] Datos inválidos enviados a GHL: ${ghlMsg}` };
    case 429:
      return { status: 429, mensaje: `[${contexto}] Límite de peticiones de GHL alcanzado. Intenta de nuevo en unos segundos.` };
    default:
      return { status: 500, mensaje: `[${contexto}] Error inesperado de GHL (HTTP ${status}): ${ghlMsg || err.message}` };
  }
}

// GET /api/disponibilidad?fecha=2026-05-10
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta el parámetro fecha' });

  if (!GHL_API_KEY || !GHL_CALENDAR_ID) {
    return res.status(500).json({ error: 'Configuración incompleta: faltan GHL_API_KEY o GHL_CALENDAR_ID en las variables de entorno.' });
  }

  console.log(`[disponibilidad] Consultando fecha: ${fecha}`);

  try {
    const startMs = new Date(`${fecha}T00:00:00`).getTime();
    const endMs   = new Date(`${fecha}T23:59:59`).getTime();

    const { data } = await ghl.get(`/calendars/${GHL_CALENDAR_ID}/free-slots`, {
      params: { startDate: startMs, endDate: endMs, timezone: TIMEZONE },
    });

    console.log(`[disponibilidad] Respuesta GHL:`, JSON.stringify(data).slice(0, 300));

    const diaData  = data[fecha] || data[Object.keys(data)[0]] || {};
    const slotsGHL = diaData.slots || [];

    // Extraer hora directamente del string ISO (evita doble conversión de timezone)
    // GHL devuelve "2026-05-15T10:30:00+02:00" — tomamos HH:MM directamente
    const horasLibres = new Set(
      slotsGHL.map(slot => slot.substring(11, 16))
    );

    // Generar todos los slots del horario comercial y marcar disponibilidad
    const todos = generarTodosSlots();
    console.log(`[disponibilidad] Horas libres GHL:`, [...horasLibres].join(', '));
    console.log(`[disponibilidad] Slots generados:`, todos.join(', '));
    const slots = todos.map(hora => ({ hora, disponible: horasLibres.has(hora) }));

    res.json({ fecha, slots });
  } catch (err) {
    const { status, mensaje } = interpretarErrorGHL(err, 'disponibilidad');
    res.status(status).json({ error: mensaje });
  }
});

// POST /api/reservar
app.post('/api/reservar', async (req, res) => {
  const { fecha, hora, servicio, nombre, telefono, email } = req.body;

  if (!fecha || !hora || !servicio || !nombre || !telefono) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  const svc = SERVICIOS[servicio];
  if (!svc) return res.status(400).json({ error: 'Servicio no válido' });

  if (!GHL_API_KEY || !GHL_LOCATION_ID || !GHL_CALENDAR_ID) {
    return res.status(500).json({ error: 'Configuración incompleta: faltan GHL_API_KEY, GHL_LOCATION_ID o GHL_CALENDAR_ID en las variables de entorno.' });
  }

  try {
    // 1. Buscar o crear contacto en GHL
    let contactId;

    try {
      const busqueda = await ghl.get('/contacts/', {
        params: { locationId: GHL_LOCATION_ID, query: telefono },
      });
      const encontrado = busqueda.data?.contacts?.[0];
      if (encontrado?.id) {
        contactId = encontrado.id;
        console.log(`[reservar] Contacto existente: ${contactId}`);
      }
    } catch (err) {
      // Si falla la búsqueda simplemente creamos el contacto igualmente
      console.warn(`[reservar] Búsqueda de contacto falló, se intentará crear:`, err.response?.status);
    }

    if (!contactId) {
      try {
        const [firstName, ...rest] = nombre.trim().split(' ');
        const nuevoContacto = await ghl.post('/contacts/', {
          locationId: GHL_LOCATION_ID,
          firstName,
          lastName: rest.join(' ') || '',
          phone: telefono,
          ...(email && { email }),
          tags: ['peluqueria', 'web-booking'],
        });
        contactId = nuevoContacto.data?.contact?.id;
        console.log(`[reservar] Contacto creado: ${contactId}`);
      } catch (err) {
        // GHL devuelve 400 con meta.contactId cuando el contacto ya existe
        if (err.response?.status === 400 && err.response?.data?.meta?.contactId) {
          contactId = err.response.data.meta.contactId;
          console.log(`[reservar] Contacto duplicado detectado, usando existente: ${contactId}`);
        } else {
          const { status, mensaje } = interpretarErrorGHL(err, 'crear-contacto');
          return res.status(status).json({ error: mensaje });
        }
      }
    }

    if (!contactId) {
      return res.status(500).json({ error: '[reservar] GHL devolvió respuesta de contacto sin ID. Comprueba los permisos del API Key.' });
    }

    // 2. Crear la cita en GHL
    try {
      const [hh, mm] = hora.split(':').map(Number);
      const finMin   = hh * 60 + mm + SLOT_DURATION;
      const finHora  = `${String(Math.floor(finMin / 60)).padStart(2,'0')}:${String(finMin % 60).padStart(2,'0')}`;

      // GHL interpreta el startTime como UTC puro — hay que enviar en Unix ms
      const inicioMs = new Date(`${fecha}T${hora}:00+02:00`).getTime();
      const finMs    = new Date(`${fecha}T${finHora}:00+02:00`).getTime();
      console.log(`[reservar] Enviando cita: ${new Date(inicioMs).toISOString()} → ${new Date(finMs).toISOString()} (${inicioMs})`);

      const cita = await ghl.post('/calendars/events/appointments', {
        calendarId:        GHL_CALENDAR_ID,
        locationId:        GHL_LOCATION_ID,
        contactId,
        startTime:         inicioMs,
        endTime:           finMs,
        title:             `${svc.nombre} — ${nombre}`,
        appointmentStatus: 'confirmed',
        ignoreDateRange:   false,
        toNotify:          true,
        notes:             `Servicio: ${svc.nombre} (${svc.precio})\nTeléfono: ${telefono}${email ? '\nEmail: ' + email : ''}`,
      });
      console.log(`[reservar] Cita creada: ${cita.data?.id}`);
    } catch (err) {
      interpretarErrorGHL(err, 'crear-cita'); // log interno
      return res.status(500).json({ error: 'No se pudo crear la cita. Por favor, inténtalo de nuevo o llámanos directamente.' });
    }

    res.json({ ok: true, mensaje: `Reserva confirmada: ${svc.nombre} el ${fecha} a las ${hora}` });
  } catch (err) {
    console.error('[reservar] ERROR inesperado:', err.message);
    res.status(500).json({ error: `Error inesperado en el servidor: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`[CONFIG] GHL_API_KEY:     ${GHL_API_KEY     ? '✓ cargada' : '✗ FALTA'}`);
  console.log(`[CONFIG] GHL_LOCATION_ID: ${GHL_LOCATION_ID ? '✓ cargada' : '✗ FALTA'}`);
  console.log(`[CONFIG] GHL_CALENDAR_ID: ${GHL_CALENDAR_ID ? '✓ cargada' : '✗ FALTA'}`);
});
