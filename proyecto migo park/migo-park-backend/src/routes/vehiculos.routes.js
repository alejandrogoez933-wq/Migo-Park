const express = require('express');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middlewares/auth.middleware');

const router = express.Router();
const REGEX_PLACA = /^[A-Z]{3}[0-9]{3}$/;

// POST /api/vehiculos -> registrar un vehículo
router.post('/', verificarToken, async (req, res) => {
  const { placa, marca, modelo, color } = req.body;
  if (!placa) return res.status(400).json({ error: 'La placa es obligatoria' });

  const placaNormalizada = placa.toUpperCase().replace(/\s/g, '');
  if (!REGEX_PLACA.test(placaNormalizada)) {
    return res.status(400).json({ error: 'Formato de placa inválido (ej: ABC123)' });
  }

  try {
    const existe = await pool.query('SELECT id FROM vehiculos WHERE placa = $1', [placaNormalizada]);
    if (existe.rows.length > 0) return res.status(409).json({ error: 'Esa placa ya está registrada' });

    const resultado = await pool.query(
      `INSERT INTO vehiculos (conductor_id, placa, marca, modelo, color)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.usuario.id, placaNormalizada, marca || null, modelo || null, color || null]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el vehículo' });
  }
});

// GET /api/vehiculos/mios
router.get('/mios', verificarToken, async (req, res) => {
  try {
    const resultado = await pool.query(
      'SELECT * FROM vehiculos WHERE conductor_id = $1 ORDER BY fecha_registro DESC',
      [req.usuario.id]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los vehículos' });
  }
});

// GET /api/vehiculos/pendientes -> cola de verificación
router.get('/pendientes', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT v.*, u.nombre AS conductor_nombre, u.correo AS conductor_correo
       FROM vehiculos v JOIN usuarios u ON u.id = v.conductor_id
       WHERE v.verificado = FALSE ORDER BY v.fecha_registro ASC`
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar vehículos pendientes' });
  }
});

// PUT /api/vehiculos/:id/verificar -> aprobar
router.put('/:id/verificar', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  const { id } = req.params;
  try {
    const resultado = await pool.query(
      `UPDATE vehiculos SET verificado = TRUE, verificado_por = $1 WHERE id = $2 RETURNING *`,
      [req.usuario.id, id]
    );
    if (resultado.rows.length === 0) return res.status(404).json({ error: 'Vehículo no encontrado' });
    const v = resultado.rows[0];

    await pool.query(
      `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'vehiculo_aprobado', $2)`,
      [v.conductor_id, `Tu vehículo ${v.placa} fue verificado.`]
    );
    res.json(v);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al verificar el vehículo' });
  }
});

// PUT /api/vehiculos/:id/rechazar -> rechazar con motivo. Se elimina el registro para que
// el conductor pueda volver a registrar la placa corregida (solo vehículos aún no verificados).
router.put('/:id/rechazar', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  const { id } = req.params;
  const motivo = String(req.body.motivo || '').trim();
  if (motivo.length < 5) {
    return res.status(400).json({ error: 'Escribe el motivo del rechazo (mínimo 5 caracteres)' });
  }

  try {
    const resultado = await pool.query(
      'DELETE FROM vehiculos WHERE id = $1 AND verificado = FALSE RETURNING *',
      [id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Vehículo no encontrado o ya está verificado' });
    }
    const v = resultado.rows[0];

    await pool.query(
      `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'vehiculo_rechazado', $2)`,
      [v.conductor_id, `Tu vehículo ${v.placa} fue rechazado. Motivo: ${motivo}. Puedes registrarlo de nuevo con los datos corregidos.`]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al rechazar el vehículo' });
  }
});

module.exports = router;