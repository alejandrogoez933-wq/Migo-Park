const express = require('express');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middlewares/auth.middleware');

const router = express.Router();

const CATEGORIAS = ['Pago o reembolso', 'Reserva', 'Espacio', 'Vehículo', 'Cuenta', 'Otro'];
const ESTADOS_CASO = ['abierto', 'en_proceso', 'resuelto'];
const MAX_CASOS_ACTIVOS = 5;   // casos sin resolver que un cliente puede tener a la vez

const esStaff = (usuario) => ['administrador', 'soporte'].includes(usuario.rol);
const idValido = (id) => /^\d+$/.test(String(id)) && Number(id) <= 2147483647;

// Convierte lo que escribe el usuario en un patrón seguro para ILIKE
function patron(texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  return '%' + t.replace(/[\\%_]/g, '\\$&') + '%';
}
const fechaOk = (f) => (/^\d{4}-\d{2}-\d{2}$/.test(f || '') ? f : null);

// Rol de quien escribió el último mensaje del caso (para saber si soporte "debe responder")
const ULTIMO_REMITENTE = `
  LEFT JOIN LATERAL (
    SELECT r.rol::text AS rol
    FROM mensajes_soporte m JOIN usuarios r ON r.id = m.remitente_id
    WHERE m.caso_id = c.id ORDER BY m.id DESC LIMIT 1
  ) ult ON TRUE`;

// "Esperando respuesta" = caso sin resolver donde nadie de soporte ha respondido lo último
const ESPERANDO = `(c.estado <> 'resuelto' AND (ult.rol IS NULL OR ult.rol = 'cliente'))`;

async function notificar(db, usuarioId, tipo, mensaje) {
  await db.query(
    'INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, $2, $3)',
    [usuarioId, tipo, mensaje]
  );
}

// Trae un caso solo si el usuario tiene derecho a verlo (dueño o staff); si no, devuelve null
async function cargarCaso(id, usuario) {
  if (!idValido(id)) return null;
  const r = await pool.query(
    `SELECT c.*, c.estado::text AS estado,
            u.nombre AS usuario_nombre, u.correo AS usuario_correo,
            a.nombre AS asignado_nombre
     FROM casos_soporte c
     JOIN usuarios u ON u.id = c.usuario_id
     LEFT JOIN usuarios a ON a.id = c.asignado_a
     WHERE c.id = $1`,
    [id]
  );
  const caso = r.rows[0];
  if (!caso) return null;
  if (!esStaff(usuario) && caso.usuario_id !== usuario.id) return null;
  return caso;
}

// ============ STAFF ============

