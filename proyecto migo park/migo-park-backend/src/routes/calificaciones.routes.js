const express = require('express');
const pool = require('../db');
const {
  verificarToken,
  requiereRol
} = require('../middlewares/auth.middleware');

const router = express.Router();

// ======================================================
// GET /api/calificaciones/espacio/:espacioId
// Ver calificaciones de un espacio
// ======================================================

router.get('/espacio/:espacioId', async (req, res) => {
  const { espacioId } = req.params;

  try {
    const promedio = await pool.query(
      `
      SELECT
        COALESCE(ROUND(AVG(puntuacion)::numeric, 1), 0) AS promedio,
        COUNT(*)::int AS cantidad
      FROM calificaciones
      WHERE espacio_id = $1
      `,
      [espacioId]
    );

    const calificaciones = await pool.query(
      `
      SELECT
        c.id,
        c.puntuacion,
        c.comentario,
        c.fecha,
        u.nombre AS conductor
      FROM calificaciones c
      JOIN usuarios u
        ON u.id = c.conductor_id
      WHERE c.espacio_id = $1
      ORDER BY c.fecha DESC
      `,
      [espacioId]
    );

    res.json({
      promedio: Number(promedio.rows[0].promedio || 0),
      cantidad: Number(promedio.rows[0].cantidad || 0),
      calificaciones: calificaciones.rows
    });

  } catch (err) {
    console.error('Error al consultar calificaciones:', err);

    res.status(500).json({
      error: 'Error al consultar las calificaciones'
    });
  }
});


// ======================================================
// POST /api/calificaciones/reserva/:reservaId
// Cliente califica una reserva completada
// ======================================================

router.post(
  '/reserva/:reservaId',
  verificarToken,
  requiereRol('cliente'),
  async (req, res) => {

    const { reservaId } = req.params;

    const puntuacion = Number(req.body.puntuacion);

    const comentario =
      req.body.comentario == null
        ? null
        : String(req.body.comentario).trim();

    if (
      !Number.isInteger(puntuacion) ||
      puntuacion < 1 ||
      puntuacion > 5
    ) {
      return res.status(400).json({
        error: 'La puntuación debe estar entre 1 y 5 estrellas'
      });
    }

    try {

      // Buscar la reserva y comprobar que pertenece
      // al cliente que está conectado
      const reserva = await pool.query(
        `
        SELECT
          r.id,
          r.espacio_id,
          r.conductor_id,
          r.estado
        FROM reservas r
        WHERE r.id = $1
          AND r.conductor_id = $2
        `,
        [
          reservaId,
          req.usuario.id
        ]
      );

      if (reserva.rows.length === 0) {
        return res.status(404).json({
          error: 'Reserva no encontrada o no te pertenece'
        });
      }

      const datosReserva = reserva.rows[0];

      // Solo reservas completadas
      if (datosReserva.estado !== 'completada') {
        return res.status(400).json({
          error: 'Solo puedes calificar reservas completadas'
        });
      }

      // Comprobar si ya calificó esta reserva
      const existente = await pool.query(
        `
        SELECT id
        FROM calificaciones
        WHERE reserva_id = $1
        `,
        [reservaId]
      );

      if (existente.rows.length > 0) {
        return res.status(409).json({
          error: 'Ya calificaste esta reserva'
        });
      }

      // Guardar calificación
      const resultado = await pool.query(
        `
        INSERT INTO calificaciones
        (
          reserva_id,
          espacio_id,
          conductor_id,
          puntuacion,
          comentario
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5
        )
        RETURNING *
        `,
        [
          reservaId,
          datosReserva.espacio_id,
          req.usuario.id,
          puntuacion,
          comentario || null
        ]
      );

      res.status(201).json({
        ok: true,
        mensaje: 'Calificación registrada correctamente',
        calificacion: resultado.rows[0]
      });

    } catch (err) {

      // Por si se intenta calificar dos veces
      // y PostgreSQL activa la restricción UNIQUE
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Ya calificaste esta reserva'
        });
      }

      console.error(
        'Error al registrar calificación:',
        err
      );

      res.status(500).json({
        error: 'Error al registrar la calificación'
      });
    }
  }
);


module.exports = router;