const express = require('express');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middlewares/auth.middleware');
const {
  MINUTOS_PARA_PAGAR,
  COMISION_PORCENTAJE,
  HORAS_MIN_REEMBOLSO,
  validarMotivoCancelacion,
  TIPOS_TARIFA,
  LIMITES_TARIFA,
  calcularFin,
  precioUnitario,
  actualizarReservas,
} = require('../utils/reservas');

const router = express.Router();

const REQUIERE_VEHICULO_VERIFICADO = false;   // pon true si quieres exigir una placa verificada para reservar

const fmt = (n) => '$' + Number(n).toLocaleString('es-CO');

// POST /api/reservas -> crea una reserva (queda pendiente de pago por 15 minutos)
//   tipo_tarifa = 'hora' -> envía fecha_inicio y fecha_fin (se cobra por las horas reservadas)
//   tipo_tarifa = 'dia'  -> envía fecha_inicio y cantidad (días); el fin se calcula en el servidor
//   tipo_tarifa = 'mes'  -> envía fecha_inicio y cantidad (meses); el fin se calcula en el servidor
//   Si no se envía tipo_tarifa se asume 'hora' (compatible con la versión anterior).
router.post('/', verificarToken, requiereRol('cliente'), async (req, res) => {
  const { espacio_id, fecha_inicio, fecha_fin } = req.body;
  const tipoTarifa = req.body.tipo_tarifa || 'hora';

  if (!TIPOS_TARIFA.includes(tipoTarifa)) {
    return res.status(400).json({ error: 'Tarifa no válida. Usa hora, dia o mes' });
  }
  if (!espacio_id || !fecha_inicio) {
    return res.status(400).json({ error: 'espacio_id y fecha_inicio son obligatorios' });
  }
  if (tipoTarifa === 'hora' && !fecha_fin) {
    return res.status(400).json({ error: 'fecha_fin es obligatoria para la tarifa por hora' });
  }

  const inicio = new Date(fecha_inicio);
  if (Number.isNaN(inicio.getTime())) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }
  if (inicio < new Date(Date.now() - 60 * 1000)) {
    return res.status(400).json({ error: 'La fecha de inicio no puede estar en el pasado' });
  }

  const limites = LIMITES_TARIFA[tipoTarifa];
  let fin;
  let cantidad = null;      // días o meses (NULL en tarifa por hora)
  let unidades;             // horas, días o meses: lo que se multiplica por el precio

  if (tipoTarifa === 'hora') {
    fin = new Date(fecha_fin);
    if (Number.isNaN(fin.getTime()) || fin <= inicio) {
      return res.status(400).json({ error: 'Fechas inválidas' });
    }
    unidades = (fin - inicio) / (1000 * 60 * 60);
    if (unidades < limites.min) return res.status(400).json({ error: 'La reserva mínima es de 1 hora' });
    if (unidades > limites.max) {
      return res.status(400).json({
        error: `Por hora se puede reservar máximo ${limites.max} horas. ${limites.masTiempo}`,
      });
    }
  } else {
    cantidad = Number(req.body.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < limites.min || cantidad > limites.max) {
      const sePasa = Number.isInteger(cantidad) && cantidad > limites.max && limites.masTiempo;
      return res.status(400).json({
        error: sePasa
          ? `Por ${tipoTarifa === 'dia' ? 'día' : 'mes'} se puede reservar máximo ${limites.max} ${limites.unidad}. ${limites.masTiempo}`
          : `La cantidad de ${limites.unidad} debe ser un número entero entre ${limites.min} y ${limites.max}`,
      });
    }
    fin = calcularFin(inicio, tipoTarifa, cantidad);
    unidades = cantidad;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await actualizarReservas(client);

    // FOR UPDATE bloquea el espacio: dos personas no pueden reservar el mismo horario a la vez
    const espacioResult = await client.query(
      `SELECT * FROM espacios_parqueo
       WHERE id = $1 AND verificado = TRUE AND estado = 'disponible' FOR UPDATE`,
      [espacio_id]
    );
    if (espacioResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Espacio no encontrado, no verificado o no disponible' });
    }
    const espacio = espacioResult.rows[0];

    if (espacio.arrendador_id === req.usuario.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No puedes reservar tu propio espacio' });
    }

    if (REQUIERE_VEHICULO_VERIFICADO) {
      const veh = await client.query(
        'SELECT 1 FROM vehiculos WHERE conductor_id = $1 AND verificado = TRUE LIMIT 1',
        [req.usuario.id]
      );
      if (veh.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Necesitas al menos un vehículo verificado para reservar' });
      }
    }

    // El arrendador debe ofrecer esa tarifa (la de hora siempre existe; día y mes son opcionales)
    const precioBase = precioUnitario(espacio, tipoTarifa);
    if (precioBase === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: tipoTarifa === 'dia'
          ? 'Este espacio no se arrienda por día'
          : tipoTarifa === 'mes'
            ? 'Este espacio no se arrienda por mes'
            : 'Este espacio no tiene precio por hora',
      });
    }

    // Días bloqueados por el arrendador en el calendario de disponibilidad
    const bloqueado = await client.query(
      `SELECT 1 FROM disponibilidad_espacio
       WHERE espacio_id = $1 AND habilitado = FALSE AND fecha BETWEEN $2::date AND $3::date LIMIT 1`,
      [espacio_id, inicio, fin]
    );
    if (bloqueado.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'El arrendador bloqueó alguno de esos días' });
    }

    // Cruce de horarios con otras reservas activas
    const cruce = await client.query(
      `SELECT 1 FROM reservas
       WHERE espacio_id = $1
         AND estado IN ('pendiente', 'en_proceso', 'confirmada')
         AND $2 < fecha_fin AND $3 > fecha_inicio
       LIMIT 1`,
      [espacio_id, inicio, fin]
    );
    if (cruce.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario ya está reservado. Elige otro.' });
    }

    // El precio SIEMPRE se calcula en el servidor:
    //   hora -> horas * precio_hora | dia -> días * precio_dia | mes -> meses * precio_mes
    // El conductor paga SOLO el precio del espacio (total = subtotal).
    // La comisión de Migo Park (10%) se descuenta del dinero que gana el arrendador.
    const subtotal = Number((unidades * precioBase).toFixed(2));
    const comision = Number((subtotal * COMISION_PORCENTAJE).toFixed(2));
    const total = subtotal;

    const resultado = await client.query(
      `INSERT INTO reservas (espacio_id, conductor_id, fecha_inicio, fecha_fin, subtotal, comision, total, tipo_tarifa, cantidad)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *, $10::int * 60 AS segundos_restantes`,
      [espacio_id, req.usuario.id, inicio, fin, subtotal, comision, total, tipoTarifa, cantidad, MINUTOS_PARA_PAGAR]
    );

    await client.query('COMMIT');
    res.status(201).json(resultado.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al crear la reserva' });
  } finally {
    client.release();
  }
});

