const express = require('express');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middlewares/auth.middleware');
const { actualizarReservas } = require('../utils/reservas');

const router = express.Router();

const ROLES = ['cliente', 'administrador', 'soporte'];
const ESTADOS_RESERVA = ['pendiente', 'en_proceso', 'confirmada', 'completada', 'cancelada'];

// Convierte lo que escribe el usuario en un patrón seguro para ILIKE
function patron(texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  return '%' + t.replace(/[\\%_]/g, '\\$&') + '%';
}

// GET /api/admin/metricas -> resumen general (solo administrador)
router.get('/metricas', verificarToken, requiereRol('administrador'), async (req, res) => {
  try {
    await actualizarReservas(pool);

    const [usuarios, espacios, reservas, dinero, top, vehiculos] = await Promise.all([
      pool.query(
        `SELECT rol::text AS rol, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE activo)::int AS activos
         FROM usuarios GROUP BY rol`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE verificado)::int AS verificados,
                COUNT(*) FILTER (WHERE NOT verificado AND motivo_rechazo IS NULL)::int AS pendientes,
                COUNT(*) FILTER (WHERE NOT verificado AND motivo_rechazo IS NOT NULL)::int AS rechazados
         FROM espacios_parqueo`
      ),
      pool.query(`SELECT estado::text AS estado, COUNT(*)::int AS total FROM reservas GROUP BY estado`),
      pool.query(
        `SELECT
           COALESCE((SELECT SUM(monto) FROM pagos WHERE estado = 'completado'), 0) AS ingresos_brutos,
           COALESCE((SELECT SUM(comision) FROM reservas WHERE estado IN ('confirmada', 'completada')), 0) AS comisiones,
           COALESCE((SELECT SUM(monto_reembolso) FROM reservas WHERE estado = 'cancelada'), 0) AS reembolsos,
           (SELECT COUNT(*)::int FROM reservas WHERE fecha_creacion >= NOW() - interval '30 days') AS reservas_30_dias`
      ),
      pool.query(
        `SELECT e.id, e.titulo, COUNT(r.id)::int AS reservas
         FROM espacios_parqueo e
         JOIN reservas r ON r.espacio_id = e.id AND r.estado IN ('confirmada', 'completada')
         GROUP BY e.id ORDER BY reservas DESC, e.id LIMIT 5`
      ),
      pool.query(`SELECT COUNT(*) FILTER (WHERE NOT verificado)::int AS pendientes FROM vehiculos`),
    ]);

    res.json({
      usuarios: usuarios.rows,
      espacios: espacios.rows[0],
      vehiculos_pendientes: vehiculos.rows[0].pendientes,
      reservas_por_estado: reservas.rows,
      dinero: dinero.rows[0],
      top_espacios: top.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al calcular las métricas' });
  }
});

// GET /api/admin/usuarios?q=texto&rol=cliente -> lista de usuarios (solo administrador)
router.get('/usuarios', verificarToken, requiereRol('administrador'), async (req, res) => {
  const rol = ROLES.includes(req.query.rol) ? req.query.rol : null;
  try {
    const resultado = await pool.query(
      `SELECT id, nombre, correo, telefono, rol, activo, fecha_registro
       FROM usuarios
       WHERE ($1::text IS NULL OR nombre ILIKE $1 OR correo ILIKE $1)
         AND ($2::text IS NULL OR rol::text = $2)
       ORDER BY fecha_registro DESC
       LIMIT 200`,
      [patron(req.query.q), rol]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar usuarios' });
  }
});

// PUT /api/admin/usuarios/:id/activo  { "activo": false } -> bloquear / desbloquear (solo administrador)
router.put('/usuarios/:id/activo', verificarToken, requiereRol('administrador'), async (req, res) => {
  const { id } = req.params;
  const { activo } = req.body;

  if (typeof activo !== 'boolean') {
    return res.status(400).json({ error: 'El campo "activo" debe ser true o false' });
  }
  if (Number(id) === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes bloquear tu propia cuenta' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE usuarios SET activo = $1 WHERE id = $2 RETURNING id, nombre, correo, rol, activo`,
      [activo, id]
    );
    if (resultado.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(resultado.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el usuario' });
  }
});

// GET /api/admin/reservas?q=&estado=&desde=YYYY-MM-DD&hasta=YYYY-MM-DD (administrador y soporte)
//   q busca en: nombre o correo del conductor, y título del espacio
router.get('/reservas', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  const estado = ESTADOS_RESERVA.includes(req.query.estado) ? req.query.estado : null;
  const fechaOk = (f) => (/^\d{4}-\d{2}-\d{2}$/.test(f || '') ? f : null);
  const desde = fechaOk(req.query.desde);
  const hasta = fechaOk(req.query.hasta);

  try {
    await actualizarReservas(pool);
    const resultado = await pool.query(
      `SELECT r.id, r.estado, r.fecha_inicio, r.fecha_fin, r.subtotal, r.comision, r.total,
              r.monto_reembolso, r.fecha_creacion,
              e.titulo AS espacio_titulo,
              u.nombre AS conductor_nombre, u.correo AS conductor_correo,
              a.nombre AS arrendador_nombre,
              p.estado AS pago_estado, p.metodo_pago
       FROM reservas r
       JOIN espacios_parqueo e ON e.id = r.espacio_id
       JOIN usuarios u ON u.id = r.conductor_id
       JOIN usuarios a ON a.id = e.arrendador_id
       LEFT JOIN LATERAL (
         SELECT estado, metodo_pago FROM pagos WHERE reserva_id = r.id ORDER BY id DESC LIMIT 1
       ) p ON TRUE
       WHERE ($1::text IS NULL OR u.nombre ILIKE $1 OR u.correo ILIKE $1 OR e.titulo ILIKE $1)
         AND ($2::text IS NULL OR r.estado::text = $2)
         AND ($3::date IS NULL OR r.fecha_inicio::date >= $3::date)
         AND ($4::date IS NULL OR r.fecha_inicio::date <= $4::date)
       ORDER BY r.fecha_creacion DESC
       LIMIT 200`,
      [patron(req.query.q), estado, desde, hasta]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar reservas' });
  }
});

module.exports = router;