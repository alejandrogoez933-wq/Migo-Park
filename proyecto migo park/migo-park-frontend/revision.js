// Revisión de espacios para administrador / soporte.
// Al pulsar "Aprobar" en un espacio pendiente se abre una ventana con:
//   - Google Maps y Street View de las coordenadas (¿el lugar existe?)
//   - Las fotos, con botón de Google Lens (¿son robadas?)
//   - Los documentos del arrendador (cédula, selfie, certificado/escritura o autorización)
//   - Una lista de chequeo: solo se puede aprobar con todo marcado
// Se carga en admin.html DESPUÉS del script principal (justo antes de </body>).
(function () {
  const CHECKS = [
    ['existe_mapa', 'El lugar existe y coincide con Google Maps / Street View'],
    ['fotos_originales', 'Las fotos no aparecen en otros sitios (revisadas con Google Lens)'],
    ['identidad_coincide', 'La cédula y la selfie son de la misma persona y el nombre coincide con el de la cuenta'],
    ['documento_valido', 'El certificado/escritura (o la autorización del propietario) es válido y está a nombre correcto'],
    ['direccion_coincide', 'La dirección del documento coincide con la dirección del espacio'],
  ];

  const APIBASE = () => (typeof API_URL !== 'undefined' ? API_URL : 'http://localhost:4000/api');
  const FILEBASE = () => APIBASE().replace(/\/api\/?$/, '');
  const escapar = (t) => (typeof esc === 'function'
    ? esc(t)
    : String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const tokenAdmin = () => sessionStorage.getItem('token');

  const urlMaps = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + ',' + lng)}`;
  const urlStreetView = (lat, lng) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(lat + ',' + lng)}`;

  // Google Lens solo puede abrir la foto si es pública en internet (no desde localhost)
  function urlLens(urlFoto) {
    const completa = FILEBASE() + urlFoto;
    const local = /localhost|127\.0\.0\.1/.test(FILEBASE());
    return local ? 'https://lens.google.com/' : 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(completa);
  }

  let urlVista = null; // para liberar la memoria del documento que se está viendo

  function cerrar() {
    const m = document.getElementById('modalRevision');
    if (m) m.remove();
    if (urlVista) { URL.revokeObjectURL(urlVista); urlVista = null; }
  }

  async function verDocumento(docId, mime) {
    const visor = document.getElementById('visorDocumento');
    visor.textContent = 'Cargando documento...';
    try {
      const resp = await fetch(`${APIBASE()}/verificacion/documentos/${docId}`, { headers: { Authorization: `Bearer ${tokenAdmin()}` } });
      if (!resp.ok) { visor.textContent = 'No se pudo abrir el documento.'; return; }
      const blob = await resp.blob();
      if (urlVista) URL.revokeObjectURL(urlVista);
      urlVista = URL.createObjectURL(blob);
      visor.textContent = '';
      if (mime === 'application/pdf') {
        const f = document.createElement('iframe');
        f.src = urlVista;
        f.style.cssText = 'width:100%;height:480px;border:1px solid #ddd;border-radius:8px;';
        visor.appendChild(f);
      } else {
        const i = document.createElement('img');
        i.src = urlVista;
        i.alt = 'Documento';
        i.style.cssText = 'max-width:100%;border:1px solid #ddd;border-radius:8px;';
        visor.appendChild(i);
      }
    } catch (e) {
      visor.textContent = 'No se pudo conectar con el servidor.';
    }
  }

  async function abrirRevision(id) {
    cerrar();
    const fondo = document.createElement('div');
    fondo.id = 'modalRevision';
    fondo.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;overflow:auto;padding:16px;';
    fondo.innerHTML = '<div id="cajaRevision" style="background:#fff;border-radius:14px;padding:18px;max-width:720px;margin:0 auto;">Cargando revisión...</div>';
    document.body.appendChild(fondo);
    const caja = document.getElementById('cajaRevision');

    let d;
    try {
      const resp = await api(`/verificacion/espacio/${id}/revision`);
      d = await resp.json();
      if (!resp.ok) { caja.innerHTML = `<p>${escapar(d.error || 'Error')}</p><button class="btn rojo" id="rv_cerrar">Cerrar</button>`; document.getElementById('rv_cerrar').onclick = cerrar; return; }
    } catch (e) {
      caja.textContent = 'No se pudo conectar con el servidor.';
      return;
    }

    const e = d.espacio;
    const rel = { propietario: 'Propietario', arrendatario: 'Arrendatario (con autorización)', administrador: 'Administrador del inmueble' }[d.relacion] || 'No indicada';
    const local = /localhost|127\.0\.0\.1/.test(FILEBASE());

    const fotos = d.fotos.length === 0
      ? '<p style="color:#c0392b;font-size:13px;">✖ El espacio todavía no tiene fotos. No se puede aprobar hasta que el arrendador suba al menos una.</p>'
      : `<div style="display:flex;gap:10px;flex-wrap:wrap;">${d.fotos.map((f) => `
          <div style="width:140px;">
            <a href="${escapar(FILEBASE() + f.url)}" target="_blank" rel="noopener">
              <img src="${escapar(FILEBASE() + f.url)}" style="width:140px;height:100px;object-fit:cover;border-radius:8px;">
            </a>
            <a href="${escapar(urlLens(f.url))}" target="_blank" rel="noopener" style="font-size:12px;">🔎 Buscar en Google Lens</a>
          </div>`).join('')}</div>
         ${local ? '<p style="font-size:12px;color:#777;">Estás en modo local: Google Lens no puede abrir imágenes de localhost. Abre la foto, guárdala y súbela en lens.google.com. Cuando el sistema esté publicado en internet, el botón la abrirá directamente.</p>' : ''}`;

    const docs = d.documentos.length === 0
      ? '<p style="color:#c0392b;font-size:13px;">✖ No hay documentos.</p>'
      : `<ul style="list-style:none;padding:0;margin:0;">${d.documentos.map((x) => `
          <li style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;font-size:13px;">
            <span>${escapar(x.etiqueta)} <span style="color:#999;">(${x.ambito === 'identidad' ? 'identidad' : 'del espacio'})</span></span>
            <button type="button" class="btn verde" data-doc="${x.id}" data-mime="${escapar(x.mime)}" style="padding:4px 10px;">Ver</button>
          </li>`).join('')}</ul>`;

    const faltan = d.faltantes.length === 0
      ? '<p style="color:#2e7d32;font-size:13px;margin:6px 0 0;">✔ Tiene todos los documentos que se piden.</p>'
      : `<ul style="color:#c0392b;font-size:13px;margin:6px 0 0;padding-left:18px;">${d.faltantes.map((f) => `<li>Falta: ${escapar(f)}</li>`).join('')}</ul>`;

    caja.innerHTML = `
      <h3 style="margin:0 0 4px;">Revisión: ${escapar(e.titulo)}</h3>
      <div style="font-size:13px;color:#555;">${escapar(e.direccion)}</div>
      <div style="font-size:13px;color:#555;margin-bottom:10px;">Arrendador: ${escapar(d.arrendador.nombre)} · ${escapar(d.arrendador.correo)}${d.arrendador.telefono ? ' · ' + escapar(d.arrendador.telefono) : ''}<br>
        Relación con el parqueadero: <b>${escapar(rel)}</b> ·
        Identidad: ${d.arrendador.identidad_verificada ? '<b style="color:#2e7d32;">ya verificada antes</b>' : '<b>por verificar</b>'}</div>

      <div style="font-size:13px;color:#555;margin-bottom:10px;background:#f6f8f6;border-radius:8px;padding:8px 10px;">
        <b>Datos publicados:</b>
        ${escapar(Number(e.precio_hora).toLocaleString('es-CO'))} COP / hora ·
        🚗 ${escapar(e.capacidad_vehiculos || 1)} vehículo(s) ·
        📏 ${escapar(e.largo_metros || 0)} m × ${escapar(e.ancho_metros || 0)} m
        (${(Number(e.largo_metros || 0) * Number(e.ancho_metros || 0)).toFixed(2)} m²)<br>
        Seguridad: ${escapar([e.tiene_camara && 'Cámara', e.tiene_porton && 'Portón', e.tiene_iluminacion && 'Iluminación'].filter(Boolean).join(' · ') || 'sin cámara, portón ni iluminación')}
        ${e.descripcion ? '<br>Descripción: ' + escapar(e.descripcion) : ''}
      </div>

      <h4 style="margin:12px 0 4px;">1. ¿El lugar existe?</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a class="btn verde" style="text-decoration:none;" href="${escapar(urlMaps(e.latitud, e.longitud))}" target="_blank" rel="noopener">📍 Ver en Google Maps</a>
        <a class="btn verde" style="text-decoration:none;" href="${escapar(urlStreetView(e.latitud, e.longitud))}" target="_blank" rel="noopener">🛣️ Ver en Street View</a>
      </div>
      <div style="font-size:12px;color:#777;margin-top:4px;">Coordenadas: ${escapar(e.latitud)}, ${escapar(e.longitud)}. Compara la fachada y la calle con las fotos.</div>

      <h4 style="margin:12px 0 4px;">2. Fotos del espacio</h4>
      ${fotos}

      <h4 style="margin:12px 0 4px;">3. Documentos del arrendador</h4>
      ${docs}
      ${faltan}
      <div id="visorDocumento" style="margin-top:8px;font-size:13px;color:#777;"></div>

      <h4 style="margin:14px 0 4px;">4. Lista de revisión</h4>
      ${CHECKS.map(([k, t]) => `
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:6px 0;">
          <input type="checkbox" data-check="${k}" style="width:auto;margin:3px 0 0;"><span>${escapar(t)}</span>
        </label>`).join('')}

      <div id="rv_mensaje" style="font-size:13px;margin-top:6px;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button type="button" class="btn verde" id="rv_aprobar" disabled>Aprobar espacio</button>
        <button type="button" class="btn rojo" id="rv_rechazar">Rechazar…</button>
        <button type="button" class="btn" id="rv_cerrar" style="background:#eee;color:#111;">Cerrar</button>
      </div>`;

    const btnAprobar = document.getElementById('rv_aprobar');
    const casillas = [...caja.querySelectorAll('input[data-check]')];
    const puedeAprobar = d.faltantes.length === 0 && d.fotos.length > 0;

    function actualizar() {
      btnAprobar.disabled = !(puedeAprobar && casillas.every((c) => c.checked));
    }
    casillas.forEach((c) => c.addEventListener('change', actualizar));
    actualizar();

    caja.querySelectorAll('button[data-doc]').forEach((b) => {
      b.addEventListener('click', () => verDocumento(b.dataset.doc, b.dataset.mime));
    });

    document.getElementById('rv_cerrar').onclick = cerrar;
    document.getElementById('rv_rechazar').onclick = () => { cerrar(); abrirRechazo('espacios', id); };

    btnAprobar.onclick = async () => {
      const checklist = {};
      casillas.forEach((c) => { checklist[c.dataset.check] = c.checked; });
      const msg = document.getElementById('rv_mensaje');
      btnAprobar.disabled = true;
      try {
        const resp = await api(`/espacios/${id}/verificar`, { method: 'PUT', body: JSON.stringify({ checklist }) });
        const data = await resp.json();
        if (!resp.ok) {
          msg.style.color = '#c0392b';
          msg.textContent = data.error || 'No se pudo aprobar';
          actualizar();
          return;
        }
        cerrar();
        if (typeof cargarVerificaciones === 'function') cargarVerificaciones();
      } catch (err) {
        msg.style.color = '#c0392b';
        msg.textContent = 'No se pudo conectar con el servidor.';
        actualizar();
      }
    };
  }

  // El botón "Aprobar" de un espacio ahora abre la revisión; el de vehículos sigue igual
  const aprobarOriginal = window.aprobar;
  window.aprobar = function (tipo, id) {
    if (tipo === 'espacios') return abrirRevision(id);
    return aprobarOriginal.apply(this, arguments);
  };
  window.abrirRevision = abrirRevision;
})();