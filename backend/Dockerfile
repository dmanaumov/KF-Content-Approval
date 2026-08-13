FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY backend/src ./src
COPY frontend /frontend

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
