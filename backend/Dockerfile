FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY backend/src ./src
COPY frontend /frontend

# Mount point for the rotatable-link store (backend/src/linkTokens.js) — the
# actual persistence comes from docker-compose.yml's named volume at this
# path, this just makes sure the directory exists even before that volume's
# first write.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
