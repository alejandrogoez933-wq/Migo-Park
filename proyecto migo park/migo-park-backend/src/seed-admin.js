const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('./db');
require('dotenv').config();

// Puedes fijar correo/contraseña propios así, en vez de escribirlos en el código:
//   ADMIN_EMAIL=tucorreo@dominio.com ADMIN_PASSWORD=tuclave node src/seed-admin.js
async function crearAdminInicial() {
  const correo = process.env.ADMIN_EMAIL || 'admin@migopark.com';
  const generada = crypto.randomBytes(9).toString('base64url'); // se usa solo si no diste ADMIN_PASSWORD
  const contrasena = process.env.ADMIN_PASSWORD || generada;

  try {
    const existe = await pool.query('SELECT id FROM usuarios WHERE correo = $1', [correo]);

    if (existe.rows.length > 0) {
      console.log('Ya existe un administrador con ese correo. No se creó nada nuevo.');
      process.exit(0);
    }

    const hash = await bcrypt.hash(contrasena, 10);

    await pool.query(
      `INSERT INTO usuarios (nombre, correo, contrasena_hash, rol)
       VALUES ($1, $2, $3, 'administrador')`,
      ['Administrador Principal', correo, hash]
    );

    console.log('Administrador creado correctamente:');
    console.log('  Correo:    ', correo);
    console.log('  Contraseña:', contrasena);
    console.log('Guárdala ahora: no queda escrita en ningún archivo y no se puede volver a mostrar.');
    process.exit(0);
  } catch (err) {
    console.error('Error creando el administrador:', err);
    process.exit(1);
  }
}

crearAdminInicial();