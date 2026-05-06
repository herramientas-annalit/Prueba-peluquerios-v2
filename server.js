require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const TIMEZONE = 'Europe/Madrid';
const SLOT_DURATION = 30; // minutos

// Horarios comerciales
const HORARIO = [
  { inicio: '09:00', fin: '13:30' },
  { inicio: '16:30', fin: '20:00' },
];

const SERVICIOS = {
  corte:       { nombre: 'Corte',        precio: '15 €' },
  barba:       { nombre: 'Barba',        precio: '10 €' },
  corte_barba: { nombre: 'Corte + Barba', precio: '22 €' },
};

function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// Genera todos los slots del día según horario comercial
function generarSlots(fecha) {
  const slots = [];
  for (const bloque of HORARIO) {
    const [hIni, mIni] = bloque.inicio.split(':').map(Number);
    const [hFin, mFin] = bloque.fin.split(':').map(Number);
    let minutos = hIni * 60 + mIni;
    const finMinutos = hFin * 60 + mFin;
    while (minutos + SLOT_DURATION <= finMinutos) {
      const h = String(Math.floor(minutos / 60)).padStart(2, '0');
      const m = String(minutos % 60).padStart(2, '0');
      const inicio = new Date(`${fecha}T${h}:${m}:00`);
      const fin = new Date(inicio.getTime() + SLOT_DURATION * 60000);
      slots.push({ hora: `${h}:${m}`, inicio, fin });
      minutos += SLOT_DURATION;
    }
  }
  return slots;
}

// GET /api/disponibilidad?fecha=2026-05-10
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta el parámetro fecha' });

  console.log(`[disponibilidad] Consultando fecha: ${fecha}`);
  console.log(`[disponibilidad] CALENDAR_ID: ${CALENDAR_ID}`);
  console.log(`[disponibilidad] CLIENT_EMAIL: ${process.env.GOOGLE_CLIENT_EMAIL}`);

  try {
    const calendar = getCalendarClient();
    const iniciodia = new Date(`${fecha}T00:00:00`);
    const findi = new Date(`${fecha}T23:59:59`);

    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: iniciodia.toISOString(),
      timeMax: findi.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventosOcupados = data.items || [];
    console.log(`[disponibilidad] Eventos encontrados: ${eventosOcupados.length}`);

    const todosSlots = generarSlots(fecha);
    console.log(`[disponibilidad] Slots generados: ${todosSlots.length}`);

    const slots = todosSlots.map(slot => {
      const ocupado = eventosOcupados.some(ev => {
        const evInicio = new Date(ev.start.dateTime);
        const evFin = new Date(ev.end.dateTime);
        return slot.inicio < evFin && slot.fin > evInicio;
      });
      return { hora: slot.hora, disponible: !ocupado };
    });

    res.json({ fecha, slots });
  } catch (err) {
    console.error('[disponibilidad] ERROR:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
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

  try {
    const calendar = getCalendarClient();
    const inicio = new Date(`${fecha}T${hora}:00`);
    const fin = new Date(inicio.getTime() + SLOT_DURATION * 60000);

    // Verificar que el slot sigue libre
    const { data: check } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: inicio.toISOString(),
      timeMax: fin.toISOString(),
      singleEvents: true,
    });

    if (check.items && check.items.length > 0) {
      return res.status(409).json({ error: 'Ese horario ya no está disponible' });
    }

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: {
        summary: `${svc.nombre} — ${nombre}`,
        description: `Servicio: ${svc.nombre} (${svc.precio})\nTeléfono: ${telefono}${email ? '\nEmail: ' + email : ''}`,
        start: { dateTime: inicio.toISOString(), timeZone: TIMEZONE },
        end:   { dateTime: fin.toISOString(),   timeZone: TIMEZONE },
        attendees: email ? [{ email }] : [],
      },
    });

    res.json({ ok: true, mensaje: `Reserva confirmada: ${svc.nombre} el ${fecha} a las ${hora}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la reserva' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
