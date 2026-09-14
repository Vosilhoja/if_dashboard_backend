FROM node:20-alpine

WORKDIR /app

# Install dependencies required to compile TypeScript
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# NODE_ENV should be set via Railway environment variables, not hardcoded here.
# Railway injects PORT automatically — do NOT hardcode it.
ENV NODE_ENV=production

# Expose a default port for local Docker use only.
# On Railway, the PORT env var is injected dynamically.
EXPOSE 5000

CMD ["node", "dist/server.js"]
