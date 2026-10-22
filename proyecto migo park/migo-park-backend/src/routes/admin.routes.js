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

  return '%' + t.replace(/[\\\\%\_]/g, '\\\\$&') + '%';

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

router.get('/usuarios', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {

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

router.put('/usuarios/:id/activo', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {

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





// GET /api/admin/espacios -> listado de espacios para administración y soporte
router.get('/espacios', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  try {
    const q = patron(req.query.q);
    const resultado = await pool.query(
      `SELECT
          e.id,
          e.titulo,
          e.direccion,
          e.verificado,
          e.motivo_rechazo,
          e.arrendador_id,
          COALESCE(u.nombre, 'Perfil no disponible') AS arrendador_nombre,
          COALESCE(u.correo, 'Sin correo') AS arrendador_correo,
          (SELECT COUNT(*)::int FROM reservas r WHERE r.espacio_id = e.id) AS reservas,
          COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'id', em.id,
                  'url', em.url,
                  'orden', em.orden
                )
                ORDER BY em.orden, em.id
              )
              FROM espacio_media em
              WHERE em.espacio_id = e.id
            ),
            '[]'::json
          ) AS fotos
       FROM espacios_parqueo e
       LEFT JOIN usuarios u ON u.id = e.arrendador_id
       WHERE (
         $1::text IS NULL
         OR COALESCE(e.titulo, '') ILIKE $1
         OR COALESCE(e.direccion, '') ILIKE $1
         OR COALESCE(u.nombre, '') ILIKE $1
         OR COALESCE(u.correo, '') ILIKE $1
       )
       ORDER BY e.id DESC
       LIMIT 300`,
      [q]
    );

    res.json(resultado.rows);
  } catch (err) {
    console.error('Error al listar espacios para administración:', err);
    res.status(500).json({ error: 'Error al consultar espacios' });
  }
});

// DELETE /api/admin/espacios/:id -> administrador y soporte pueden eliminar espacios sin reservas

router.delete('/espacios/:id', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {

  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'ID de espacio no válido' });

  const client = await pool.connect();

  try {

    await client.query('BEGIN');

    const espacio = await client.query('SELECT id, titulo FROM espacios_parqueo WHERE id = $1 FOR UPDATE', [id]);

    if (!espacio.rowCount) {

      await client.query('ROLLBACK');

      return res.status(404).json({ error: 'Espacio no encontrado' });

    }

    const reservas = await client.query('SELECT COUNT(*)::int AS total FROM reservas WHERE espacio_id = $1', [id]);

    if (reservas.rows[0].total > 0) {

      await client.query('ROLLBACK');

      return res.status(409).json({ error: 'No se puede eliminar este espacio porque tiene reservas asociadas. Conserva el historial y desactívalo desde la gestión del espacio.' });

    }

    // Limpiar tablas dependientes conocidas antes del espacio principal.

    await client.query('DELETE FROM espacio_media WHERE espacio_id = $1', [id]);

    await client.query('DELETE FROM disponibilidad_espacio WHERE espacio_id = $1', [id]);

    await client.query('DELETE FROM espacios_parqueo WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.json({ ok: true, mensaje: `El espacio "${espacio.rows[0].titulo}" fue eliminado.` });

  } catch (err) {

    await client.query('ROLLBACK').catch(() => {});

    console.error('Error al eliminar espacio:', err);

    if (err.code === '23503') return res.status(409).json({ error: 'No se puede eliminar el espacio porque tiene información relacionada. No se borró ningún dato.' });

    res.status(500).json({ error: 'Error al eliminar el espacio' });

  } finally {

    client.release();

  }

});



// DELETE /api/admin/usuarios/:id -> elimina perfil y sus datos relacionados,

// siempre que no tenga reservas vigentes (las reservas ya terminadas se eliminan también).

router.delete('/usuarios/:id', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {

  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'ID de usuario no válido' });

  if (id === Number(req.usuario.id)) return res.status(400).json({ error: 'No puedes eliminar tu propio perfil.' });



  const client = await pool.connect();

  try {

    await client.query('BEGIN');



    const objetivo = await client.query(

      'SELECT id, nombre, rol::text AS rol FROM usuarios WHERE id = $1 FOR UPDATE', [id]

    );

    if (!objetivo.rowCount) {

      await client.query('ROLLBACK');

      return res.status(404).json({ error: 'Perfil no encontrado' });

    }

    if (objetivo.rows[0].rol === 'administrador') {

      await client.query('ROLLBACK');

      return res.status(403).json({ error: 'Por seguridad, no se pueden eliminar perfiles de administrador desde este panel.' });

    }



    // Espacios publicados por el perfil.

    const espacios = await client.query('SELECT id FROM espacios_parqueo WHERE arrendador_id = $1 FOR UPDATE', [id]);

    const espacioIds = espacios.rows.map(row => row.id);



    // No se borran perfiles con reservas todavía activas o futuras. Una reserva

    // cuenta como terminada si su fecha_fin ya pasó o su estado es completada/cancelada.

    const reservasVigentes = await client.query(

      `SELECT r.id

       FROM reservas r

       LEFT JOIN espacios_parqueo e ON e.id = r.espacio_id

       WHERE (r.conductor_id = $1 OR e.arrendador_id = $1)

         AND r.estado::text NOT IN ('completada', 'cancelada')

         AND r.fecha_fin > NOW()

       LIMIT 1`, [id]

    );

    if (reservasVigentes.rowCount) {

      await client.query('ROLLBACK');

      return res.status(409).json({ error: 'No se puede eliminar este perfil porque tiene una reserva vigente o futura. Inténtalo cuando haya terminado.' });

    }



    // Función auxiliar: elimina dependencias solo si existen en esta versión del esquema.

    const existeColumna = async (tabla, columna) => {

      const r = await client.query(

        `SELECT 1 FROM information_schema.columns

         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1`,

        [tabla, columna]

      );

      return r.rowCount > 0;

    };

    const borrarPorIds = async (tabla, columna, ids) => {

      if (!ids || !ids.length || !(await existeColumna(tabla, columna))) return;

      await client.query(`DELETE FROM ${tabla} WHERE ${columna} = ANY($1)`, [ids]);

    };

    const borrarPorId = async (tabla, columna, valor) => {

      if (await existeColumna(tabla, columna)) {

        await client.query(`DELETE FROM ${tabla} WHERE ${columna} = $1`, [valor]);

      }

    };



    // Recoger reservas del perfil como conductor o de cualquiera de sus espacios.

    const reservas = await client.query(

      `SELECT r.id FROM reservas r

       LEFT JOIN espacios_parqueo e ON e.id = r.espacio_id

       WHERE r.conductor_id = $1 OR e.arrendador_id = $1`, [id]

    );

    const reservaIds = reservas.rows.map(row => row.id);



    // Dependencias de reservas terminadas: pagos y calificaciones.

    await borrarPorIds('pagos', 'reserva_id', reservaIds);

    await borrarPorIds('calificaciones', 'reserva_id', reservaIds);

    await borrarPorId('calificaciones', 'conductor_id', id);



    // Datos dependientes de los espacios publicados.

    await borrarPorIds('espacio_media', 'espacio_id', espacioIds);

    await borrarPorIds('disponibilidad_espacio', 'espacio_id', espacioIds);

    await borrarPorIds('documentos_verificacion', 'espacio_id', espacioIds);



    // Reservas finalizadas y sus registros asociados ya fueron identificados.

    await borrarPorId('reservas', 'conductor_id', id);

    await borrarPorIds('reservas', 'espacio_id', espacioIds);



    // Vehículos, documentos de identidad, notificaciones y casos de soporte.

    await borrarPorId('vehiculos', 'conductor_id', id);

    await borrarPorId('documentos_verificacion', 'usuario_id', id);

    await borrarPorId('notificaciones', 'usuario_id', id);



    if (await existeColumna('casos_soporte', 'usuario_id')) {

      const casos = await client.query('SELECT id FROM casos_soporte WHERE usuario_id = $1', [id]);

      const casoIds = casos.rows.map(row => row.id);

      await borrarPorIds('mensajes_soporte', 'caso_id', casoIds);

      await borrarPorId('casos_soporte', 'usuario_id', id);

    }

    // Si el usuario participó como remitente en mensajes de otros casos, limpiar esas referencias.

    await borrarPorId('mensajes_soporte', 'remitente_id', id);



    // Finalmente eliminar espacios y perfil.

    await borrarPorId('espacios_parqueo', 'arrendador_id', id);

    await client.query('DELETE FROM usuarios WHERE id = $1', [id]);



    await client.query('COMMIT');

    res.json({ ok: true, mensaje: `El perfil de ${objetivo.rows[0].nombre}, sus espacios y sus reservas terminadas fueron eliminados.` });

  } catch (err) {

    await client.query('ROLLBACK').catch(() => {});

    console.error('Error al eliminar perfil y datos relacionados:', err);

    if (err.code === '23503') {

      return res.status(409).json({ error: 'No se pudo eliminar el perfil porque queda un registro relacionado sin contemplar. No se aplicaron cambios.' });

    }

    res.status(500).json({ error: 'Error al eliminar el perfil y sus datos relacionados.' });

  } finally {

    client.release();

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