// Reglas de verificación de identidad y propiedad de los espacios.
const fs = require('fs');
const path = require('path');

// Carpeta PRIVADA (fuera de /uploads, que es pública). Nunca se sirve con express.static.
const DIR_PRIVADO = path.join(__dirname, '..', '..', 'documentos-privados');
fs.mkdirSync(DIR_PRIVADO, { recursive: true });

const RELACIONES = ['propietario', 'arrendatario', 'administrador'];

const ETIQUETAS = {
  cedula_frente: 'Cédula (frente)',
  cedula_reverso: 'Cédula (reverso)',
  selfie_cedula: 'Selfie sosteniendo la cédula',
  certificado_tradicion: 'Certificado de tradición y libertad',
  escritura: 'Escritura pública',
  carta_autorizacion: 'Carta de autorización del propietario',
  cedula_propietario: 'Cédula del propietario',
};

const TIPOS_IDENTIDAD = ['cedula_frente', 'cedula_reverso', 'selfie_cedula']; // del usuario, no del espacio
const TIPOS = Object.keys(ETIQUETAS);
const SOLO_IMAGEN = new Set(TIPOS_IDENTIDAD); // la cédula y la selfie deben ser foto; lo demás puede ser PDF

// Casillas que el revisor debe marcar para poder aprobar
const CHECKLIST = ['existe_mapa', 'fotos_originales', 'identidad_coincide', 'documento_valido', 'direccion_coincide'];

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// Detecta el tipo REAL del archivo mirando sus primeros bytes (el "mimetype" lo declara el cliente y se puede falsear)
function detectarMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  return null;
}

function error400(mensaje) {
  const e = new Error(mensaje);
  e.status = 400;
  return e;
}

// Valida los archivos que llegaron de multer.fields(...) y devuelve { tipo: { buffer, mimeReal } }
function validarArchivos(files) {
  const salida = {};
  for (const tipo of TIPOS) {
    const f = files && files[tipo] && files[tipo][0];
    if (!f) continue;
    const mimeReal = detectarMime(f.buffer);
    if (!mimeReal) throw error400(`"${ETIQUETAS[tipo]}": el archivo no es una imagen (JPG, PNG, WEBP) ni un PDF válido.`);
    if (SOLO_IMAGEN.has(tipo) && mimeReal === 'application/pdf') {
      throw error400(`"${ETIQUETAS[tipo]}" debe ser una foto (JPG, PNG o WEBP), no un PDF.`);
    }
    salida[tipo] = { buffer: f.buffer, mimeReal };
  }
  return salida;
}

// Qué documentos faltan (devuelve una lista de textos; vacía = está completo)
function documentosFaltantes({ relacion, tiposEspacio, tiposIdentidad, identidadVerificada }) {
  const f = [];
  if (!RELACIONES.includes(relacion)) f.push('Indicar si eres propietario, arrendatario o administrador');

  if (!identidadVerificada) {
    for (const t of TIPOS_IDENTIDAD) if (!tiposIdentidad.has(t)) f.push(ETIQUETAS[t]);
  }

  if (relacion === 'propietario') {
    if (!tiposEspacio.has('certificado_tradicion') && !tiposEspacio.has('escritura')) {
      f.push('Certificado de tradición y libertad o escritura pública');
    }
  } else if (relacion === 'arrendatario' || relacion === 'administrador') {
    for (const t of ['carta_autorizacion', 'cedula_propietario']) {
      if (!tiposEspacio.has(t)) f.push(ETIQUETAS[t]);
    }
  }
  return f;
}

// Documentos que ya tiene el usuario: los de identidad (sin espacio) y los del espacio indicado
async function cargarDocumentos(db, usuarioId, espacioId) {
  const r = await db.query(
    `SELECT id, espacio_id, tipo, mime, fecha
     FROM documentos_verificacion
     WHERE usuario_id = $1 AND (espacio_id IS NULL OR espacio_id = $2)
     ORDER BY fecha`,
    [usuarioId, espacioId]
  );
  const identidad = r.rows.filter((d) => d.espacio_id === null);
  const espacio = r.rows.filter((d) => d.espacio_id !== null);
  return { identidad, espacio, todos: r.rows };
}

// Guarda los archivos en la carpeta privada y los registra (reemplaza los del mismo tipo)
async function guardarDocumentos(client, { usuarioId, espacioId, archivos, identidadVerificada }) {
  const crypto = require('crypto');
  const escritos = [];
  const reemplazados = [];

  for (const [tipo, f] of Object.entries(archivos)) {
    const esIdentidad = TIPOS_IDENTIDAD.includes(tipo);
    if (esIdentidad && identidadVerificada) continue; // ya verificada: no se vuelve a pedir

    const nombre = crypto.randomBytes(24).toString('hex') + EXT[f.mimeReal]; // nombre aleatorio, no adivinable
    await fs.promises.writeFile(path.join(DIR_PRIVADO, nombre), f.buffer, { flag: 'wx', mode: 0o600 });
    escritos.push(nombre);

    const viejos = esIdentidad
      ? await client.query(
          'DELETE FROM documentos_verificacion WHERE usuario_id = $1 AND tipo = $2 AND espacio_id IS NULL RETURNING archivo',
          [usuarioId, tipo])
      : await client.query(
          'DELETE FROM documentos_verificacion WHERE espacio_id = $1 AND tipo = $2 RETURNING archivo',
          [espacioId, tipo]);
    viejos.rows.forEach((v) => reemplazados.push(v.archivo));

    await client.query(
      `INSERT INTO documentos_verificacion (usuario_id, espacio_id, tipo, archivo, mime)
       VALUES ($1, $2, $3, $4, $5)`,
      [usuarioId, esIdentidad ? null : espacioId, tipo, nombre, f.mimeReal]
    );
  }
  return { escritos, reemplazados };
}

async function borrarArchivos(nombres) {
  for (const n of nombres) {
    try { await fs.promises.unlink(path.join(DIR_PRIVADO, path.basename(n))); } catch (e) { /* ya no existe */ }
  }
}

module.exports = {
  DIR_PRIVADO, RELACIONES, ETIQUETAS, TIPOS, TIPOS_IDENTIDAD, CHECKLIST,
  validarArchivos, documentosFaltantes, cargarDocumentos, guardarDocumentos, borrarArchivos,
};