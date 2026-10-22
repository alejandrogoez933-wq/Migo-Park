const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { verificarToken } = require('../middlewares/auth.middleware');
const { enviarCorreoRecuperacion } = require('../utils/correo');

const router = express.Router();
const MINUTOS_TOKEN_RESET = 2; // Código válido durante 2 minutos (se aplica en PostgreSQL).

// POST /api/auth/registro -> el registro público SIEMPRE crea clientes
router.post('/registro', async (req, res) => {
  const { nombre, correo, contrasena, telefono } = req.body; // se ignora cualquier "rol" que llegue
  if (!nombre || !correo || !contrasena) {
    return res.status(400).json({ error: 'Nombre, correo y contraseña son obligatorios' });
  }

  try {
    const existe = await pool.query('SELECT id FROM usuarios WHERE correo = $1', [correo]);
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
    }

    const hash = await bcrypt.hash(contrasena, 10);

    const resultado = await pool.query(
      `INSERT INTO usuarios (nombre, correo, contrasena_hash, telefono, rol)
       VALUES ($1, $2, $3, $4, 'cliente')
       RETURNING id, nombre, correo, telefono, rol, fecha_registro`,
      [nombre, correo, hash, telefono || null]
    );

    const usuario = resultado.rows[0];

    
    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.status(201).json({ usuario, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el usuario' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { correo, contrasena } = req.body;

  if (!correo || !contrasena) {
    return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
  }

  try {
    const resultado = await pool.query(
      'SELECT * FROM usuarios WHERE correo = $1',
      [correo]
    );

    const usuario = resultado.rows[0];

    if (!usuario) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const coincide = await bcrypt.compare(
      contrasena,
      usuario.contrasena_hash
    );

    if (!coincide) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Se revisa DESPUÉS de la contraseña para no revelar a extraños qué cuentas están bloqueadas
    if (!usuario.activo) {
      return res.status(403).json({
        error: 'Tu cuenta está bloqueada. Contacta a soporte.'
      });
    }

    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        correo: usuario.correo,
        telefono: usuario.telefono,
        rol: usuario.rol
      },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/auth/perfil (requiere estar autenticado)
router.get('/perfil', verificarToken, async (req, res) => {
  try {
    const resultado = await pool.query(
      'SELECT id, nombre, correo, telefono, rol, foto_perfil_url, fecha_registro FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(resultado.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el perfil' });
  }
});

// PUT /api/auth/perfil (requiere estar autenticado)
router.put('/perfil', verificarToken, async (req, res) => {
  const { nombre, telefono, foto_perfil_url } = req.body;

  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE usuarios
       SET nombre = $1, telefono = $2, foto_perfil_url = $3
       WHERE id = $4
       RETURNING id, nombre, correo, telefono, rol, foto_perfil_url, fecha_registro`,
      [
        nombre.trim(),
        telefono || null,
        foto_perfil_url || null,
        req.usuario.id
      ]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({
      mensaje: 'Perfil actualizado correctamente',
      usuario: resultado.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el perfil' });
  }
});

// POST /api/auth/crear-staff -> SOLO un administrador puede crear cuentas de soporte/administrador
router.post('/crear-staff', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'administrador') {
    return res.status(403).json({
      error: 'Solo un administrador puede crear cuentas de staff'
    });
  }

  const { nombre, correo, contrasena, telefono, rol } = req.body;

  if (!nombre || !correo || !contrasena || !rol) {
    return res.status(400).json({
      error: 'Nombre, correo, contraseña y rol son obligatorios'
    });
  }

  if (!['administrador', 'soporte'].includes(rol)) {
    return res.status(400).json({
      error: 'El rol debe ser administrador o soporte'
    });
  }

  if (contrasena.length < 8) {
    return res.status(400).json({
      error: 'La contraseña del staff debe tener al menos 8 caracteres'
    });
  }

  try {
    const existe = await pool.query(
      'SELECT id FROM usuarios WHERE correo = $1',
      [correo]
    );

    if (existe.rows.length > 0) {
      return res.status(409).json({
        error: 'Ya existe un usuario con ese correo'
      });
    }

    const hash = await bcrypt.hash(contrasena, 10);

    const resultado = await pool.query(
      `INSERT INTO usuarios (nombre, correo, contrasena_hash, telefono, rol)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nombre, correo, telefono, rol, fecha_registro`,
      [nombre, correo, hash, telefono || null, rol]
    );

    const usuario = resultado.rows[0];

    res.status(201).json(usuario);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la cuenta de staff' });
  }
});

// POST /api/auth/olvide-contrasena  { correo }
// Siempre responde igual, exista o no el correo, para no revelar qué cuentas existen.
router.post('/olvide-contrasena', async (req, res) => {
  const correo = String(req.body.correo || '').trim().toLowerCase();

  const RESPUESTA = {
    mensaje: 'Si el correo existe, te enviamos un código para restablecer tu contraseña.'
  };

  if (!correo) {
    return res.status(400).json({
      error: 'El correo es obligatorio'
    });
  }

  try {
    const r = await pool.query(
      'SELECT id, nombre, activo FROM usuarios WHERE correo = $1',
      [correo]
    );

    if (r.rows.length === 0 || !r.rows[0].activo) {
      return res.json(RESPUESTA);
    }

    const usuario = r.rows[0];

    const token = String(crypto.randomInt(100000, 1000000));

    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    // Usar el reloj de PostgreSQL tanto para guardar como para validar la expiración.
    // Así se evita que el reloj/zona horaria del servidor Node y la base de datos difieran.
    await pool.query(
      `UPDATE usuarios
       SET reset_token_hash = $1,
           reset_token_expira = NOW() + INTERVAL '2 minutes'
       WHERE id = $2`,
      [tokenHash, usuario.id]
    );

    await enviarCorreoRecuperacion(
      correo,
      usuario.nombre,
      token
    );

    res.json(RESPUESTA);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Error al procesar la solicitud'
    });
  }
});

// PUT /api/auth/restablecer-contrasena  { token, contrasena }
router.put('/restablecer-contrasena', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const contrasena = String(req.body.contrasena || '');

  if (!token) {
    return res.status(400).json({
      error: 'Escribe el código que recibiste'
    });
  }

  if (contrasena.length < 8) {
    return res.status(400).json({
      error: 'La contraseña debe tener al menos 8 caracteres'
    });
  }

  try {
    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const r = await pool.query(
      'SELECT id FROM usuarios WHERE reset_token_hash = $1 AND reset_token_expira > NOW()',
      [tokenHash]
    );

    if (r.rows.length === 0) {
      return res.status(400).json({
        error: 'El código no es válido o ya expiró. Solicita uno nuevo.'
      });
    }

    const hash = await bcrypt.hash(contrasena, 10);

  const actualizacion = await pool.query(
  'UPDATE usuarios SET contrasena_hash = $1, reset_token_hash = NULL, reset_token_expira = NULL WHERE id = $2 RETURNING id, correo',
  [hash, r.rows[0].id]
);

if (actualizacion.rows.length === 0) {
  return res.status(500).json({
    error: 'No se pudo actualizar la contraseña'
  });
}

console.log(
  'Contraseña actualizada para:',
  actualizacion.rows[0].correo
);

res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Error al restablecer la contraseña'
    });
  }
});

module.exports = router;
