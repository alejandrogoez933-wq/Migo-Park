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

           COALESCE((SELECT SUM(comision) FROM reservas WHERE estado IN ('confirmada', 'completada')), 0) AS comisiones,

           COALESCE((SELECT SUM(monto_reembolso) FROM reservas WHERE estado = 'cancelada' AND estado_reembolso = 'aprobado'), 0) AS reembolsos,

           (SELECT COUNT(*)::int FROM reservas WHERE estado_reembolso = 'pendiente') AS reembolsos_pendientes,

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

      `SELECT r.id, r.estado, r.fecha_inicio, r.fecha_fin, r.comision,

              r.monto_reembolso, r.estado_reembolso, r.fecha_creacion, r.fecha_cancelacion, r.motivo_cancelacion,

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



// ======================================================
// GET /api/admin/rentabilidad?dias=30|90|365|0&q=texto   (solo administrador)
// Ingresos y rentabilidad de cada espacio y de cada usuario (arrendador).
// "Ingreso" = la comisión que gana Migo Park por las reservas pagadas de ese espacio.
// NO muestra lo que pagaron los conductores ni lo que ganó cada arrendador.
// dias = 0 -> todo el tiempo
// ======================================================
router.get('/rentabilidad', verificarToken, requiereRol('administrador'), async (req, res) => {
  const DIAS_VALIDOS = [0, 30, 90, 365];
  const diasPedidos = Number(req.query.dias);
  const dias = DIAS_VALIDOS.includes(diasPedidos) ? diasPedidos : 30;
  const q = String(req.query.q || '').trim().toLowerCase();

  try {
    await actualizarReservas(pool);

    const resultado = await pool.query(
      `WITH periodo AS (
         SELECT CASE WHEN $1::int > 0 THEN NOW() - make_interval(days => $1::int) END AS desde
       )
       SELECT e.id, e.titulo, e.direccion, e.arrendador_id,
              u.nombre AS arrendador_nombre, u.correo AS arrendador_correo,
              COALESCE(ing.reservas, 0)::int AS reservas,
              COALESCE(ing.comision, 0)::float8 AS comision,
              COALESCE(oc.horas, 0)::float8 AS horas_reservadas,
              GREATEST(EXTRACT(EPOCH FROM (
                NOW() - CASE WHEN p.desde IS NULL OR e.fecha_creacion >= p.desde THEN e.fecha_creacion ELSE p.desde END
              )) / 3600, 0)::float8 AS horas_periodo
       FROM espacios_parqueo e
       JOIN usuarios u ON u.id = e.arrendador_id
       CROSS JOIN periodo p
       LEFT JOIN LATERAL (
         -- reservas con pago completado dentro del periodo y la comisión que dejaron
         SELECT COUNT(*) AS reservas, SUM(r.comision) AS comision
         FROM reservas r
         WHERE r.espacio_id = e.id
           AND r.estado IN ('confirmada', 'completada')
           AND EXISTS (
             SELECT 1 FROM pagos pg
             WHERE pg.reserva_id = r.id AND pg.estado = 'completado'
               AND (p.desde IS NULL OR pg.fecha_pago >= p.desde)
           )
       ) ing ON TRUE
       LEFT JOIN LATERAL (
         -- horas que el espacio estuvo reservado dentro del periodo (hasta hoy)
         SELECT SUM(EXTRACT(EPOCH FROM (
                  LEAST(r.fecha_fin, NOW())
                  - CASE WHEN p.desde IS NULL OR r.fecha_inicio >= p.desde THEN r.fecha_inicio ELSE p.desde END
                )) / 3600) AS horas
         FROM reservas r
         WHERE r.espacio_id = e.id
           AND r.estado IN ('confirmada', 'completada')
           AND r.fecha_inicio < NOW()
           AND (p.desde IS NULL OR r.fecha_fin > p.desde)
       ) oc ON TRUE
       WHERE e.verificado = TRUE OR COALESCE(ing.reservas, 0) > 0`,
      [dias]
    );

    const filas = resultado.rows;
    const comisionTotal = filas.reduce((t, f) => t + f.comision, 0);
    const reservasTotal = filas.reduce((t, f) => t + f.reservas, 0);
    const redondear = (n, d = 2) => Number(Number(n).toFixed(d));
    const porcentaje = (parte, todo) => (todo > 0 ? redondear((parte / todo) * 100, 1) : 0);
    const ocupacion = (horas, horasPeriodo) =>
      (horasPeriodo >= 1 ? Math.min(100, redondear((horas / horasPeriodo) * 100, 1)) : null);

    const espacios = filas.map((f) => ({
      id: f.id,
      titulo: f.titulo,
      direccion: f.direccion,
      arrendador_id: f.arrendador_id,
      arrendador_nombre: f.arrendador_nombre,
      arrendador_correo: f.arrendador_correo,
      reservas: f.reservas,
      comision: redondear(f.comision),
      comision_promedio: f.reservas > 0 ? redondear(f.comision / f.reservas) : 0,
      participacion: porcentaje(f.comision, comisionTotal),
      ocupacion: ocupacion(f.horas_reservadas, f.horas_periodo),
      horas_reservadas: f.horas_reservadas,
      horas_periodo: f.horas_periodo,
    }));

    // Agrupado por usuario (arrendador)
    const mapa = new Map();
    for (const e of espacios) {
      if (!mapa.has(e.arrendador_id)) {
        mapa.set(e.arrendador_id, {
          id: e.arrendador_id,
          nombre: e.arrendador_nombre,
          correo: e.arrendador_correo,
          reservas: 0,
          comision: 0,
          horas_reservadas: 0,
          horas_periodo: 0,
          espacios: [],
        });
      }
      const u = mapa.get(e.arrendador_id);
      u.reservas += e.reservas;
      u.comision += e.comision;
      u.horas_reservadas += e.horas_reservadas;
      u.horas_periodo += e.horas_periodo;
      u.espacios.push({ id: e.id, titulo: e.titulo, reservas: e.reservas, comision: e.comision });
    }
    const ordenar = (a, b) => b.comision - a.comision || b.reservas - a.reservas;
    const usuarios = [...mapa.values()].map((u) => ({
      id: u.id,
      nombre: u.nombre,
      correo: u.correo,
      cantidad_espacios: u.espacios.length,
      reservas: u.reservas,
      comision: redondear(u.comision),
      comision_promedio: u.reservas > 0 ? redondear(u.comision / u.reservas) : 0,
      participacion: porcentaje(u.comision, comisionTotal),
      ocupacion: ocupacion(u.horas_reservadas, u.horas_periodo),
      espacios: u.espacios.sort(ordenar),
    }));

    const coincide = (...campos) => !q || campos.some((c) => String(c || '').toLowerCase().includes(q));

    res.json({
      periodo: { dias },
      resumen: {
        comision_total: redondear(comisionTotal),
        reservas: reservasTotal,
        comision_promedio: reservasTotal > 0 ? redondear(comisionTotal / reservasTotal) : 0,
        espacios_con_ingresos: filas.filter((f) => f.reservas > 0).length,
        espacios_total: filas.length,
        usuarios_con_ingresos: usuarios.filter((u) => u.reservas > 0).length,
      },
      espacios: espacios
        .filter((e) => coincide(e.titulo, e.direccion, e.arrendador_nombre, e.arrendador_correo))
        .sort(ordenar)
        .map(({ horas_reservadas, horas_periodo, ...resto }) => resto),
      usuarios: usuarios
        .filter((u) => coincide(u.nombre, u.correo) || u.espacios.some((e) => coincide(e.titulo)))
        .sort(ordenar),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al calcular ingresos y rentabilidad' });
  }
});


// ======================================================
// Reembolsos por cancelación: administrador y soporte los autorizan o rechazan
//   GET /api/admin/reembolsos?estado=pendiente|aprobado|rechazado
//   PUT /api/admin/reembolsos/:id/decision   body: { decision: 'aprobar' | 'rechazar', nota }
// ======================================================
const dineroCOP = (n) => '$' + Number(n).toLocaleString('es-CO');

router.get('/reembolsos', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  const estado = ['pendiente', 'aprobado', 'rechazado'].includes(req.query.estado) ? req.query.estado : 'pendiente';

  try {
    const lista = await pool.query(
      `SELECT r.id, r.estado_reembolso, r.monto_reembolso, r.total, r.fecha_inicio, r.fecha_fin,
              r.fecha_cancelacion, r.motivo_cancelacion, r.fecha_decision_reembolso, r.nota_decision_reembolso,
              r.tipo_tarifa, r.cantidad,
              e.titulo AS espacio_titulo,
              uc.nombre AS conductor_nombre, uc.correo AS conductor_correo,
              ua.nombre AS arrendador_nombre,
              ud.nombre AS decidido_por_nombre,
              (SELECT pg.metodo_pago FROM pagos pg
                WHERE pg.reserva_id = r.id AND pg.estado = 'completado' ORDER BY pg.id DESC LIMIT 1) AS metodo_pago
       FROM reservas r
       JOIN espacios_parqueo e ON e.id = r.espacio_id
       JOIN usuarios uc ON uc.id = r.conductor_id
       JOIN usuarios ua ON ua.id = e.arrendador_id
       LEFT JOIN usuarios ud ON ud.id = r.reembolso_decidido_por
       WHERE r.estado_reembolso = $1::text
       ORDER BY CASE WHEN $1::text = 'pendiente' THEN r.fecha_cancelacion END ASC,
                r.fecha_decision_reembolso DESC NULLS LAST, r.id DESC
       LIMIT 200`,
      [estado]
    );
    const pendientes = await pool.query(`SELECT COUNT(*)::int AS n FROM reservas WHERE estado_reembolso = 'pendiente'`);
    res.json({ pendientes: pendientes.rows[0].n, reembolsos: lista.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los reembolsos' });
  }
});

router.put('/reembolsos/:id/decision', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  const id = Number(req.params.id);
  const decision = req.body && req.body.decision;
  const nota = String((req.body && req.body.nota) || '').replace(/\s+/g, ' ').trim();

  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Reserva inválida' });
  if (!['aprobar', 'rechazar'].includes(decision)) {
    return res.status(400).json({ error: 'La decisión debe ser aprobar o rechazar' });
  }
  if (decision === 'rechazar' && nota.length < 10) {
    return res.status(400).json({ error: 'Escribe el motivo del rechazo (mínimo 10 caracteres); se le envía al conductor.' });
  }
  if (nota.length > 500) return res.status(400).json({ error: 'La nota no puede superar los 500 caracteres' });

  const nuevoEstado = decision === 'aprobar' ? 'aprobado' : 'rechazado';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Solo se decide una vez: si otro ya la resolvió, no actualiza nada
    const actualizada = await client.query(
      `UPDATE reservas
       SET estado_reembolso = $1::varchar,
           monto_reembolso = CASE WHEN $1::varchar = 'aprobado' THEN monto_reembolso ELSE 0 END,
           reembolso_decidido_por = $2,
           fecha_decision_reembolso = NOW(),
           nota_decision_reembolso = $3
       WHERE id = $4 AND estado = 'cancelada' AND estado_reembolso = 'pendiente'
       RETURNING id, conductor_id, monto_reembolso,
                 (SELECT titulo FROM espacios_parqueo WHERE id = reservas.espacio_id) AS espacio_titulo`,
      [nuevoEstado, req.usuario.id, nota || null, id]
    );
    if (actualizada.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta solicitud no existe o ya fue resuelta por otra persona' });
    }
    const r = actualizada.rows[0];

    const mensaje = decision === 'aprobar'
      ? `Tu reembolso de ${dineroCOP(r.monto_reembolso)} por la reserva #${r.id} en "${r.espacio_titulo}" fue autorizado.` +
        (nota ? ` Nota: ${nota}` : '')
      : `Tu solicitud de reembolso por la reserva #${r.id} en "${r.espacio_titulo}" fue rechazada. Motivo: ${nota}`;
    await client.query(
      `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, $2, $3)`,
      [r.conductor_id, decision === 'aprobar' ? 'reembolso_aprobado' : 'reembolso_rechazado', mensaje]
    );

    await client.query('COMMIT');
    res.json({ id: r.id, estado_reembolso: nuevoEstado, monto_reembolso: Number(r.monto_reembolso) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la decisión' });
  } finally {
    client.release();
  }
});

module.exports = router;