// Funciones compartidas entre las rutas de reservas y pagos

const MINUTOS_PARA_PAGAR = 15;

// ---------------------------------------------------------------
// Comisión de Migo Park: se le cobra al ARRENDADOR sobre lo que gana.
// El conductor paga solo el precio del espacio (total = subtotal).
// ---------------------------------------------------------------
const COMISION_PORCENTAJE = 0.10;

// Comisión que se descuenta al arrendador en una reserva.
// Reservas antiguas (hechas cuando la comisión se sumaba al conductor): total > subtotal -> el arrendador no paga comisión.
function comisionDelArrendador(reserva) {
  const subtotal = Number(reserva.subtotal || 0);
  const total = Number(reserva.total || 0);
  const comision = Number(reserva.comision || 0);
  return total > subtotal ? 0 : comision;
}

// ---------------------------------------------------------------
// Tarifas: se puede arrendar un espacio por hora, por día o por mes
// ---------------------------------------------------------------
const TIPOS_TARIFA = ['hora', 'dia', 'mes'];

// Límites por reserva según la tarifa:
//   hasta 8 horas -> por hora | de ahí en adelante -> por día (hasta 14 días) | más de 14 días -> por mes
const LIMITES_TARIFA = {
  hora: { min: 1, max: 8,  unidad: 'horas',  masTiempo: 'Para más tiempo reserva por día.' },
  dia:  { min: 1, max: 14, unidad: 'días',   masTiempo: 'Para más tiempo reserva por mes.' },
  mes:  { min: 1, max: 12, unidad: 'meses',  masTiempo: '' },
};

// ---------------------------------------------------------------
// Cancelación de reservas pagadas
//   - Solo se puede cancelar ANTES de que empiece la reserva.
//   - Con 1 hora o más de anticipación se pide el reembolso del 100% del pago.
//   - Para pedirlo hace falta una justificación válida: el reembolso queda PENDIENTE
//     hasta que administrador o soporte lo autoricen (o lo rechacen).
//   - Con menos de 1 hora (y antes de empezar) se cancela sin reembolso y sin justificación.
// ---------------------------------------------------------------
const HORAS_MIN_REEMBOLSO = 1;
const MOTIVO_MIN_CARACTERES = 15;
const MOTIVO_MIN_PALABRAS = 3;
const MOTIVO_MAX_CARACTERES = 500;

// Revisa la justificación: { ok: true, motivo } o { ok: false, error }
function validarMotivoCancelacion(texto) {
  const motivo = String(texto || '').replace(/\s+/g, ' ').trim();
  if (motivo.length < MOTIVO_MIN_CARACTERES || motivo.split(' ').length < MOTIVO_MIN_PALABRAS) {
    return {
      ok: false,
      error: `Escribe una justificación válida para tu reembolso (mínimo ${MOTIVO_MIN_CARACTERES} caracteres y ${MOTIVO_MIN_PALABRAS} palabras).`,
    };
  }
  if (motivo.length > MOTIVO_MAX_CARACTERES) {
    return { ok: false, error: `La justificación no puede superar los ${MOTIVO_MAX_CARACTERES} caracteres.` };
  }
  return { ok: true, motivo };
}

// Suma meses de calendario sin desbordar (31 ene + 1 mes = 28/29 feb, no 3 mar)
function sumarMeses(fecha, meses) {
  const d = new Date(fecha);
  const dia = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + meses);
  const ultimoDia = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dia, ultimoDia));
  return d;
}

// Fin de una reserva por día o por mes a partir del inicio y la cantidad de unidades
function calcularFin(inicio, tipo, cantidad) {
  if (tipo === 'dia') {
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + cantidad);
    return fin;
  }
  if (tipo === 'mes') return sumarMeses(inicio, cantidad);
  return null;
}

// Precio unitario del espacio para una tarifa (null si el arrendador no la ofrece)
function precioUnitario(espacio, tipo) {
  const campo = { hora: 'precio_hora', dia: 'precio_dia', mes: 'precio_mes' }[tipo];
  const valor = campo ? Number(espacio[campo]) : NaN;
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

// Lee un precio opcional (día/mes) que viene del formulario.
// Vacío -> null (no ofrece esa tarifa) | número > 0 -> ese número | otra cosa -> NaN (inválido)
function leerPrecioOpcional(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

// 1) Cancela las reservas que no se pagaron a tiempo (y marca su pago como fallido)
// 2) Marca como "completada" las reservas confirmadas cuyo horario ya terminó
async function actualizarReservas(db) {
  await db.query(
    `WITH vencidas AS (
       UPDATE reservas
       SET estado = 'cancelada', fecha_cancelacion = NOW()
       WHERE estado IN ('pendiente', 'en_proceso')
         AND fecha_creacion < NOW() - make_interval(mins => $1::int)
       RETURNING id
     )
     UPDATE pagos SET estado = 'fallido'
     WHERE estado IN ('pendiente', 'en_proceso')
       AND reserva_id IN (SELECT id FROM vencidas)`,
    [MINUTOS_PARA_PAGAR]
  );

  await db.query(
    `UPDATE reservas SET estado = 'completada'
     WHERE estado = 'confirmada' AND fecha_fin < NOW()`
  );
}

module.exports = {
  MINUTOS_PARA_PAGAR,
  COMISION_PORCENTAJE,
  HORAS_MIN_REEMBOLSO,
  validarMotivoCancelacion,
  comisionDelArrendador,
  TIPOS_TARIFA,
  LIMITES_TARIFA,
  sumarMeses,
  calcularFin,
  precioUnitario,
  leerPrecioOpcional,
  actualizarReservas,
};