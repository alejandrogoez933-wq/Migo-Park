const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middlewares/auth.middleware');

const router = express.Router();

const idValido = (id) =>
  /^\d+$/.test(String(id)) &&
  Number(id) <= 2147483647;

const MAX_FOTOS = 6;

const UPLOAD_DIR = path.join(
  __dirname,
  '..',
  '..',
  'uploads',
  'espacios'
);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, UPLOAD_DIR),

  filename: (req, file, cb) => {
    // El id llega por la URL: se valida y se convierte a número entero
    // para que nunca pueda contener "../" u otros caracteres de ruta.
    if (!idValido(req.params.id)) {
      return cb(new Error('Id de espacio inválido'));
    }
    const espacioId = Number.parseInt(req.params.id, 10);

    const ext = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp'
    }[file.mimetype] || '';

    cb(
      null,
      `espacio${espacioId}_${Date.now()}_${crypto.randomInt(1e9)}${ext}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: MAX_FOTOS
  },

  fileFilter: (req, file, cb) => {
    if (
      ![
        'image/jpeg',
        'image/png',
        'image/webp'
      ].includes(file.mimetype)
    ) {
      return cb(
        new Error(
          'Solo se permiten imágenes JPG, PNG o WEBP'
        )
      );
    }

    cb(null, true);
  },
});


async function espacioDelDueno(id, usuarioId) {

  if (!idValido(id)) {
    return null;
  }

  const r = await pool.query(
    `
    SELECT *
    FROM espacios_parqueo
    WHERE id = $1
      AND arrendador_id = $2
    `,
    [id, usuarioId]
  );

  return r.rows[0] || null;
}


const SUBCONSULTA_MEDIA = `
  COALESCE((
    SELECT json_agg(
      json_build_object(
        'id', m.id,
        'url', m.url
      )
      ORDER BY m.orden, m.id
    )
    FROM espacio_media m
    WHERE m.espacio_id = e.id
  ), '[]') AS fotos
`;


const SUBCONSULTA_RATING = `
  COALESCE(
    (
      SELECT ROUND(
        AVG(c.puntuacion)::numeric,
        1
      )
      FROM calificaciones c
      WHERE c.espacio_id = e.id
    ),
    0
  ) AS promedio_calificacion,

  COALESCE(
    (
      SELECT COUNT(*)::int
      FROM calificaciones c
      WHERE c.espacio_id = e.id
    ),
    0
  ) AS total_calificaciones
`;


// ======================================================
// POST /api/espacios
// Un cliente publica un espacio
// ======================================================

router.post(
  '/',
  verificarToken,
  requiereRol('cliente'),
  async (req, res) => {

    const {
  titulo,
  descripcion,
  direccion,
  latitud,
  longitud,
  precio_hora,
  capacidad_vehiculos,
  largo_metros,
  ancho_metros,
  tiene_camara,
  tiene_porton,
  tiene_iluminacion
} = req.body;

    const tituloLimpio = String(titulo || '').trim();
    const direccionLimpia = String(direccion || '').trim();
    const descripcionLimpia = String(descripcion || '').trim();

    if (
      !tituloLimpio ||
      !direccionLimpia ||
      latitud == null ||
      longitud == null ||
      !precio_hora
    ) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios del espacio'
      });
    }

    const lat = Number(latitud);
    const lng = Number(longitud);
    const precio = Number(precio_hora);

    const capacidad = Number(capacidad_vehiculos);
    const largo = Number(largo_metros);
    const ancho = Number(ancho_metros);

    if (
      Number.isNaN(lat) ||
      lat < -90 ||
      lat > 90 ||
      Number.isNaN(lng) ||
      lng < -180 ||
      lng > 180
    ) {
      return res.status(400).json({
        error: 'Latitud o longitud fuera de rango'
      });
    }

    if (
      Number.isNaN(precio) ||
      precio <= 0
    ) {
      return res.status(400).json({
        error: 'El precio por hora debe ser mayor a 0'
      });
    }

    if (
  !Number.isInteger(capacidad) ||
  capacidad <= 0
) {
  return res.status(400).json({
    error: 'La capacidad de vehículos debe ser un número entero mayor a 0'
  });
}

if (
  Number.isNaN(largo) ||
  largo <= 0 ||
  Number.isNaN(ancho) ||
  ancho <= 0
) {
  return res.status(400).json({
    error: 'El largo y el ancho deben ser mayores a 0'
  });
}

    try {

      const resultado = await pool.query(
        `
 INSERT INTO espacios_parqueo
(
  arrendador_id,
  titulo,
  descripcion,
  direccion,
  latitud,
  longitud,
  precio_hora,
  capacidad_vehiculos,
  largo_metros,
  ancho_metros,
  tiene_camara,
  tiene_porton,
  tiene_iluminacion
)

        VALUES
(
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7,
  $8,
  $9,
  $10,
  $11,
  $12,
  $13
)

        RETURNING *
        `,
        [
  req.usuario.id,
  tituloLimpio,
  descripcionLimpia || null,
  direccionLimpia,
  lat,
  lng,
  precio,
  capacidad,
  largo,
  ancho,
  !!tiene_camara,
  !!tiene_porton,
  !!tiene_iluminacion
]

      );

      res.status(201).json(
        resultado.rows[0]
      );

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: 'Error al publicar el espacio'
      });
    }
  }
);


// ======================================================
// GET /api/espacios
// Lista pública de espacios verificados y disponibles
// ======================================================

router.get('/', async (req, res) => {

  try {

    const resultado = await pool.query(
      `
      SELECT
        e.*,
        ${SUBCONSULTA_MEDIA},
        ${SUBCONSULTA_RATING}

      FROM espacios_parqueo e

      WHERE e.verificado = TRUE
        AND e.estado = 'disponible'

      ORDER BY e.fecha_creacion DESC
      `
    );

    res.json(resultado.rows);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: 'Error al consultar espacios'
    });
  }
});


// ======================================================
// GET /api/espacios/mios
// Espacios del cliente que inició sesión
// ======================================================

router.get(
  '/mios',
  verificarToken,
  requiereRol('cliente'),
  async (req, res) => {

    try {

      const resultado = await pool.query(
        `
        SELECT
          e.*,
          ${SUBCONSULTA_MEDIA},
          ${SUBCONSULTA_RATING}

        FROM espacios_parqueo e

        WHERE e.arrendador_id = $1

        ORDER BY e.fecha_creacion DESC
        `,
        [req.usuario.id]
      );

      res.json(resultado.rows);

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: 'Error al consultar tus espacios'
      });
    }
  }
);


// ======================================================
// GET /api/espacios/pendientes
// Cola de verificación
// No incluye espacios ya rechazados
// ======================================================

router.get(
  '/pendientes',
  verificarToken,
  requiereRol('administrador', 'soporte'),
  async (req, res) => {

    try {

      const resultado = await pool.query(
        `
        SELECT
          e.*,
          u.nombre AS arrendador_nombre,
          u.correo AS arrendador_correo,
          ${SUBCONSULTA_MEDIA}

        FROM espacios_parqueo e

        JOIN usuarios u
          ON u.id = e.arrendador_id

        WHERE e.verificado = FALSE
          AND e.motivo_rechazo IS NULL

        ORDER BY e.fecha_creacion ASC
        `
      );

      res.json(resultado.rows);

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: 'Error al consultar espacios pendientes'
      });
    }
  }
);


// ======================================================
// PUT /api/espacios/:id/verificar
// Aprobar espacio
// ======================================================

router.put(
  '/:id/verificar',
  verificarToken,
  requiereRol('administrador', 'soporte'),
  async (req, res) => {

    const { id } = req.params;

    try {

      const resultado = await pool.query(
        `
        UPDATE espacios_parqueo

        SET
          verificado = TRUE,
          verificado_por = $1,
          fecha_verificacion = NOW(),
          motivo_rechazo = NULL,
          fecha_rechazo = NULL

        WHERE id = $2

        RETURNING *
        `,
        [
          req.usuario.id,
          id
        ]
      );

      if (resultado.rows.length === 0) {

        return res.status(404).json({
          error: 'Espacio no encontrado'
        });
      }

      const espacio = resultado.rows[0];

      await pool.query(
        `
        INSERT INTO notificaciones
        (
          usuario_id,
          tipo,
          mensaje
        )
        VALUES
        (
          $1,
          'espacio_aprobado',
          $2
        )
        `,
        [
          espacio.arrendador_id,
          `Tu espacio "${espacio.titulo}" fue aprobado y ya es visible para los conductores.`
        ]
      );

      res.json(espacio);

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: 'Error al verificar el espacio'
      });
    }
  }
);


// ======================================================
// PUT /api/espacios/:id/rechazar
// Rechazar espacio con motivo
// ======================================================

router.put(
  '/:id/rechazar',
  verificarToken,
  requiereRol('administrador', 'soporte'),
  async (req, res) => {

    const { id } = req.params;

    const motivo =
      String(req.body.motivo || '').trim();

    if (motivo.length < 5) {

      return res.status(400).json({
        error:
          'Escribe el motivo del rechazo (mínimo 5 caracteres)'
      });
    }

    try {

      const resultado = await pool.query(
        `
        UPDATE espacios_parqueo

        SET
          motivo_rechazo = $1,
          fecha_rechazo = NOW()

        WHERE id = $2
          AND verificado = FALSE

        RETURNING *
        `,
        [
          motivo,
          id
        ]
      );

      if (resultado.rows.length === 0) {

        return res.status(404).json({
          error:
            'Espacio no encontrado o ya está verificado'
        });
      }

      const espacio = resultado.rows[0];

      await pool.query(
        `
        INSERT INTO notificaciones
        (
          usuario_id,
          tipo,
          mensaje
        )
        VALUES
        (
          $1,
          'espacio_rechazado',
          $2
        )
        `,
        [
          espacio.arrendador_id,
          `Tu espacio "${espacio.titulo}" fue rechazado. Motivo: ${motivo}`
        ]
      );

      res.json(espacio);

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: 'Error al rechazar el espacio'
      });
    }
  }
);


// ======================================================
// PUT /api/espacios/:id
// Editar cualquier espacio propio sin perder su aprobación
// Notifica a administradores y soporte con los cambios realizados
// ======================================================

router.put(
  '/:id',
  verificarToken,
  requiereRol('cliente'),
  async (req, res) => {

    try {

      const usuarioId = req.usuario.id;
      const espacioId = req.params.id;

      if (!idValido(espacioId)) {
        return res.status(400).json({
          error: 'ID de espacio inválido'
        });
      }

      const {
        titulo,
        descripcion,
        direccion,
        latitud,
        longitud,
        precio_hora,
        capacidad_vehiculos,
        largo_metros,
        ancho_metros,
        tiene_camara,
        tiene_porton,
        tiene_iluminacion
      } = req.body;

      if (
        !titulo ||
        !direccion ||
        latitud == null ||
        longitud == null ||
        precio_hora == null ||
        capacidad_vehiculos == null ||
        largo_metros == null ||
        ancho_metros == null
      ) {
        return res.status(400).json({
          error: 'Faltan campos obligatorios del espacio'
        });
      }

      const lat = Number(latitud);
      const lng = Number(longitud);
      const precio = Number(precio_hora);
      const capacidad = Number(capacidad_vehiculos);
      const largo = Number(largo_metros);
      const ancho = Number(ancho_metros);

      if (
        Number.isNaN(lat) ||
        lat < -90 ||
        lat > 90 ||
        Number.isNaN(lng) ||
        lng < -180 ||
        lng > 180
      ) {
        return res.status(400).json({
          error: 'Latitud o longitud fuera de rango'
        });
      }

      if (Number.isNaN(precio) || precio <= 0) {
        return res.status(400).json({
          error: 'El precio por hora debe ser mayor a 0'
        });
      }

      if (
        !Number.isInteger(capacidad) ||
        capacidad <= 0
      ) {
        return res.status(400).json({
          error: 'La capacidad debe ser un número entero mayor a 0'
        });
      }

      if (
        Number.isNaN(largo) ||
        largo <= 0 ||
        Number.isNaN(ancho) ||
        ancho <= 0
      ) {
        return res.status(400).json({
          error: 'El largo y el ancho deben ser mayores a 0'
        });
      }

      const espacio = await pool.query(
        `
        SELECT *
        FROM espacios_parqueo
        WHERE id = $1
          AND arrendador_id = $2
        `,
        [
          espacioId,
          usuarioId
        ]
      );

      if (espacio.rows.length === 0) {
        return res.status(404).json({
          error: 'Espacio no encontrado o no te pertenece'
        });
      }

      const anterior = espacio.rows[0];
      const resultado = await pool.query(
        `
        UPDATE espacios_parqueo
        SET
          titulo = $1,
          descripcion = $2,
          direccion = $3,
          latitud = $4,
          longitud = $5,
          precio_hora = $6,
          capacidad_vehiculos = $7,
          largo_metros = $8,
          ancho_metros = $9,
          tiene_camara = $10,
          tiene_porton = $11,
          tiene_iluminacion = $12,
          motivo_rechazo = NULL,
          fecha_rechazo = NULL
        WHERE id = $13 AND arrendador_id = $14
        RETURNING *
        `,
        [
          titulo.trim(),
          descripcion ? descripcion.trim() : null,
          direccion.trim(), lat, lng, precio, capacidad, largo, ancho,
          !!tiene_camara, !!tiene_porton, !!tiene_iluminacion,
          espacioId, usuarioId
        ]
      );

      const actualizado = resultado.rows[0];
      const campos = [
        ['Título', 'titulo', anterior.titulo, actualizado.titulo],
        ['Descripción', 'descripcion', anterior.descripcion, actualizado.descripcion],
        ['Dirección', 'direccion', anterior.direccion, actualizado.direccion],
        ['Latitud', 'latitud', anterior.latitud, actualizado.latitud],
        ['Longitud', 'longitud', anterior.longitud, actualizado.longitud],
        ['Precio por hora', 'precio_hora', anterior.precio_hora, actualizado.precio_hora],
        ['Capacidad', 'capacidad_vehiculos', anterior.capacidad_vehiculos, actualizado.capacidad_vehiculos],
        ['Largo (m)', 'largo_metros', anterior.largo_metros, actualizado.largo_metros],
        ['Ancho (m)', 'ancho_metros', anterior.ancho_metros, actualizado.ancho_metros],
        ['Tiene cámara', 'tiene_camara', anterior.tiene_camara, actualizado.tiene_camara],
        ['Tiene portón', 'tiene_porton', anterior.tiene_porton, actualizado.tiene_porton],
        ['Tiene iluminación', 'tiene_iluminacion', anterior.tiene_iluminacion, actualizado.tiene_iluminacion]
      ];
      const cambios = campos
        .filter(([, , antes, despues]) => String(antes ?? '') !== String(despues ?? ''))
        .map(([etiqueta, , antes, despues]) => `${etiqueta}: ${antes ?? 'Vacío'} → ${despues ?? 'Vacío'}`);
      const detalle = cambios.length ? cambios.join(' | ') : 'Se guardaron los datos del espacio.';
      const mensaje = `El arrendador ${req.usuario.nombre || ('ID ' + usuarioId)} modificó el espacio "${actualizado.titulo}" (ID ${actualizado.id}). Cambios: ${detalle}`;

      await pool.query(
        `INSERT INTO notificaciones (usuario_id, tipo, mensaje)
         SELECT id, 'espacio_modificado', $1
         FROM usuarios WHERE rol IN ('administrador', 'soporte')`,
        [mensaje]
      );

      res.json({
        ok: true,
        mensaje: 'Espacio actualizado correctamente. Su estado de aprobación se conserva y se notificó a administración y soporte.',
        espacio: actualizado,
        cambios
      });

    } catch (err) {

      console.error(
        'Error al editar espacio:',
        err
      );

      res.status(500).json({
        error: 'Error al editar el espacio'
      });
    }
  }
);


// ======================================================
// DELETE /api/espacios/:id/media/:mediaId
// Borrar una foto
// ======================================================

router.delete(
  '/:id/media/:mediaId',
  verificarToken,
  requiereRol('cliente'),
  async (req, res) => {

    try {

      const espacio =
        await espacioDelDueno(
          req.params.id,
          req.usuario.id
        );

      if (!espacio) {

        return res.status(404).json({
          error:
            'Espacio no encontrado o no te pertenece'
        });
      }

      if (
        !idValido(req.params.mediaId)
      ) {

        return res.status(404).json({
          error:
            'Foto no encontrada'
        });
      }

      const r = await pool.query(
        `
        DELETE FROM espacio_media

        WHERE id = $1
          AND espacio_id = $2

        RETURNING url
        `,
        [
          req.params.mediaId,
          espacio.id
        ]
      );

      if (r.rows.length === 0) {

        return res.status(404).json({
          error:
            'Foto no encontrada'
        });
      }

      fs.unlink(
        path.join(
          UPLOAD_DIR,
          path.basename(
            r.rows[0].url
          )
        ),
        () => {}
      );

      res.json({
        ok: true
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          'Error al borrar la foto'
      });
    }
  }
);


// ======================================================
// GET /api/espacios/:id/disponibilidad
// Fechas bloqueadas futuras
// ======================================================

router.get(
  '/:id/disponibilidad',
  verificarToken,
  requiereRol('cliente'),
  async (req, res) => {

    try {

      const espacio =
        await espacioDelDueno(
          req.params.id,
          req.usuario.id
        );

      if (!espacio) {

        return res.status(404).json({
          error:
            'Espacio no encontrado o no te pertenece'
        });
      }

      const r =
        await pool.query(
          `
          SELECT fecha

          FROM disponibilidad_espacio

          WHERE espacio_id = $1
            AND habilitado = FALSE
            AND fecha >= CURRENT_DATE

          ORDER BY fecha ASC
          `,
          [espacio.id]
        );

      res.json(
        r.rows.map(
          f => f.fecha
        )
      );

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          'Error al consultar el calendario'
      });
    }
  }
);


// ======================================================
// PUT /api/espacios/:id/disponibilidad
// Bloquear o desbloquear un día
// ======================================================

router.put(
  '/:id/disponibilidad',
  verificarToken,
  requiereRol('cliente'),
  async (req, res) => {

    const { fecha } = req.body;

    const habilitado =
      !!req.body.habilitado;

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(
        fecha || ''
      )
    ) {

      return res.status(400).json({
        error:
          'Fecha inválida'
      });
    }

    if (
      new Date(
        fecha + 'T00:00:00'
      ) <
      new Date(
        new Date().toDateString()
      )
    ) {

      return res.status(400).json({
        error:
          'No puedes cambiar un día que ya pasó'
      });
    }

    try {

      const espacio =
        await espacioDelDueno(
          req.params.id,
          req.usuario.id
        );

      if (!espacio) {

        return res.status(404).json({
          error:
            'Espacio no encontrado o no te pertenece'
        });
      }

      if (habilitado) {

        await pool.query(
          `
          DELETE FROM disponibilidad_espacio

          WHERE espacio_id = $1
            AND fecha = $2
          `,
          [
            espacio.id,
            fecha
          ]
        );

        return res.json({
          fecha,
          habilitado: true
        });
      }

      const choque =
        await pool.query(
          `
          SELECT 1
          FROM reservas

          WHERE espacio_id = $1
            AND estado IN (
              'pendiente',
              'en_proceso',
              'confirmada'
            )

            AND $2::date <
              fecha_fin::date + 1

            AND $2::date >=
              fecha_inicio::date

          LIMIT 1
          `,
          [
            espacio.id,
            fecha
          ]
        );

      if (choque.rows.length > 0) {

        return res.status(409).json({
          error:
            'Ese día ya tiene una reserva activa y no se puede bloquear'
        });
      }

      await pool.query(
        `
        INSERT INTO disponibilidad_espacio
        (
          espacio_id,
          fecha,
          habilitado
        )
        VALUES
        (
          $1,
          $2,
          FALSE
        )

        ON CONFLICT (
          espacio_id,
          fecha
        )

        DO UPDATE SET
          habilitado = FALSE
        `,
        [
          espacio.id,
          fecha
        ]
      );

      res.json({
        fecha,
        habilitado: false
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          'Error al actualizar el calendario'
      });
    }
  }
);


// ======================================================
// POST /api/espacios/:id/media
// Subir fotos del espacio propio (máximo 6 en total)
// ======================================================

router.post(
  '/:id/media',
  verificarToken,
  requiereRol('cliente'),
  (req, res, next) => {
    upload.array('fotos', MAX_FOTOS)(req, res, (err) => {
      if (err) {
        const mensaje = err.code === 'LIMIT_FILE_SIZE'
          ? 'Cada foto debe pesar máximo 5 MB'
          : err.code === 'LIMIT_FILE_COUNT'
            ? `Puedes subir máximo ${MAX_FOTOS} fotos por solicitud`
            : err.message || 'No se pudieron procesar las fotos';
        return res.status(400).json({ error: mensaje });
      }
      next();
    });
  },
  async (req, res) => {
    const { id } = req.params;
    const archivos = req.files || [];

    if (!idValido(id)) {
      archivos.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'ID de espacio inválido' });
    }

    if (archivos.length === 0) {
      return res.status(400).json({ error: 'Selecciona al menos una foto' });
    }

    try {
      const espacio = await espacioDelDueno(id, req.usuario.id);
      if (!espacio) {
        archivos.forEach((f) => fs.unlink(f.path, () => {}));
        return res.status(404).json({ error: 'Espacio no encontrado o no te pertenece' });
      }

      const existentes = await pool.query(
        'SELECT COUNT(*)::int AS total FROM espacio_media WHERE espacio_id = $1',
        [espacio.id]
      );
      const totalActual = existentes.rows[0].total;

      if (totalActual + archivos.length > MAX_FOTOS) {
        archivos.forEach((f) => fs.unlink(f.path, () => {}));
        return res.status(400).json({
          error: `Este espacio admite máximo ${MAX_FOTOS} fotos. Ya tienes ${totalActual}.`
        });
      }

      const guardadas = [];
      for (const archivo of archivos) {
        const url = `/uploads/espacios/${archivo.filename}`;
        const orden = totalActual + guardadas.length;
        const resultado = await pool.query(
          `INSERT INTO espacio_media (espacio_id, url, tipo, orden)
           VALUES ($1, $2, 'foto', $3)
           RETURNING id, url, tipo, orden`,
          [espacio.id, url, orden]
        );
        guardadas.push(resultado.rows[0]);
      }

      return res.status(201).json({ ok: true, fotos: guardadas });
    } catch (err) {
      console.error('Error al subir fotos del espacio:', err);
      archivos.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(500).json({ error: 'Error al guardar las fotos del espacio' });
    }
  }
);


module.exports = router;