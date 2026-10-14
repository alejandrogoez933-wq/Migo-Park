const express = require('express');
const pool = require('../db');

const {
    verificarToken,
    requiereRol
} = require('../middlewares/auth.middleware');

const router = express.Router();


// GET /api/reservas-arrendador
router.get(
    '/',
    verificarToken,
    requiereRol('cliente'),
    async (req, res) => {

        try {

            const arrendadorId = req.usuario.id;

            const resultado = await pool.query(
                `
                SELECT
                    r.id,
                    r.espacio_id,

                    e.titulo AS espacio_titulo,
                    e.direccion AS espacio_direccion,

                    r.conductor_id,

                    u.nombre AS conductor_nombre,
                    u.correo AS conductor_correo,
                    u.telefono AS conductor_telefono,

                    r.fecha_inicio,
                    r.fecha_fin,

                    ROUND(
                        EXTRACT(
                            EPOCH FROM (
                                r.fecha_fin - r.fecha_inicio
                            )
                        ) / 3600,
                        2
                    ) AS horas,

                    r.subtotal,
                    r.comision,
                    r.total,

                    r.estado,
                    r.fecha_creacion,

                    COALESCE(
                        p.estado::text,
                        'sin_pago'
                    ) AS pago_estado,

                    p.metodo_pago,
                    p.monto AS pago_monto,
                    p.fecha_pago

                FROM reservas r

                INNER JOIN espacios_parqueo e
                    ON e.id = r.espacio_id

                INNER JOIN usuarios u
                    ON u.id = r.conductor_id

                LEFT JOIN pagos p
                    ON p.reserva_id = r.id

                WHERE e.arrendador_id = $1

                ORDER BY r.fecha_inicio DESC
                `,
                [arrendadorId]
            );


            const reservas = resultado.rows.map(r => ({

                id: r.id,

                espacio_id: r.espacio_id,

                espacio_titulo: r.espacio_titulo,

                espacio_direccion: r.espacio_direccion,

                conductor_id: r.conductor_id,

                conductor_nombre: r.conductor_nombre,

                conductor_correo: r.conductor_correo,

                conductor_telefono: r.conductor_telefono,

                fecha_inicio: r.fecha_inicio,

                fecha_fin: r.fecha_fin,

                horas: Number(r.horas || 0),

                subtotal: Number(r.subtotal || 0),

                comision: Number(r.comision || 0),

                total: Number(r.total || 0),

                estado: r.estado,

                fecha_creacion: r.fecha_creacion,

                pago_estado: r.pago_estado,

                metodo_pago: r.metodo_pago || null,

                pago_monto: Number(r.pago_monto || 0),

                fecha_pago: r.fecha_pago || null,

                // Lo que recibe el arrendador
                ganancia: Number(r.subtotal || 0)

            }));


            const reservasPagadas = reservas.filter(
                r => r.pago_estado === 'completado'
            );


            const resumen = {

                reservas: reservas.length,

                total_reservas: reservas.length,

                reservas_pagadas: reservasPagadas.length,

                total_ganado: reservasPagadas.reduce(
                    (total, r) => total + r.ganancia,
                    0
                )

            };


            res.json({
                resumen,
                reservas
            });

        } catch (err) {

            console.error(
                'Error al consultar reservas del arrendador:',
                err
            );

            res.status(500).json({
                error:
                    'Error al consultar las reservas de tus espacios'
            });
        }
    }
);


module.exports = router;