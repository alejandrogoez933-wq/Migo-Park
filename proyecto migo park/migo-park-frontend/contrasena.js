// Política de contraseñas en pantalla: muestra en vivo qué le falta a la contraseña
// y bloquea el envío del formulario mientras no cumpla.
// Se aplica a: registro (regContrasena), recuperar contraseña (recContrasena)
// y crear staff (stContrasena). El login NO se toca.
(function () {
  const REGLAS = [
    { texto: '8 o más caracteres',                       ok: (c) => c.length >= 8 },
    { texto: 'letras',                                   ok: (c) => /\p{L}/u.test(c) },
    { texto: 'números',                                  ok: (c) => /\d/.test(c) },
    { texto: 'un carácter especial (! @ # $ % &)',       ok: (c) => /[^\p{L}\d\s]/u.test(c) },
  ];

  function errorContrasena(c) {
    const faltan = REGLAS.filter((r) => !r.ok(c)).map((r) => r.texto);
    return faltan.length === 0
      ? ''
      : 'La contraseña debe tener 8 o más caracteres, con letras, números y un carácter especial. Le falta: ' + faltan.join(', ') + '.';
  }
  window.errorContrasena = errorContrasena;

  function preparar(id) {
    const campo = document.getElementById(id);
    if (!campo) return;

    // Cuadro con los requisitos, justo debajo del campo
    const aviso = document.createElement('div');
    aviso.className = 'requisitos-contrasena';
    aviso.style.cssText = 'font-size:12px;line-height:1.6;margin:0 0 10px;color:#777;';
    const ancla = campo.parentElement && campo.parentElement.classList.contains('password-container')
      ? campo.parentElement
      : campo;
    ancla.insertAdjacentElement('afterend', aviso);

    function pintar() {
      const valor = campo.value;
      aviso.textContent = '';
      REGLAS.forEach((r, i) => {
        const cumple = r.ok(valor);
        const span = document.createElement('span');
        span.textContent = (cumple ? '✔ ' : '✖ ') + r.texto;
        span.style.color = cumple ? '#2e7d32' : (valor ? '#c0392b' : '#777');
        span.style.display = 'block';
        aviso.appendChild(span);
      });
      // El navegador impide enviar el formulario y muestra este mensaje
      campo.setCustomValidity(errorContrasena(valor));
    }

    campo.addEventListener('input', pintar);
    pintar();
  }

  ['regContrasena', 'recContrasena', 'stContrasena'].forEach(preparar);

  // El texto de ayuda ahora lo da el cuadro de requisitos
  const rec = document.getElementById('recContrasena');
  if (rec) rec.placeholder = 'Nueva contraseña';
  const etiquetaStaff = document.querySelector('label[for="stContrasena"]');
  if (etiquetaStaff) etiquetaStaff.textContent = 'Contraseña';
})();