// Zona horaria de Colombia: debe ir antes de todo para que el servidor y la base de datos usen la misma hora
process.env.TZ = 'America/Bogota';

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { iniciarRecordatorios } = require('./utils/recordatorios');
const { exigirContrasenaSegura } = require('./utils/contrasena');
const verificacionRoutes = require('./routes/verificacion.routes');

const app = express();

// Cabeceras de seguridad (crossOriginResourcePolicy permite ver las fotos de /uploads desde el frontend)
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Solo tu frontend puede llamar a la API (agrega aquí otros orígenes si los necesitas)
// Permite cualquier puerto de localhost / 127.0.0.1 (y archivos abiertos con file://, solo para desarrollo)
app.use(cors({
    origin: (origin, callback) => {
        if (
            !origin ||
            origin === 'null' ||
            /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ) {
            return callback(null, true);
        }
        callback(new Error('Origen no permitido por CORS'));
    }
}));

app.use(express.json({ limit: '1mb' }));

// Contraseña segura (8+ caracteres, letras, números y especial) al registrarse, crear staff o restablecerla
// (va ANTES del límite de intentos para que una contraseña rechazada por débil no cuente como intento)
app.use('/api/auth/registro', exigirContrasenaSegura);
app.use('/api/auth/crear-staff', exigirContrasenaSegura);
app.use('/api/auth/restablecer-contrasena', exigirContrasenaSegura);

// Límites de intentos (cada ruta tiene su PROPIO contador; antes compartían uno solo y se llenaba rápido).
// skipSuccessfulRequests: los intentos que salen bien NO cuentan, solo los fallidos.
function limitar(max) {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        max,
        skipSuccessfulRequests: true,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' }
    });
}
app.use('/api/auth/login', limitar(10));
app.use('/api/auth/registro', limitar(30));
app.use('/api/auth/olvide-contrasena', limitar(10));
app.use('/api/auth/restablecer-contrasena', limitar(10));

// Límite propio para el 2FA (además, cada cuenta se bloquea 15 min tras 5 códigos fallidos)
app.use('/api/auth/2fa', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' }
}));

// Límite general para toda la API
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 200 }));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/api/health', (req, res) => {
    res.json({
        ok: true
    });
});

app.use('/api/auth', require('./routes/auth2fa.routes')); // 2FA: va ANTES del login normal
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/vehiculos', require('./routes/vehiculos.routes'));
// Verificación: no se puede aprobar un espacio sin documentos, fotos y la revisión completa (va ANTES de las rutas de espacios)
app.use('/api/espacios/:id/verificar', ...verificacionRoutes.puertaAprobacion);
app.use('/api/verificacion', verificacionRoutes);
app.use('/api/espacios', require('./routes/espacios.routes'));
app.use('/api/reservas', require('./routes/reservas.routes'));
app.use(
    '/api/reservas-arrendador',
    require('./routes/reservas-arrendador.routes')
);
app.use('/api/pagos', require('./routes/pagos.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/notificaciones', require('./routes/notificaciones.routes'));
app.use('/api/soporte', require('./routes/soporte.routes'));

// Calificaciones
app.use(
    '/api/calificaciones',
    require('./routes/calificaciones.routes')
);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
    console.log(
        `Migo Park backend corriendo en http://localhost:${PORT}`
    );

    iniciarRecordatorios();
});