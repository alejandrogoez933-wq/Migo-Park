// Modo desarrollo: el código de recuperación se muestra en la terminal.
// No se envían correos reales.

async function enviarCorreoRecuperacion(correo, nombre, token) {
  console.log('--- MODO DESARROLLO: correo no enviado ---');
  console.log(`Código de recuperación para ${correo}: ${token}`);
  console.log('--------------------------------------------');
}

async function enviarCorreoBienvenida(correo, nombre) {
  console.log('--- MODO DESARROLLO: correo de bienvenida no enviado ---');
  console.log(`Cuenta creada para: ${correo}`);
  console.log('--------------------------------------------------------');
}

module.exports = {
  enviarCorreoRecuperacion,
  enviarCorreoBienvenida
};