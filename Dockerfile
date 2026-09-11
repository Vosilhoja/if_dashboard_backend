FROM node:20-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# NODE_ENV should be set via Railway environment variables, not hardcoded here.
# Railway injects PORT automatically — do NOT hardcode it.
ENV NODE_ENV=production

# Expose a default port for local Docker use only.
# On Railway, the PORT env var is injected dynamically.
EXPOSE 5000

CMD ["node", "src/server.js"]
