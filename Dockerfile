FROM node:20-alpine

WORKDIR /app

# Install dependencies required to compile TypeScript
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev
RUN chown -R node:node /app

# NODE_ENV should be set via Railway environment variables, not hardcoded here.
# Railway injects PORT automatically — do NOT hardcode it.
ENV NODE_ENV=production
USER node

# Expose a default port for local Docker use only.
# On Railway, the PORT env var is injected dynamically.
EXPOSE 5000

# Lets the hosting platform detect an unhealthy process instead of routing
# traffic to a dead or non-responsive replica.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
