// Política de contraseñas de Migo Park:
//   - mínimo 8 caracteres
//   - al menos una letra, un número y un carácter especial (! @ # $ % & * ...)
// Solo se exige al CREAR o CAMBIAR una contraseña. El login NO la valida,
// para que las cuentas que ya existen puedan seguir entrando.

const MINIMO = 8;
const MAXIMO_BYTES = 72; // límite real de bcrypt: lo que pase de 72 bytes se ignoraría

function faltantes(c) {
  const f = [];
  if (c.length < MINIMO) f.push(`mínimo ${MINIMO} caracteres`);
  if (!/\p{L}/u.test(c)) f.push('letras');
  if (!/\d/.test(c)) f.push('números');
  if (!/[^\p{L}\d\s]/u.test(c)) f.push('un carácter especial (por ejemplo ! @ # $ % &)');
  return f;
}

// Devuelve un texto con el error, o null si la contraseña es válida
function validarContrasena(contrasena) {
  const c = String(contrasena ?? '');
  if (Buffer.byteLength(c, 'utf8') > MAXIMO_BYTES) {
    return `La contraseña es demasiado larga (máximo ${MAXIMO_BYTES} caracteres).`;
  }
  const f = faltantes(c);
  if (f.length === 0) return null;
  return `La contraseña debe tener mínimo ${MINIMO} caracteres, con letras, números y al menos un carácter especial. Le falta: ${f.join(', ')}.`;
}

// Middleware: se monta en las rutas que crean o cambian contraseñas (ver server.js)
function exigirContrasenaSegura(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PUT') return next();
  const contrasena = req.body && req.body.contrasena;
  if (contrasena === undefined || contrasena === null || contrasena === '') return next(); // la ruta ya avisa que es obligatoria
  const error = validarContrasena(contrasena);
  if (error) return res.status(400).json({ error });
  next();
}

// Genera una contraseña aleatoria que cumple la política (para seed-admin)
function generarContrasenaSegura(largo = 14) {
  const crypto = require('crypto');
  const letrasMin = 'abcdefghijkmnpqrstuvwxyz';
  const letrasMay = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const numeros = '23456789';
  const especiales = '!@#$%&*?-_+=';
  const todo = letrasMin + letrasMay + numeros + especiales;
  const elegir = (set) => set[crypto.randomInt(0, set.length)];
  const chars = [elegir(letrasMin), elegir(letrasMay), elegir(numeros), elegir(especiales)];
  while (chars.length < largo) chars.push(elegir(todo));
  for (let i = chars.length - 1; i > 0; i--) { // mezclar (Fisher-Yates)
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

module.exports = { validarContrasena, exigirContrasenaSegura, generarContrasenaSegura };