// GET /api/soporte/resumen -> contadores para la insignia del menú
router.get('/resumen', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE c.estado <> 'resuelto')::int AS activos,
              COUNT(*) FILTER (WHERE c.estado = 'abierto')::int AS abiertos,
              COUNT(*) FILTER (WHERE c.estado = 'en_proceso')::int AS en_proceso,
              COUNT(*) FILTER (WHERE c.escalado AND c.estado <> 'resuelto')::int AS escalados,
              COUNT(*) FILTER (WHERE ${ESPERANDO})::int AS esperando
       FROM casos_soporte c ${ULTIMO_REMITENTE}`
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar el resumen' });
  }
});

// GET /api/soporte/casos?q=&estado=&categoria=&desde=&hasta=&escalado=1&esperando=1
router.get('/casos', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  const estado = ESTADOS_CASO.includes(req.query.estado) ? req.query.estado : null;
  const categoria = CATEGORIAS.includes(req.query.categoria) ? req.query.categoria : null;
  try {
    const r = await pool.query(
      `SELECT c.id, c.categoria, c.estado::text AS estado, c.escalado,
              c.fecha_creacion, c.fecha_actualizacion,
              u.nombre AS usuario_nombre, u.correo AS usuario_correo,
              a.nombre AS asignado_nombre,
              ult.rol AS ultimo_rol,
              ${ESPERANDO} AS esperando
       FROM casos_soporte c
       JOIN usuarios u ON u.id = c.usuario_id
       LEFT JOIN usuarios a ON a.id = c.asignado_a
       ${ULTIMO_REMITENTE}
       WHERE ($1::text IS NULL OR u.nombre ILIKE $1 OR u.correo ILIKE $1 OR c.categoria ILIKE $1 OR c.descripcion ILIKE $1)
         AND ($2::text IS NULL OR c.estado::text = $2)
         AND ($3::text IS NULL OR c.categoria = $3)
         AND ($4::date IS NULL OR c.fecha_creacion::date >= $4::date)
         AND ($5::date IS NULL OR c.fecha_creacion::date <= $5::date)
         AND ($6::boolean IS NOT TRUE OR c.escalado)
         AND ($7::boolean IS NOT TRUE OR ${ESPERANDO})
       ORDER BY (c.estado = 'resuelto'), c.escalado DESC, c.fecha_actualizacion DESC
       LIMIT 200`,
      [
        patron(req.query.q), estado, categoria,
        fechaOk(req.query.desde), fechaOk(req.query.hasta),
        req.query.escalado === '1', req.query.esperando === '1',
      ]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los casos' });
  }
});

// PUT /api/soporte/casos/:id/estado  { estado: 'en_proceso' | 'resuelto', solucion }
router.put('/casos/:id/estado', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  const { id } = req.params;
  const estado = req.body.estado;
  const solucion = String(req.body.solucion || '').trim();

  if (!['en_proceso', 'resuelto'].includes(estado)) {
    return res.status(400).json({ error: 'El estado debe ser en_proceso o resuelto' });
  }
  if (estado === 'resuelto' && solucion.length < 5) {
    return res.status(400).json({ error: 'Escribe la solución aplicada (mínimo 5 caracteres)' });
  }
  if (!idValido(id)) return res.status(404).json({ error: 'Caso no encontrado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actual = await client.query('SELECT * FROM casos_soporte WHERE id = $1 FOR UPDATE', [id]);
    const caso = actual.rows[0];
    if (!caso) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Caso no encontrado' }); }
    if (caso.estado === estado) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `El caso ya está ${estado.replace('_', ' ')}` });
    }

    const upd = await client.query(
      `UPDATE casos_soporte
       SET estado = $1::text::estado_caso,
           asignado_a = COALESCE(asignado_a, $2),
           fecha_actualizacion = NOW(),
           solucion = CASE WHEN $1::text = 'resuelto' THEN $3::text ELSE NULL END,
           fecha_cierre = CASE WHEN $1::text = 'resuelto' THEN NOW() ELSE NULL END
       WHERE id = $4 RETURNING *`,
      [estado, req.usuario.id, solucion, id]
    );

    if (estado === 'resuelto') {
      await notificar(client, caso.usuario_id, 'caso_cerrado',
        `Tu caso #${caso.id} fue cerrado. Solución: ${solucion}`);
    } else {
      await notificar(client, caso.usuario_id, 'caso_estado',
        caso.estado === 'resuelto'
          ? `Tu caso #${caso.id} fue reabierto y está en proceso.`
          : `Tu caso #${caso.id} ahora está en proceso.`);
    }

    await client.query('COMMIT');
    res.json(upd.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar el estado del caso' });
  } finally {
    client.release();
  }
});

// PUT /api/soporte/casos/:id/escalar  { motivo } -> solo soporte; lo pasa a los administradores
router.put('/casos/:id/escalar', verificarToken, requiereRol('soporte'), async (req, res) => {
  const { id } = req.params;
  const motivo = String(req.body.motivo || '').trim();
  if (motivo.length < 5) {
    return res.status(400).json({ error: 'Escribe el motivo del escalamiento (mínimo 5 caracteres)' });
  }
  if (!idValido(id)) return res.status(404).json({ error: 'Caso no encontrado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actual = await client.query('SELECT * FROM casos_soporte WHERE id = $1 FOR UPDATE', [id]);
    const caso = actual.rows[0];
    if (!caso) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Caso no encontrado' }); }
    if (caso.estado === 'resuelto') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No se puede escalar un caso ya resuelto' });
    }
    if (caso.escalado) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este caso ya fue escalado' });
    }

    const upd = await client.query(
      `UPDATE casos_soporte
       SET escalado = TRUE, motivo_escalado = $1,
           asignado_a = COALESCE(asignado_a, $2),
           estado = CASE WHEN estado = 'abierto' THEN 'en_proceso'::estado_caso ELSE estado END,
           fecha_actualizacion = NOW()
       WHERE id = $3 RETURNING *`,
      [motivo, req.usuario.id, id]
    );
    await notificar(client, caso.usuario_id, 'caso_escalado',
      `Tu caso #${caso.id} fue escalado a un administrador para una revisión más detallada.`);

    await client.query('COMMIT');
    res.json(upd.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al escalar el caso' });
  } finally {
    client.release();
  }
});

// ============ CLIENTE ============

