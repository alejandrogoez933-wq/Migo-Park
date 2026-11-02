// Modo desarrollo: el código de verificación se muestra en la terminal del backend
// (igual que utils/correo.js con la recuperación de contraseña). No se envían correos reales.
// Para producción, cambia el cuerpo de enviarCodigo2fa por un envío real de correo
// y ajusta MENSAJE_DESTINO.

async function enviarCodigo2fa(correo, nombre, codigo) {
  // Se quitan saltos de línea y caracteres de control para que nadie pueda inventar líneas falsas en el registro
  const correoLog = String(correo).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, 200);
  console.log('');
  console.log('========== CÓDIGO DE VERIFICACIÓN (modo desarrollo) ==========');
  console.log(`Usuario: ${correoLog}`);
  console.log(`Código:  ${codigo}      (vale 5 minutos)`);
  console.log('==============================================================');
  console.log('');
}

const MENSAJE_DESTINO =
  'Te enviamos un código de 6 dígitos. (Modo desarrollo: míralo en la terminal del backend.)';

module.exports = { enviarCodigo2fa, MENSAJE_DESTINO };