const jwt = require('jsonwebtoken');
const pool = require('../db');
require('dotenv').config();

// Valida el token Y consulta la base de datos, para que un usuario bloqueado
// pierda el acceso de inmediato (sin esperar a que venza su token de 8 horas).
async function verificarToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  const token = header.split(' ')[1];

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  // Un token temporal de 2FA (a medio login) NUNCA sirve como sesión
  if (payload.proposito || !payload.id) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  try {
    const resultado = await pool.query('SELECT rol, activo FROM usuarios WHERE id = $1', [payload.id]);
    const fila = resultado.rows[0];
    if (!fila) return res.status(401).json({ error: 'El usuario ya no existe' });
    if (!fila.activo) return res.status(401).json({ error: 'Tu cuenta está bloqueada. Contacta a soporte.' });

    // El rol se toma de la base de datos (no del token), así un cambio de rol aplica al instante
    req.usuario = { ...payload, rol: fila.rol };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al validar la sesión' });
  }
}

function requiereRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'No autenticado' });
    if (!rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }
    next();
  };
}

module.exports = { verificarToken, requiereRol };