// POST /api/soporte/casos  { categoria, descripcion }
router.post('/casos', verificarToken, requiereRol('cliente'), async (req, res) => {
  const categoria = String(req.body.categoria || '').trim();
  const descripcion = String(req.body.descripcion || '').trim();

  if (!CATEGORIAS.includes(categoria)) {
    return res.status(400).json({ error: 'Elige una categoría válida' });
  }
  if (descripcion.length < 10) {
    return res.status(400).json({ error: 'Describe el problema (mínimo 10 caracteres)' });
  }
  if (descripcion.length > 2000) {
    return res.status(400).json({ error: 'La descripción es muy larga (máximo 2000 caracteres)' });
  }

  try {
    const activos = await pool.query(
      `SELECT COUNT(*)::int AS n FROM casos_soporte WHERE usuario_id = $1 AND estado <> 'resuelto'`,
      [req.usuario.id]
    );
    if (activos.rows[0].n >= MAX_CASOS_ACTIVOS) {
      return res.status(400).json({
        error: `Ya tienes ${MAX_CASOS_ACTIVOS} casos sin resolver. Espera a que se resuelvan antes de abrir otro.`,
      });
    }

    const r = await pool.query(
      `INSERT INTO casos_soporte (usuario_id, categoria, descripcion)
       VALUES ($1, $2, $3) RETURNING *, estado::text AS estado`,
      [req.usuario.id, categoria, descripcion]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el caso' });
  }
});

// GET /api/soporte/casos/mios
router.get('/casos/mios', verificarToken, requiereRol('cliente'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.categoria, c.estado::text AS estado, c.escalado, c.descripcion,
              c.fecha_creacion, c.fecha_actualizacion,
              (SELECT COUNT(*)::int FROM mensajes_soporte m WHERE m.caso_id = c.id) AS total_mensajes,
              ult.rol AS ultimo_rol
       FROM casos_soporte c ${ULTIMO_REMITENTE}
       WHERE c.usuario_id = $1
       ORDER BY (c.estado = 'resuelto'), c.fecha_actualizacion DESC`,
      [req.usuario.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar tus casos' });
  }
});

// ============ COMPARTIDO (dueño del caso o staff) ============

// GET /api/soporte/casos/:id -> el caso + toda la conversación
router.get('/casos/:id', verificarToken, async (req, res) => {
  try {
    const caso = await cargarCaso(req.params.id, req.usuario);
    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    const mensajes = await pool.query(
      `SELECT m.id, m.mensaje, m.fecha, m.remitente_id,
              u.nombre AS remitente_nombre, u.rol::text AS remitente_rol
       FROM mensajes_soporte m JOIN usuarios u ON u.id = m.remitente_id
       WHERE m.caso_id = $1 ORDER BY m.id ASC`,
      [caso.id]
    );

    // El motivo interno del escalamiento es solo para el staff
    if (!esStaff(req.usuario)) delete caso.motivo_escalado;

    res.json({ caso, mensajes: mensajes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar el caso' });
  }
});

// POST /api/soporte/casos/:id/mensajes  { mensaje }
router.post('/casos/:id/mensajes', verificarToken, async (req, res) => {
  const { id } = req.params;
  const texto = String(req.body.mensaje || '').trim();
  if (texto.length < 1) return res.status(400).json({ error: 'Escribe un mensaje' });
  if (texto.length > 2000) return res.status(400).json({ error: 'El mensaje es muy largo (máximo 2000 caracteres)' });
  if (!idValido(id)) return res.status(404).json({ error: 'Caso no encontrado' });

  const staff = esStaff(req.usuario);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actual = await client.query('SELECT * FROM casos_soporte WHERE id = $1 FOR UPDATE', [id]);
    const caso = actual.rows[0];
    if (!caso || (!staff && caso.usuario_id !== req.usuario.id)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Caso no encontrado' });
    }
    if (caso.estado === 'resuelto') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este caso está cerrado. Si necesitas más ayuda, abre un caso nuevo.' });
    }

    const msg = await client.query(
      'INSERT INTO mensajes_soporte (caso_id, remitente_id, mensaje) VALUES ($1, $2, $3) RETURNING *',
      [id, req.usuario.id, texto]
    );

    if (staff) {
      // La primera respuesta de soporte asigna el caso y lo pasa a "en proceso"
      await client.query(
        `UPDATE casos_soporte
         SET fecha_actualizacion = NOW(),
             asignado_a = COALESCE(asignado_a, $2),
             estado = CASE WHEN estado = 'abierto' THEN 'en_proceso'::estado_caso ELSE estado END
         WHERE id = $1`,
        [id, req.usuario.id]
      );
      await notificar(client, caso.usuario_id, 'caso_respuesta',
        `Soporte respondió tu caso #${caso.id} (${caso.categoria}).`);
    } else {
      await client.query('UPDATE casos_soporte SET fecha_actualizacion = NOW() WHERE id = $1', [id]);
    }

    await client.query('COMMIT');
    res.status(201).json(msg.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al enviar el mensaje' });
  } finally {
    client.release();
  }
});

module.exports = router;