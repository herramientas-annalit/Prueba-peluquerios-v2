const SERVICIOS = {
  corte:       { nombre: 'Corte',         precio: '15 €' },
  barba:       { nombre: 'Barba',         precio: '10 €' },
  corte_barba: { nombre: 'Corte + Barba', precio: '22 €' },
};

const estado = {
  servicio: null,
  fecha: null,
  hora: null,
};

let calMes = new Date();

// ===== STEP 1: SERVICIO =====
function seleccionarServicio(svc) {
  estado.servicio = svc;
  document.querySelectorAll('#panel1 .service-card').forEach(el => el.classList.remove('selected'));
  document.getElementById(`svc-${svc}`).classList.add('selected');
  document.getElementById('btn1').disabled = false;
}

// ===== STEP 2: CALENDARIO =====
function renderCalendario() {
  const cal = document.getElementById('calendar');
  const year = calMes.getFullYear();
  const month = calMes.getMonth();
  const today = new Date();
  const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const dayNames = ['Lu','Ma','Mi','Ju','Vi','Sá','Do'];
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7; // lunes primero
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = `
    <div class="cal-header">
      <button class="cal-nav" onclick="cambiarMes(-1)">&#8592;</button>
      <span class="cal-title">${monthNames[month]} ${year}</span>
      <button class="cal-nav" onclick="cambiarMes(1)">&#8594;</button>
    </div>
    <div class="cal-grid">
      ${dayNames.map(d => `<div class="cal-day-name">${d}</div>`).join('')}
      ${Array(firstDay).fill('<div class="cal-day empty"></div>').join('')}
  `;

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const isPast = date < new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const isToday = date.toDateString() === today.toDateString();
    const isSelected = estado.fecha === `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const disabled = isPast || isWeekend;

    let cls = 'cal-day';
    if (disabled) cls += ' disabled';
    else cls += ' has-slots';
    if (isToday) cls += ' today';
    if (isSelected) cls += ' selected';

    const click = !disabled ? `onclick="seleccionarFecha(${year},${month},${d})"` : '';
    html += `<div class="${cls}" ${click}>${d}</div>`;
  }

  html += '</div>';
  cal.innerHTML = html;
}

function cambiarMes(dir) {
  calMes = new Date(calMes.getFullYear(), calMes.getMonth() + dir, 1);
  renderCalendario();
}

function seleccionarFecha(year, month, day) {
  estado.fecha = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  estado.hora = null;
  document.getElementById('btn2').disabled = false;
  document.getElementById('btn3').disabled = true;
  renderCalendario();
}

// ===== STEP 3: HORAS =====
async function cargarHoras() {
  irA(3);
  const fecha = estado.fecha;
  const dateObj = new Date(fecha + 'T12:00:00');
  const fechaStr = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('slotsFecha').textContent = `Disponibilidad para el ${fechaStr}`;

  const container = document.getElementById('timeSlots');
  container.innerHTML = '<div class="slots-loading">Cargando disponibilidad...</div>';
  document.getElementById('btn3').disabled = true;

  try {
    const res = await fetch(`/api/disponibilidad?fecha=${fecha}`);
    const data = await res.json();

    if (!data.slots || data.slots.length === 0) {
      container.innerHTML = '<p class="slots-empty">No hay turnos disponibles para este día.</p>';
      return;
    }

    container.innerHTML = data.slots.map(slot => `
      <div class="time-slot ${!slot.disponible ? 'taken' : ''}"
           id="ts-${slot.hora.replace(':','-')}"
           ${slot.disponible ? `onclick="seleccionarHora('${slot.hora}')"` : ''}>
        ${slot.hora}${!slot.disponible ? '<span class="taken-label">Ocupado</span>' : ''}
      </div>
    `).join('');
  } catch {
    container.innerHTML = '<p class="slots-empty">Error al cargar horarios. Inténtalo de nuevo.</p>';
  }
}

function seleccionarHora(hora) {
  estado.hora = hora;
  document.querySelectorAll('.time-slot').forEach(el => el.classList.remove('selected'));
  document.getElementById(`ts-${hora.replace(':','-')}`).classList.add('selected');
  document.getElementById('btn3').disabled = false;
}

// ===== STEP 4: CONFIRMAR =====
function mostrarConfirmacion() {
  const svc = SERVICIOS[estado.servicio];
  const dateObj = new Date(estado.fecha + 'T12:00:00');
  const fechaStr = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('confirmCard').innerHTML = `
    <div class="confirm-row"><span class="confirm-label">Servicio</span><span class="confirm-value">${svc.nombre}</span></div>
    <div class="confirm-row"><span class="confirm-label">Fecha</span><span class="confirm-value">${fechaStr}</span></div>
    <div class="confirm-row"><span class="confirm-label">Hora</span><span class="confirm-value">🕐 ${estado.hora}</span></div>
    <div class="confirm-row"><span class="confirm-label">Precio</span><span class="confirm-value">${svc.precio}</span></div>
  `;
}

async function confirmarReserva() {
  const nombre = document.getElementById('clientName').value.trim();
  const telefono = document.getElementById('clientPhone').value.trim();
  const email = document.getElementById('clientEmail').value.trim();

  if (!nombre || !telefono) {
    alert('Por favor, rellena tu nombre y teléfono.');
    return;
  }

  const btn = document.querySelector('#panel4 .btn-success');
  btn.textContent = 'Reservando...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/reservar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fecha: estado.fecha,
        hora: estado.hora,
        servicio: estado.servicio,
        nombre,
        telefono,
        email,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'Error al realizar la reserva.');
      btn.textContent = 'Confirmar reserva';
      btn.disabled = false;
      return;
    }

    const svc = SERVICIOS[estado.servicio];
    const dateObj = new Date(estado.fecha + 'T12:00:00');
    const fechaStr = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    document.getElementById('modalSummary').innerHTML =
      `<strong>${svc.nombre}</strong><br>📅 ${fechaStr} a las 🕐 ${estado.hora}<br>para <strong>${nombre}</strong>`;
    document.getElementById('successModal').classList.remove('hidden');

  } catch {
    alert('Error de conexión. Inténtalo de nuevo.');
    btn.textContent = 'Confirmar reserva';
    btn.disabled = false;
  }
}

// ===== NAVEGACIÓN STEPPER =====
function irA(paso) {
  for (let i = 1; i <= 4; i++) {
    document.getElementById(`panel${i}`).classList.toggle('hidden', i !== paso);
    const step = document.getElementById(`step${i}`);
    step.classList.remove('active', 'done');
    if (i === paso) step.classList.add('active');
    else if (i < paso) step.classList.add('done');
  }
  if (paso === 2) renderCalendario();
  if (paso === 4) mostrarConfirmacion();
  document.getElementById('reserva').scrollIntoView({ behavior: 'smooth' });
}

function resetear() {
  estado.servicio = null;
  estado.fecha = null;
  estado.hora = null;
  document.getElementById('successModal').classList.add('hidden');
  document.getElementById('clientName').value = '';
  document.getElementById('clientPhone').value = '';
  document.getElementById('clientEmail').value = '';
  document.getElementById('btn1').disabled = true;
  document.getElementById('btn2').disabled = true;
  document.getElementById('btn3').disabled = true;
  document.querySelectorAll('.service-card').forEach(el => el.classList.remove('selected'));
  irA(1);
}
