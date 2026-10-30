// Verificación de identidad y propiedad al publicar un espacio.
// - Agrega al formulario "Publicar espacio" los campos de documentos.
// - Envía todo junto (datos, capacidad, medidas, fotos y documentos) a /api/verificacion/publicar (si falta algo, no se crea el espacio).
// - Agrega la ventana "Documentos" de Mis espacios (subirDocumentos).
// Se carga en home.html antes del script principal.
(function () {
  const IMG = 'image/jpeg,image/png,image/webp';
  const IMG_PDF = IMG + ',application/pdf';

  const CAMPOS = {
    identidad: [
      ['cedula_frente', 'Cédula - frente (foto)', IMG],
      ['cedula_reverso', 'Cédula - reverso (foto)', IMG],
      ['selfie_cedula', 'Selfie sosteniendo tu cédula: se ve tu cara y la cédula (foto)', IMG],
    ],
    propietario: [
      ['certificado_tradicion', 'Certificado de tradición y libertad (PDF o foto)', IMG_PDF],
      ['escritura', 'O la escritura pública (PDF o foto)', IMG_PDF],
    ],
    tercero: [
      ['carta_autorizacion', 'Carta de autorización del propietario, firmada (PDF o foto)', IMG_PDF],
      ['cedula_propietario', 'Copia de la cédula del propietario (PDF o foto)', IMG_PDF],
    ],
  };

  const api = () => (typeof API_URL !== 'undefined' ? API_URL : 'http://localhost:4000/api');
  const tokenActual = () => sessionStorage.getItem('token');
  const aviso = (el, texto, error) => {
    if (typeof mostrar === 'function') return mostrar(el, texto, error);
    el.textContent = texto;
  };
  const sinSesion = (resp) => { if (resp.status === 401 && typeof cerrarSesion === 'function') cerrarSesion(); };

  function grupoHTML(titulo, lista, prefijo, id) {
    return `
      <div id="${id}" style="margin-top:10px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">${titulo}</div>
        ${lista.map(([tipo, etiqueta, accept]) => `
          <label style="display:block;font-size:13px;color:#555;margin:6px 0 2px;">${etiqueta}</label>
          <input type="file" id="${prefijo}_${tipo}" accept="${accept}">`).join('')}
      </div>`;
  }

  function selectRelacionHTML(id) {
    return `
      <select id="${id}">
        <option value="">¿Qué relación tienes con el parqueadero?</option>
        <option value="propietario">Soy el propietario</option>
        <option value="arrendatario">Soy arrendatario (el propietario me autoriza)</option>
        <option value="administrador">Soy administrador del inmueble</option>
      </select>`;
  }

  // Muestra solo los grupos que corresponden a la relación elegida
  function alternarGrupos(prefijo, relacion) {
    const p = document.getElementById(`${prefijo}_grupoPropietario`);
    const t = document.getElementById(`${prefijo}_grupoTercero`);
    if (p) p.style.display = relacion === 'propietario' ? 'block' : 'none';
    if (t) t.style.display = (relacion === 'arrendatario' || relacion === 'administrador') ? 'block' : 'none';
  }

  const estado = { identidad_verificada: false, identidad_documentos: [] };

  async function cargarEstado() {
    try {
      const resp = await fetch(`${api()}/verificacion/mi-estado`, { headers: { Authorization: `Bearer ${tokenActual()}` } });
      if (!resp.ok) return;
      Object.assign(estado, await resp.json());
      pintarIdentidad('pub');
    } catch (e) { /* sin conexión: se valida al enviar */ }
  }

  function pintarIdentidad(prefijo) {
    const g = document.getElementById(`${prefijo}_grupoIdentidad`);
    if (!g) return;
    const nota = g.querySelector('.nota-identidad');
    if (estado.identidad_verificada) {
      g.querySelectorAll('input[type=file], label').forEach((el) => { el.style.display = 'none'; });
      nota.textContent = '✔ Tu identidad ya fue verificada. No necesitas volver a subir la cédula ni la selfie.';
    } else if (estado.identidad_documentos.length > 0) {
      nota.textContent = `Ya subiste ${estado.identidad_documentos.length} de 3 documentos de identidad. Solo sube los que falten (o reemplaza alguno).`;
    } else {
      nota.textContent = '';
    }
  }

  function archivoDe(prefijo, tipo) {
    const el = document.getElementById(`${prefijo}_${tipo}`);
    return el && el.files && el.files[0] ? el.files[0] : null;
  }

  // ¿Qué falta, según lo elegido y lo que ya está subido?
  function faltantesLocales(prefijo, relacion) {
    const f = [];
    if (!relacion) f.push('indica tu relación con el parqueadero');
    if (!estado.identidad_verificada) {
      for (const [tipo, etiqueta] of CAMPOS.identidad) {
        if (!archivoDe(prefijo, tipo) && !estado.identidad_documentos.includes(tipo)) f.push(etiqueta.split(' (')[0]);
      }
    }
    if (relacion === 'propietario') {
      if (!archivoDe(prefijo, 'certificado_tradicion') && !archivoDe(prefijo, 'escritura')) f.push('certificado de tradición y libertad o escritura');
    } else if (relacion === 'arrendatario' || relacion === 'administrador') {
      if (!archivoDe(prefijo, 'carta_autorizacion')) f.push('carta de autorización del propietario');
      if (!archivoDe(prefijo, 'cedula_propietario')) f.push('cédula del propietario');
    }
    return f;
  }

  // ------------------------------------------------------------------
  // Formulario "Publicar espacio"
  // ------------------------------------------------------------------
  const form = document.getElementById('formPublicar');
  if (form) {
    const bloque = document.createElement('fieldset');
    bloque.id = 'bloqueVerificacion';
    bloque.style.cssText = 'border:1px solid #ddd;border-radius:10px;padding:12px;margin:12px 0;';
    bloque.innerHTML = `
      <legend style="font-weight:700;padding:0 6px;">Verificación (obligatoria)</legend>
      <p style="font-size:13px;color:#666;margin:0 0 8px;">
        Para proteger a los conductores, revisamos que el parqueadero exista y que tú estés autorizado a ofrecerlo.
        Tus documentos solo los ve el equipo de verificación.
      </p>
      ${selectRelacionHTML('pub_relacion')}
      <div id="pub_grupoIdentidad" style="margin-top:10px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Tu identidad</div>
        <div class="nota-identidad" style="font-size:13px;color:#2e7d32;"></div>
        ${CAMPOS.identidad.map(([tipo, etiqueta, accept]) => `
          <label style="display:block;font-size:13px;color:#555;margin:6px 0 2px;">${etiqueta}</label>
          <input type="file" id="pub_${tipo}" accept="${accept}">`).join('')}
      </div>
      <div id="pub_grupoPropietario" style="display:none;margin-top:10px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Prueba de que eres el propietario</div>
        ${CAMPOS.propietario.map(([tipo, etiqueta, accept]) => `
          <label style="display:block;font-size:13px;color:#555;margin:6px 0 2px;">${etiqueta}</label>
          <input type="file" id="pub_${tipo}" accept="${accept}">`).join('')}
        <div style="font-size:12px;color:#777;margin-top:4px;">El certificado se pide en la Superintendencia de Notariado y Registro con el número de matrícula inmobiliaria.</div>
      </div>
      <div id="pub_grupoTercero" style="display:none;margin-top:10px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Autorización del propietario</div>
        ${CAMPOS.tercero.map(([tipo, etiqueta, accept]) => `
          <label style="display:block;font-size:13px;color:#555;margin:6px 0 2px;">${etiqueta}</label>
          <input type="file" id="pub_${tipo}" accept="${accept}">`).join('')}
      </div>
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#555;margin-top:12px;">
        <input type="checkbox" id="pub_acepta" style="width:auto;margin:3px 0 0;">
        <span>Autorizo a Migo Park a tratar mis datos personales y documentos únicamente para verificar mi identidad y la titularidad del parqueadero.</span>
      </label>`;

    const boton = form.querySelector('button[type="submit"]');
    boton.insertAdjacentElement('beforebegin', bloque);

    document.getElementById('pub_relacion').addEventListener('change', (e) => alternarGrupos('pub', e.target.value));
    alternarGrupos('pub', '');
    void cargarEstado();

    // Se registra ANTES que el manejador original de home.html, y lo reemplaza
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      const msg = document.getElementById('mensaje');
      const relacion = document.getElementById('pub_relacion').value;
      const val = (id) => document.getElementById(id).value;

      const faltan = faltantesLocales('pub', relacion);
      if (faltan.length > 0) return aviso(msg, 'Falta: ' + faltan.join(', ') + '.', true);
      if (!document.getElementById('pub_acepta').checked) {
        return aviso(msg, 'Debes autorizar el tratamiento de tus datos personales para poder verificarte.', true);
      }

      // ----- validación de los datos del espacio antes de enviar -----
      const capacidad = Number(val('pubCapacidad'));
      const largo = Number(val('pubLargo'));
      const ancho = Number(val('pubAncho'));
      if (!Number.isInteger(capacidad) || capacidad <= 0) {
        return aviso(msg, 'La cantidad de vehículos debe ser un número entero mayor a 0.', true);
      }
      if (!(largo > 0) || !(ancho > 0)) {
        return aviso(msg, 'El largo y el ancho del espacio deben ser mayores a 0.', true);
      }
      const fotos = Array.isArray(window.pubFotosLista) ? window.pubFotosLista : [];
      if (fotos.length > 6) return aviso(msg, 'Puedes subir máximo 6 fotos.', true);

      const fd = new FormData();
      fd.append('titulo', val('pubTitulo').trim());
      fd.append('descripcion', val('pubDescripcion').trim());
      fd.append('direccion', val('pubDireccion').trim());
      fd.append('latitud', val('pubLatitud'));
      fd.append('longitud', val('pubLongitud'));
      fd.append('precio_hora', val('pubPrecio'));
      fd.append('capacidad_vehiculos', capacidad);
      fd.append('largo_metros', largo);
      fd.append('ancho_metros', ancho);
      fd.append('tiene_camara', document.getElementById('pubCamara').checked);
      fd.append('tiene_porton', document.getElementById('pubPorton').checked);
      fd.append('tiene_iluminacion', document.getElementById('pubIluminacion').checked);
      fd.append('relacion_propietario', relacion);
      fd.append('acepta_datos', true);
      fotos.forEach((f) => fd.append('fotos', f));
      for (const grupo of Object.values(CAMPOS)) {
        for (const [tipo] of grupo) {
          const f = archivoDe('pub', tipo);
          if (f) fd.append(tipo, f);
        }
      }

      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const resp = await fetch(`${api()}/verificacion/publicar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenActual()}` },
          body: fd,
        });
        const data = await resp.json();
        sinSesion(resp);
        if (!resp.ok) return aviso(msg, data.error || 'Error al publicar', true);

        const subidas = Array.isArray(data.fotos) ? data.fotos.length : 0;
        aviso(msg, subidas > 0
          ? `Espacio publicado con ${subidas} foto(s). Queda pendiente: el equipo revisará tus documentos y fotos.`
          : 'Espacio publicado, pero sin fotos. Sube al menos una en "Mis espacios" para que el equipo pueda aprobarlo.', false);
        form.reset();
        alternarGrupos('pub', '');
        void cargarEstado();
        if (typeof cargarMisEspacios === 'function') cargarMisEspacios();
      } catch (err) {
        aviso(msg, 'No se pudo conectar con el servidor.', true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------------
  // Ventana "Documentos" de Mis espacios
  // ------------------------------------------------------------------
  function cerrarModal() {
    const m = document.getElementById('modalDocumentos');
    if (m) m.remove();
  }

  window.subirDocumentos = async function (espacioId) {
    cerrarModal();
    const fondo = document.createElement('div');
    fondo.id = 'modalDocumentos';
    fondo.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:20px;';
    fondo.innerHTML = '<div style="background:#fff;border-radius:14px;padding:18px;max-width:520px;width:100%;margin:auto;">Cargando...</div>';
    document.body.appendChild(fondo);
    const caja = fondo.firstElementChild;

    try {
      const resp = await fetch(`${api()}/verificacion/mis-documentos/${espacioId}`, { headers: { Authorization: `Bearer ${tokenActual()}` } });
      const d = await resp.json();
      sinSesion(resp);
      if (!resp.ok) { caja.textContent = d.error || 'Error'; return; }

      estado.identidad_verificada = d.identidad_verificada;
      const subidos = d.documentos.map((x) => `<li>✔ ${x.etiqueta}</li>`).join('') || '<li>Ninguno todavía</li>';
      const faltan = d.faltantes.map((x) => `<li style="color:#c0392b;">✖ ${x}</li>`).join('');

      caja.innerHTML = `
        <h3 style="margin:0 0 8px;">Documentos del espacio</h3>
        ${d.motivo_rechazo ? `<div style="background:#fdecea;color:#c0392b;padding:8px;border-radius:8px;font-size:13px;margin-bottom:8px;">Motivo del rechazo: ${typeof esc === 'function' ? esc(d.motivo_rechazo) : d.motivo_rechazo}</div>` : ''}
        <ul style="padding-left:18px;font-size:13px;margin:0 0 8px;">${subidos}${faltan}</ul>
        ${d.verificado
          ? '<p style="font-size:13px;color:#2e7d32;">✔ Este espacio ya está verificado: sus documentos no se pueden cambiar.</p>'
          : `
          <div style="font-size:13px;color:#555;margin-bottom:6px;">Sube o reemplaza los documentos que necesites:</div>
          ${selectRelacionHTML('doc_relacion')}
          <div id="doc_grupoIdentidad" style="margin-top:10px;">
            <div class="nota-identidad" style="font-size:13px;color:#2e7d32;"></div>
            ${d.identidad_verificada ? '' : CAMPOS.identidad.map(([t, e, a]) => `
              <label style="display:block;font-size:13px;color:#555;margin:6px 0 2px;">${e}</label>
              <input type="file" id="doc_${t}" accept="${a}">`).join('')}
          </div>
          <div id="doc_grupoPropietario" style="display:none;margin-top:10px;">
            ${CAMPOS.propietario.map(([t, e, a]) => `
              <label style="display:block;font-size:13px;color:#555;margin:6px 0 2px;">${e}</label>
              <input type="file" id="doc_${t}" accept="${a}">`).join('')}
          </div>
          <div id="doc_grupoTercero" style="display:none;margin-top:10px;">
            ${CAMPOS.tercero.map(([t, e, a]) => `
              <label style="display:block;font-size:13px;color:#555;margin:6px 0 2px;">${e}</label>
              <input type="file" id="doc_${t}" accept="${a}">`).join('')}
          </div>
          <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#555;margin-top:12px;">
            <input type="checkbox" id="doc_acepta" style="width:auto;margin:3px 0 0;">
            <span>Autorizo a Migo Park a tratar mis datos personales y documentos únicamente para verificarme.</span>
          </label>
          <div id="doc_mensaje" style="margin-top:8px;font-size:13px;"></div>
          <button type="button" class="btn verde" id="doc_guardar" style="margin-top:10px;">Guardar documentos</button>`}
        <button type="button" class="btn rojo" id="doc_cerrar" style="margin-top:10px;">Cerrar</button>`;

      document.getElementById('doc_cerrar').onclick = cerrarModal;
      if (d.verificado) return;

      const sel = document.getElementById('doc_relacion');
      sel.value = d.relacion || '';
      alternarGrupos('doc', sel.value);
      sel.addEventListener('change', () => alternarGrupos('doc', sel.value));

      document.getElementById('doc_guardar').onclick = async () => {
        const msg = document.getElementById('doc_mensaje');
        const fd = new FormData();
        fd.append('relacion_propietario', sel.value);
        fd.append('acepta_datos', document.getElementById('doc_acepta').checked);
        let hay = false;
        for (const grupo of Object.values(CAMPOS)) {
          for (const [tipo] of grupo) {
            const f = archivoDe('doc', tipo);
            if (f) { fd.append(tipo, f); hay = true; }
          }
        }
        if (!sel.value) return aviso(msg, 'Indica tu relación con el parqueadero.', true);
        if (!hay && sel.value === d.relacion) return aviso(msg, 'Elige al menos un archivo.', true);
        if (!document.getElementById('doc_acepta').checked) return aviso(msg, 'Debes autorizar el tratamiento de tus datos.', true);

        try {
          const r = await fetch(`${api()}/verificacion/espacio/${espacioId}/documentos`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokenActual()}` }, body: fd,
          });
          const data = await r.json();
          sinSesion(r);
          if (!r.ok) return aviso(msg, data.error || 'No se pudieron guardar', true);
          window.subirDocumentos(espacioId);
          if (typeof cargarMisEspacios === 'function') cargarMisEspacios();
        } catch (err) {
          aviso(msg, 'No se pudo conectar con el servidor.', true);
        }
      };
    } catch (err) {
      caja.textContent = 'No se pudo conectar con el servidor.';
    }
  };
})();