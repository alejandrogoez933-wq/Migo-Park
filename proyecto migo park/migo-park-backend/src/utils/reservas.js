// Funciones compartidas entre las rutas de reservas y pagos

const MINUTOS_PARA_PAGAR = 15;

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

module.exports = { MINUTOS_PARA_PAGAR, actualizarReservas };