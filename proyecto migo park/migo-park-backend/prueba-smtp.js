require('dotenv').config();

const nodemailer = require('nodemailer');

console.log('--- PRUEBA SMTP ---');
console.log('SMTP_USER:', process.env.SMTP_USER);
console.log('SMTP_HOST:', process.env.SMTP_HOST);
console.log('SMTP_PORT:', process.env.SMTP_PORT);
console.log('SMTP_PASS existe:', !!process.env.SMTP_PASS);
console.log('SMTP_PASS longitud:', process.env.SMTP_PASS ? process.env.SMTP_PASS.length : 0);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

transporter.verify()
  .then(() => {
    console.log('--------------------------------');
    console.log('SMTP OK: Gmail acepta las credenciales.');
    console.log('--------------------------------');
  })
  .catch((error) => {
    console.log('--------------------------------');
    console.log('SMTP ERROR');
    console.log('Código:', error.code);
    console.log('Código respuesta:', error.responseCode);
    console.log('Comando:', error.command);
    console.log('--------------------------------');
  });