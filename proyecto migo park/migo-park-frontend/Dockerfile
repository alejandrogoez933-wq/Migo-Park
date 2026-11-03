FROM nginx:alpine
COPY . /usr/share/nginx/html
RUN rm -f /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/.dockerignore /usr/share/nginx/html/desktop.ini
EXPOSE 80