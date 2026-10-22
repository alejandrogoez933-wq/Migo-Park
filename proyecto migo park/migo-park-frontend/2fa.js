// Verificación en dos pasos (2FA) para el login. Se carga desde index.html antes del script principal.
// Usa API_URL, mostrarMensaje y modoRegistro, que están definidos en index.html.

(function crearPanel2fa() {
  const card = document.querySelector('.card');
  const vista = document.createElement('div');
  vista.id = 'vista2fa';
  vista.style.display = 'none';
  vista.innerHTML = `
    <form id="form2fa">
      <p id="texto2fa" style="font-size:14px;color:#555;margin:0 0 10px;"></p>

      <input type="text" id="codigo2fa" inputmode="numeric" pattern="[0-9 ]*" maxlength="7"
        autocomplete="one-time-code" placeholder="Código de 6 dígitos"
        style="text-align:center;letter-spacing:4px;font-size:18px;" required>

      <button type="submit" id="btn2fa">Verificar</button>
    </form>

    <div class="toggle" onclick="reenviar2fa()">Reenviar código</div>
    <div class="toggle" onclick="cancelar2fa()">Cancelar y volver</div>
  `;
  card.insertBefore(vista, document.getElementById('toggleTexto'));

  document.getElementById('form2fa').addEventListener('submit', enviarCodigo2fa);
})();

let token2fa = null;   // token temporal. NO es una sesión.

function entrar2fa(data) {
  sessionStorage.setItem('token', data.token);
  sessionStorage.setItem('usuario', JSON.stringify(data.usuario));

  mostrarMensaje('¡Bienvenido, ' + data.usuario.nombre + '!', false);

  const destino =
    (data.usuario.rol === 'administrador' || data.usuario.rol === 'soporte')
      ? 'admin.html'
      : 'home.html';

  setTimeout(() => { window.location.href = destino; }, 800);
}

async function iniciar2fa(data) {
  token2fa = data.tokenTemporal;

  document.getElementById('formLogin').style.display = 'none';
  document.getElementById('formRegistro').style.display = 'none';
  document.getElementById('toggleTexto').style.display = 'none';
  document.getElementById('vista2fa').style.display = 'block';
  document.getElementById('codigo2fa').value = '';
  document.getElementById('btn2fa').disabled = false;
  document.getElementById('mensaje').textContent = '';
  document.getElementById('texto2fa').textContent =
    data.mensaje || 'Te enviamos un código de 6 dígitos. Escríbelo aquí.';
  document.getElementById('codigo2fa').focus();
}

function cancelar2fa(conservarMensaje) {
  token2fa = null;
  document.getElementById('vista2fa').style.display = 'none';
  document.getElementById('formLogin').style.display = 'block';
  document.getElementById('toggleTexto').style.display = 'block';
  document.getElementById('toggleTexto').textContent = '¿No tienes cuenta? Crear cuenta';
  modoRegistro = false;
  document.getElementById('loginContrasena').value = '';
  if (!conservarMensaje) document.getElementById('mensaje').textContent = '';
}

async function reenviar2fa() {
  try {
    const resp = await fetch(`${API_URL}/auth/2fa/reenviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenTemporal: token2fa })
    });
    const d = await resp.json();

    if (!resp.ok) {
      mostrarMensaje(d.error || 'No se pudo reenviar el código', true);
      if (d.reiniciar) cancelar2fa(true);
      return;
    }
    document.getElementById('codigo2fa').value = '';
    mostrarMensaje('Código nuevo generado.', false);
  } catch (err) {
    mostrarMensaje('No se pudo conectar con el servidor.', true);
  }
}

async function enviarCodigo2fa(e) {
  e.preventDefault();

  const codigo = document.getElementById('codigo2fa').value;
  const btn = document.getElementById('btn2fa');
  btn.disabled = true;

  try {
    const resp = await fetch(`${API_URL}/auth/2fa/verificar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenTemporal: token2fa, codigo })
    });
    const d = await resp.json();

    if (!resp.ok) {
      mostrarMensaje(d.error || 'Código incorrecto', true);
      if (d.reiniciar) cancelar2fa(true);
      document.getElementById('codigo2fa').value = '';
      btn.disabled = false;
      return;
    }

    token2fa = null;
    entrar2fa(d);

  } catch (err) {
    mostrarMensaje('No se pudo conectar con el servidor.', true);
    btn.disabled = false;
  }
}