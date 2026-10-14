const express = require('express');
const PDFDocument = require('pdfkit');
const pool = require('../db');
const { verificarToken } = require('../middlewares/auth.middleware');
const { actualizarReservas } = require('../utils/reservas');

const router = express.Router();
const METODOS_VALIDOS = ['Nequi', 'Daviplata', 'Tarjeta', 'PSE'];
const idValido = (id) => /^\d+$/.test(String(id)) && Number(id) <= 2147483647;

const fmt = (n) => '$' + Number(n).toLocaleString('es-CO');

// POST /api/pagos -> inicia el pago de una reserva. El monto sale de la reserva, NO del cliente.
router.post('/', verificarToken, async (req, res) => {
  const { reserva_id, metodo_pago } = req.body;
  if (!reserva_id || !metodo_pago) {
    return res.status(400).json({ error: 'reserva_id y metodo_pago son obligatorios' });
  }
  if (!METODOS_VALIDOS.includes(metodo_pago)) {
    return res.status(400).json({ error: 'Método de pago no válido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await actualizarReservas(client);

    const reservaResult = await client.query(
      'SELECT * FROM reservas WHERE id = $1 AND conductor_id = $2 FOR UPDATE',
      [reserva_id, req.usuario.id]
    );
    if (reservaResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reserva no encontrada o no te pertenece' });
    }
    const reserva = reservaResult.rows[0];

    if (!['pendiente', 'en_proceso'].includes(reserva.estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: reserva.estado === 'cancelada'
          ? 'La reserva expiró o fue cancelada. Crea una nueva.'
          : `Esta reserva no se puede pagar (estado: ${reserva.estado})`,
      });
    }

    // Si ya hay un pago sin completar, se reutiliza (solo cambia el método)
    const existente = await client.query(
      `SELECT id FROM pagos WHERE reserva_id = $1 AND estado IN ('pendiente', 'en_proceso') ORDER BY id DESC LIMIT 1`,
      [reserva_id]
    );

    let pago;
    if (existente.rows.length > 0) {
      const upd = await client.query(
        'UPDATE pagos SET metodo_pago = $1 WHERE id = $2 RETURNING *',
        [metodo_pago, existente.rows[0].id]
      );
      pago = upd.rows[0];
    } else {
      const ins = await client.query(
        `INSERT INTO pagos (reserva_id, metodo_pago, monto, estado) VALUES ($1, $2, $3, 'pendiente') RETURNING *`,
        [reserva_id, metodo_pago, reserva.total]
      );
      pago = ins.rows[0];
    }

    await client.query(`UPDATE reservas SET estado = 'en_proceso' WHERE id = $1`, [reserva_id]);
    await client.query('COMMIT');
    res.status(201).json(pago);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el pago' });
  } finally {
    client.release();
  }
});

// PUT /api/pagos/:id/confirmar -> confirma el pago (SIMULADO: aquí luego irá la pasarela real)
router.put('/:id/confirmar', verificarToken, async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await actualizarReservas(client);

    const pagoResult = await client.query(
      `SELECT p.*, r.conductor_id, r.estado AS reserva_estado, r.fecha_inicio, r.fecha_fin,
              e.arrendador_id, e.titulo AS espacio_titulo
       FROM pagos p
       JOIN reservas r ON r.id = p.reserva_id
       JOIN espacios_parqueo e ON e.id = r.espacio_id
       WHERE p.id = $1
       FOR UPDATE OF p, r`,
      [id]
    );
    if (pagoResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pago no encontrado' });
    }
    const pago = pagoResult.rows[0];

    if (pago.conductor_id !== req.usuario.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Este pago no te pertenece' });
    }
    if (pago.estado === 'completado') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este pago ya fue confirmado' });
    }
    if (pago.estado === 'fallido' || !['pendiente', 'en_proceso'].includes(pago.reserva_estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La reserva expiró o fue cancelada. El pago no se puede completar.' });
    }

    const actualizado = await client.query(
      `UPDATE pagos SET estado = 'completado', fecha_pago = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    await client.query(`UPDATE reservas SET estado = 'confirmada' WHERE id = $1`, [pago.reserva_id]);

    await client.query(
      `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'reserva_confirmada', $2)`,
      [pago.conductor_id, `Pago de ${fmt(pago.monto)} recibido. Tu reserva en "${pago.espacio_titulo}" está confirmada.`]
    );
    await client.query(
      `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'nueva_reserva', $2)`,
      [pago.arrendador_id, `Tienes una nueva reserva confirmada en tu espacio "${pago.espacio_titulo}".`]
    );

    await client.query('COMMIT');
    res.json(actualizado.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al confirmar el pago' });
  } finally {
    client.release();
  }
});

// GET /api/pagos/:id/comprobante -> PDF descargable (solo el conductor dueño del pago, o staff)
router.get('/:id/comprobante', verificarToken, async (req, res) => {
  const { id } = req.params;
  if (!idValido(id)) return res.status(404).json({ error: 'Comprobante no encontrado' });

  try {
    const r = await pool.query(
      `SELECT p.*, r.fecha_inicio, r.fecha_fin, r.subtotal, r.comision, r.total, r.conductor_id,
              e.titulo AS espacio_titulo, e.direccion AS espacio_direccion,
              u.nombre AS conductor_nombre, u.correo AS conductor_correo
       FROM pagos p
       JOIN reservas r ON r.id = p.reserva_id
       JOIN espacios_parqueo e ON e.id = r.espacio_id
       JOIN usuarios u ON u.id = r.conductor_id
       WHERE p.id = $1`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Comprobante no encontrado' });
    const pago = r.rows[0];

    const esStaff = ['administrador', 'soporte'].includes(req.usuario.rol);
    if (pago.conductor_id !== req.usuario.id && !esStaff) {
      return res.status(403).json({ error: 'Este comprobante no te pertenece' });
    }
    if (pago.estado !== 'completado') {
      return res.status(400).json({ error: 'Solo hay comprobante para pagos completados' });
    }

    const dinero = (n) => '$' + Number(n).toLocaleString('es-CO');
    const fecha = (f) => new Date(f).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="comprobante-migo-park-${pago.id}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).fillColor('#2E9E4F').text('Migo Park', { align: 'left' });
    doc.fontSize(12).fillColor('#111111').text('Comprobante de pago', { align: 'left' });
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dddddd').stroke();
    doc.moveDown(1);

    const fila = (etiqueta, valor) => {
      doc.fontSize(10).fillColor('#555555').text(etiqueta, 50, doc.y, { continued: true, width: 180 });
      doc.fontSize(11).fillColor('#111111').text(valor || '-');
      doc.moveDown(0.4);
    };

    fila('N° de comprobante:', String(pago.id));
    fila('Fecha de pago:', fecha(pago.fecha_pago));
    fila('Método de pago:', pago.metodo_pago);
    fila('Estado:', 'Completado');
    doc.moveDown(0.6);

    doc.fontSize(13).fillColor('#2E9E4F').text('Detalle de la reserva');
    doc.moveDown(0.3);
    fila('Espacio:', pago.espacio_titulo);
    fila('Dirección:', pago.espacio_direccion);
    fila('Inicio:', fecha(pago.fecha_inicio));
    fila('Fin:', fecha(pago.fecha_fin));
    doc.moveDown(0.6);

    doc.fontSize(13).fillColor('#2E9E4F').text('Montos');
    doc.moveDown(0.3);
    fila('Subtotal:', dinero(pago.subtotal));
    fila('Comisión de servicio:', dinero(pago.comision));
    doc.fontSize(12).fillColor('#111111').text(`Total pagado: ${dinero(pago.monto)}`, 50, doc.y, { underline: false });
    doc.moveDown(0.8);

    doc.fontSize(13).fillColor('#2E9E4F').text('Cliente');
    doc.moveDown(0.3);
    fila('Nombre:', pago.conductor_nombre);
    fila('Correo:', pago.conductor_correo);

    doc.moveDown(1.5);
    doc.fontSize(9).fillColor('#999999').text(
      'Este comprobante fue generado automáticamente por Migo Park y no requiere firma.',
      { align: 'center' }
    );

    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar el comprobante' });
  }
});

module.exports = router;