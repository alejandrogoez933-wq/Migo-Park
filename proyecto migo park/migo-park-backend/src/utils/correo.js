// Modo desarrollo: el código de recuperación se muestra en la terminal.
// No se envían correos reales.

async function enviarCorreoRecuperacion(correo, nombre, token) {
  // Se quitan saltos de línea y caracteres de control para que nadie pueda inventar líneas falsas en el registro
  const correoLog = String(correo).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, 200);
  console.log('--- MODO DESARROLLO: correo no enviado ---');
  console.log(`Código de recuperación para ${correoLog}: ${token}`);
  console.log('--------------------------------------------');
}

async function enviarCorreoBienvenida(correo, nombre) {
  // Se quitan saltos de línea y caracteres de control para que nadie pueda inventar líneas falsas en el registro
  const correoLog = String(correo).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, 200);
  console.log('--- MODO DESARROLLO: correo de bienvenida no enviado ---');
  console.log(`Cuenta creada para: ${correoLog}`);
  console.log('--------------------------------------------------------');
}

module.exports = {
  enviarCorreoRecuperacion,
  enviarCorreoBienvenida
};