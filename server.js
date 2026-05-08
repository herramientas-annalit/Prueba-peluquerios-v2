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

const SERVICIOS = {
  corte:       { nombre: 'Corte',         precio: '15 €' },
  barba:       { nombre: 'Barba',         precio: '10 €' },
  corte_barba: { nombre: 'Corte + Barba', precio: '22 €' },
};

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  },
});

// GET /api/disponibilidad?fecha=2026-05-10
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta el parámetro fecha' });

  console.log(`[disponibilidad] Consultando fecha: ${fecha}`);

  try {
    // GHL espera timestamps en milisegundos
    const startMs = new Date(`${fecha}T00:00:00`).getTime();
    const endMs   = new Date(`${fecha}T23:59:59`).getTime();

    const { data } = await ghl.get(`/calendars/${GHL_CALENDAR_ID}/free-slots`, {
      params: {
        startDate: startMs,
        endDate:   endMs,
        timezone:  TIMEZONE,
      },
    });

    console.log(`[disponibilidad] Respuesta GHL:`, JSON.stringify(data).slice(0, 300));

    // GHL devuelve { [fecha]: { slots: [{ startTime, endTime }] } }
    const diaData = data[fecha] || data[Object.keys(data)[0]] || {};
    const slotsGHL = diaData.slots || [];

    const slots = slotsGHL.map(slot => {
      // startTime viene como "2026-05-10T09:00:00+02:00" o similar
      const horaLocal = new Date(slot.startTime)
        .toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
      return { hora: horaLocal, disponible: true };
    });

    res.json({ fecha, slots });
  } catch (err) {
    console.error('[disponibilidad] ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
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
    // 1. Buscar o crear contacto en GHL
    let contactId;

    const busqueda = await ghl.get('/contacts/search/duplicate', {
      params: { locationId: GHL_LOCATION_ID, phone: telefono },
    });

    if (busqueda.data?.contact?.id) {
      contactId = busqueda.data.contact.id;
      console.log(`[reservar] Contacto existente: ${contactId}`);
    } else {
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
    }

    if (!contactId) throw new Error('No se pudo obtener el contacto de GHL');

    // 2. Crear la cita en GHL
    const inicioISO = new Date(`${fecha}T${hora}:00`).toISOString();
    const finISO    = new Date(new Date(`${fecha}T${hora}:00`).getTime() + SLOT_DURATION * 60000).toISOString();

    const cita = await ghl.post('/calendars/events/appointments', {
      calendarId:  GHL_CALENDAR_ID,
      locationId:  GHL_LOCATION_ID,
      contactId,
      startTime:   inicioISO,
      endTime:     finISO,
      title:       `${svc.nombre} — ${nombre}`,
      appointmentStatus: 'confirmed',
      ignoreDateRange: false,
      toNotify: true,
      notes: `Servicio: ${svc.nombre} (${svc.precio})\nTeléfono: ${telefono}${email ? '\nEmail: ' + email : ''}`,
    });

    console.log(`[reservar] Cita creada: ${cita.data?.id}`);

    res.json({ ok: true, mensaje: `Reserva confirmada: ${svc.nombre} el ${fecha} a las ${hora}` });
  } catch (err) {
    console.error('[reservar] ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
