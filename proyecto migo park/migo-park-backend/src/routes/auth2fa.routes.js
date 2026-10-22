// Verificación en dos pasos (2FA) para administradores, con un código de 6 dígitos.
// Se monta ANTES de auth.routes.js: intercepta el login de los roles con 2FA
// y deja pasar (next) todo lo demás al login normal.
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { enviarCodigo2fa, MENSAJE_DESTINO } = require('../utils/codigo2fa');

const router = express.Router();

// Roles que deben usar 2FA (agrega 'soporte' si también lo quieres para ellos)
const ROLES_2FA = ['administrador'];

const MINUTOS_CODIGO = 5;               // el código vale 5 minutos
const MAX_INTENTOS = 5;                 // 5 códigos incorrectos -> bloqueo
const BLOQUEO_MS = 15 * 60 * 1000;      // 15 minutos
const ESPERA_REENVIO_MS = 30 * 1000;    // mínimo 30 s entre un envío y otro

const codigos = new Map();    // usuarioId -> { hash, expira, intentos, creado }
const bloqueos = new Map();   // usuarioId -> timestamp hasta el que está bloqueado

function hashCodigo(codigo) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(codigo)).digest();
}

function estaBloqueado(id) {
  const hasta = bloqueos.get(id);
  if (!hasta) return false;
  if (hasta > Date.now()) return true;
  bloqueos.delete(id);
  return false;
}

// Genera un código nuevo (reemplaza el anterior) y lo "envía"
async function emitirCodigo(usuario) {
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  codigos.set(usuario.id, {
    hash: hashCodigo(codigo),
    expira: Date.now() + MINUTOS_CODIGO * 60 * 1000,
    intentos: 0,
    creado: Date.now(),
  });
  await enviarCodigo2fa(usuario.correo, usuario.nombre, codigo);
}

// Token de 10 minutos para el paso 2. NO lleva "id" ni "rol" y trae "proposito",
// así que NO sirve como sesión (el middleware lo rechaza).
function tokenTemporal(usuarioId) {
  return jwt.sign({ uid: usuarioId, proposito: '2fa' }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function sesionCompleta(usuario) {
  const token = jwt.sign(
    { id: usuario.id, rol: usuario.rol },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  return {
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      correo: usuario.correo,
      telefono: usuario.telefono,
      rol: usuario.rol
    },
    token,
  };
}

// Valida el token temporal y devuelve el usuario (o responde el error y devuelve null)
async function usuarioDelToken(req, res) {
  let payload;
  try {
    payload = jwt.verify(String((req.body || {}).tokenTemporal || ''), process.env.JWT_SECRET);
  } catch (err) {
    res.status(401).json({ error: 'La verificación expiró. Inicia sesión de nuevo.', reiniciar: true });
    return null;
  }
  if (payload.proposito !== '2fa' || !payload.uid) {
    res.status(401).json({ error: 'Token inválido', reiniciar: true });
    return null;
  }
  const r = await pool.query('SELECT * FROM usuarios WHERE id = $1', [payload.uid]);
  const usuario = r.rows[0];
  if (!usuario || !usuario.activo || !ROLES_2FA.includes(usuario.rol)) {
    res.status(401).json({ error: 'Token inválido', reiniciar: true });
    return null;
  }
  if (estaBloqueado(usuario.id)) {
    res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.', reiniciar: true });
    return null;
  }
  return usuario;
}

// POST /api/auth/login  -> solo actúa si es un rol con 2FA y la contraseña es correcta.
// En cualquier otro caso pasa al login normal (auth.routes.js).
router.post('/login', async (req, res, next) => {
  try {
    const { correo, contrasena } = req.body || {};
    if (!correo || !contrasena) return next();

    const r = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
    const usuario = r.rows[0];
    if (!usuario || !ROLES_2FA.includes(usuario.rol)) return next();

    const coincide = await bcrypt.compare(contrasena, usuario.contrasena_hash);
    if (!coincide || !usuario.activo) return next(); // el login normal responde el error

    if (estaBloqueado(usuario.id)) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.' });
    }

    await emitirCodigo(usuario);
    return res.json({
      requiere2fa: true,
      tokenTemporal: tokenTemporal(usuario.id),
      mensaje: MENSAJE_DESTINO,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// POST /api/auth/2fa/verificar { tokenTemporal, codigo } -> segundo paso del login
router.post('/2fa/verificar', async (req, res) => {
  try {
    const usuario = await usuarioDelToken(req, res);
    if (!usuario) return;

    const entrada = codigos.get(usuario.id);
    if (!entrada || entrada.expira < Date.now()) {
      codigos.delete(usuario.id);
      return res.status(401).json({ error: 'El código expiró. Pulsa "Reenviar código".' });
    }

    const limpio = String((req.body || {}).codigo || '').replace(/\s+/g, '');
    const correcto =
      /^\d{6}$/.test(limpio) &&
      crypto.timingSafeEqual(hashCodigo(limpio), entrada.hash);

    if (!correcto) {
      entrada.intentos += 1;
      if (entrada.intentos >= MAX_INTENTOS) {
        codigos.delete(usuario.id);
        bloqueos.set(usuario.id, Date.now() + BLOQUEO_MS);
        return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.', reiniciar: true });
      }
      return res.status(401).json({ error: 'Código incorrecto' });
    }

    codigos.delete(usuario.id);   // el código sirve una sola vez
    res.json(sesionCompleta(usuario));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al verificar el código' });
  }
});

// POST /api/auth/2fa/reenviar { tokenTemporal } -> genera y envía un código nuevo
router.post('/2fa/reenviar', async (req, res) => {
  try {
    const usuario = await usuarioDelToken(req, res);
    if (!usuario) return;

    const entrada = codigos.get(usuario.id);
    if (entrada && Date.now() - entrada.creado < ESPERA_REENVIO_MS) {
      return res.status(429).json({ error: 'Espera unos segundos antes de pedir otro código.' });
    }

    await emitirCodigo(usuario);
    res.json({ mensaje: MENSAJE_DESTINO });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al reenviar el código' });
  }
});

module.exports = router;