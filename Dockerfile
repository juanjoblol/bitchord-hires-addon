FROM node:20-alpine

WORKDIR /app

# No hay dependencias de producción; solo se copia el código.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY . .

EXPOSE 8787

ENV PORT=8787
CMD ["node", "server.js"]