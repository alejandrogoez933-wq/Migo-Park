FROM nginxinc/nginx-unprivileged:alpine

# Solo los archivos del sitio (sin copiar toda la carpeta)
COPY index.html home.html admin.html 2fa.js contrasena.js revision.js verificacion.js /usr/share/nginx/html/

# Esta imagen corre sin root y escucha en el puerto 8080
EXPOSE 8080