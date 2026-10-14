const express = require('express');
const pool = require('../db');
const { verificarToken } = require('../middlewares/auth.middleware');

const router = express.Router();

// GET /api/notificaciones -> mis últimas 50 notificaciones + cuántas están sin leer
router.get('/', verificarToken, async (req, res) => {
  try {
    const lista = await pool.query(
      `SELECT id, tipo, mensaje, leida, fecha
       FROM notificaciones
       WHERE usuario_id = $1
       ORDER BY fecha DESC, id DESC
       LIMIT 50`,
      [req.usuario.id]
    );
    const contador = await pool.query(
      'SELECT COUNT(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND leida = FALSE',
      [req.usuario.id]
    );
    res.json({ notificaciones: lista.rows, no_leidas: contador.rows[0].n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar las notificaciones' });
  }
});

// GET /api/notificaciones/contador -> solo el número de no leídas (para la burbuja de la campana)
router.get('/contador', verificarToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT COUNT(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND leida = FALSE',
      [req.usuario.id]
    );
    res.json({ no_leidas: r.rows[0].n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar el contador' });
  }
});

// PUT /api/notificaciones/marcar-todas -> marca todas mis notificaciones como leídas
router.put('/marcar-todas', verificarToken, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE notificaciones SET leida = TRUE WHERE usuario_id = $1 AND leida = FALSE',
      [req.usuario.id]
    );
    res.json({ marcadas: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar las notificaciones' });
  }
});

// PUT /api/notificaciones/:id/leida -> marca UNA como leída (solo si es mía)
router.put('/:id/leida', verificarToken, async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id) || Number(id) > 2147483647) {
    return res.status(404).json({ error: 'Notificación no encontrada' });
  }
  try {
    const r = await pool.query(
      'UPDATE notificaciones SET leida = TRUE WHERE id = $1 AND usuario_id = $2 RETURNING id',
      [id, req.usuario.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar la notificación' });
  }
});

module.exports = router;