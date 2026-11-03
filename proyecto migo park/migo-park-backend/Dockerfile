FROM node:22-slim

WORKDIR /app

# Dependencias primero (aprovecha la caché de Docker)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src

# Carpetas que el backend escribe en tiempo de ejecución
RUN mkdir -p uploads/espacios documentos-privados && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]