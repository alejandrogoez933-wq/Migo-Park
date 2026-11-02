const { Pool, Client } = require('pg');
require('dotenv').config();

// Cliente que fija la hora de Colombia y ESPERA a que termine antes de entregar la conexión.
// Sin esto, NOW() de la base de datos iba 5 horas adelantado y las reservas se marcaban "completadas" antes de tiempo.
class ClienteColombia extends Client {
  connect(callback) {
    const fijarZona = () => super.query("SET TIME ZONE 'America/Bogota'");
    if (typeof callback === 'function') {
      super.connect((err) => {
        if (err) return callback(err);
        fijarZona().then(() => callback(), callback);
      });
      return undefined;
    }
    return super.connect().then(fijarZona).then(() => undefined);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  Client: ClienteColombia,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL', err);
});

module.exports = pool;