// GET /api/reservas/mias -> historial del usuario, con estado del pago y tiempo restante para pagar
router.get('/mias', verificarToken, async (req, res) => {
  try {
    await actualizarReservas(pool);
    const resultado = await pool.query(
      `SELECT r.*,
              e.titulo AS espacio_titulo,
              e.direccion AS espacio_direccion,
              p.id AS pago_id,
              p.estado AS pago_estado,
              p.metodo_pago,
              (c.id IS NOT NULL) AS ya_calificada,
              CASE WHEN r.estado IN ('pendiente', 'en_proceso')
                   THEN GREATEST(0, EXTRACT(EPOCH FROM
                          (r.fecha_creacion + make_interval(mins => $2::int) - NOW()))::int)
              END AS segundos_restantes
       FROM reservas r
       JOIN espacios_parqueo e ON e.id = r.espacio_id
       LEFT JOIN LATERAL (
         SELECT id, estado, metodo_pago FROM pagos WHERE reserva_id = r.id ORDER BY id DESC LIMIT 1
       ) p ON TRUE
       LEFT JOIN calificaciones c ON c.reserva_id = r.id
       WHERE r.conductor_id = $1
       ORDER BY r.fecha_creacion DESC`,
      [req.usuario.id, MINUTOS_PARA_PAGAR]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar tus reservas' });
  }
});

// GET /api/reservas/espacio/:id/ocupado -> horarios ya tomados de un espacio (no expone datos de personas)
router.get('/espacio/:id/ocupado', verificarToken, async (req, res) => {
  try {
    await actualizarReservas(pool);
    const resultado = await pool.query(
      `SELECT fecha_inicio, fecha_fin FROM reservas
       WHERE espacio_id = $1
         AND estado IN ('pendiente', 'en_proceso', 'confirmada')
         AND fecha_fin > NOW()
       ORDER BY fecha_inicio ASC`,
      [req.params.id]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los horarios ocupados' });
  }
});

// PUT /api/reservas/:id/cancelar -> el conductor cancela su reserva y se calcula el reembolso
//   Solo se puede cancelar ANTES de que empiece la reserva (si ya empezó, no se puede).
//   Sin pagar: se cancela sin reembolso (no hay nada que devolver) y no pide justificación.
//   Pagada, 1 hora o más antes del inicio: pide el reembolso del 100%. Exige una justificación válida
//           (body: { motivo }) y el reembolso queda PENDIENTE hasta que administrador o soporte lo autoricen.
//   Pagada, menos de 1 hora antes del inicio: se cancela sin reembolso y sin justificación.
router.put('/:id/cancelar', verificarToken, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await actualizarReservas(client);

    const r = await client.query(
      `SELECT r.*, e.arrendador_id, e.titulo AS espacio_titulo
       FROM reservas r JOIN espacios_parqueo e ON e.id = r.espacio_id
       WHERE r.id = $1 AND r.conductor_id = $2 FOR UPDATE OF r`,
      [id, req.usuario.id]
    );
    if (r.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reserva no encontrada o no te pertenece' });
    }
    const reserva = r.rows[0];

    if (!['pendiente', 'en_proceso', 'confirmada'].includes(reserva.estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Esta reserva ya está ${reserva.estado}` });
    }

    // Solo se puede cancelar antes de que empiece la reserva
    const horasParaInicio = (new Date(reserva.fecha_inicio) - new Date()) / (1000 * 60 * 60);
    if (horasParaInicio <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No puedes cancelar una reserva que ya empezó. Solo se puede cancelar antes de la hora de inicio.' });
    }

    // Reserva pagada: SOLO se puede cancelar hasta 1 hora antes de que empiece
    if (reserva.estado === 'confirmada' && horasParaInicio < HORAS_MIN_REEMBOLSO) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Solo puedes cancelar hasta 1 hora antes de que empiece la reserva.' });
    }

    let porcentaje = 0;
    let motivo = null;
    let estadoReembolso = 'ninguno';
    if (reserva.estado === 'confirmada') {
      // El descuento (reembolso) SIEMPRE se aplica: 100%, automático y simulado (no es un pago real).
      // La justificación ya no es obligatoria; si llega se guarda.
      motivo = String((req.body && req.body.motivo) || '').replace(/\s+/g, ' ').trim().slice(0, 500)
        || 'Cancelación solicitada por el conductor';
      porcentaje = 100;
      estadoReembolso = 'aprobado';
    }
    const reembolso = Number((Number(reserva.total) * porcentaje / 100).toFixed(2));

    const actualizada = await client.query(
      `UPDATE reservas SET estado = 'cancelada', monto_reembolso = $1, fecha_cancelacion = NOW(),
                           motivo_cancelacion = $3, estado_reembolso = $4
       WHERE id = $2 RETURNING *`,
      [reembolso, id, motivo, estadoReembolso]
    );
    // Si había un pago sin completar, queda como fallido
    await client.query(
      `UPDATE pagos SET estado = 'fallido' WHERE reserva_id = $1 AND estado IN ('pendiente', 'en_proceso')`,
      [id]
    );

    // Notificaciones (las tablas ya existen; la pantalla de notificaciones viene después)
    const msgCliente = reserva.estado !== 'confirmada'
      ? `Cancelaste tu reserva pendiente en "${reserva.espacio_titulo}".`
      : `Cancelaste tu reserva en "${reserva.espacio_titulo}". Se te descontaron/devolvieron ${fmt(reembolso)} (reembolso del 100%).`;
    await client.query(
      `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'reserva_cancelada', $2)`,
      [req.usuario.id, msgCliente]
    );
    if (reserva.estado === 'confirmada') {
      await client.query(
        `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'reserva_cancelada', $2)`,
        [reserva.arrendador_id, `Se canceló una reserva en tu espacio "${reserva.espacio_titulo}".`]
      );

      // La solicitud de reembolso (con su justificación) se envía al equipo de administración y soporte
      if (estadoReembolso === 'pendiente') {
        const quien = await client.query('SELECT nombre FROM usuarios WHERE id = $1', [req.usuario.id]);
        const nombreConductor = quien.rows[0] ? quien.rows[0].nombre : 'Un conductor';
        await client.query(
          `INSERT INTO notificaciones (usuario_id, tipo, mensaje)
           SELECT id, 'reembolso_pendiente', $1 FROM usuarios
           WHERE rol IN ('administrador', 'soporte') AND activo = TRUE`,
          [
            `Reembolso por autorizar: reserva #${id} en "${reserva.espacio_titulo}" (conductor: ${nombreConductor}). ` +
            `Monto: ${fmt(reembolso)}. Justificación: "${motivo}"`,
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.json({
      reserva: actualizada.rows[0],
      porcentaje_reembolso: porcentaje,
      monto_reembolso: reembolso,
      estado_reembolso: estadoReembolso,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar la reserva' });
  } finally {
    client.release();
  }
});

// PUT /api/reservas/:id/estado -> uso administrativo
//   Staff: cualquier estado | Arrendador: solo marcar "completada" | Conductor: NO (usa /cancelar)
router.put('/:id/estado', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  const ESTADOS_VALIDOS = ['pendiente', 'en_proceso', 'confirmada', 'completada', 'cancelada'];
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  try {
    const reservaResult = await pool.query(
      `SELECT r.*, e.arrendador_id FROM reservas r JOIN espacios_parqueo e ON e.id = r.espacio_id WHERE r.id = $1`,
      [id]
    );
    if (reservaResult.rows.length === 0) return res.status(404).json({ error: 'Reserva no encontrada' });

    const reserva = reservaResult.rows[0];
    const esStaff = ['administrador', 'soporte'].includes(req.usuario.rol);
    const esArrendador = reserva.arrendador_id === req.usuario.id;

    if (!esStaff && !(esArrendador && estado === 'completada')) {
      return res.status(403).json({ error: 'No tienes permiso para cambiar el estado de esta reserva' });
    }

    const resultado = await pool.query('UPDATE reservas SET estado = $1 WHERE id = $2 RETURNING *', [estado, id]);
    res.json(resultado.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el estado de la reserva' });
  }
});

module.exports = router;