FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY client ./client
COPY mcp ./mcp
COPY supabase/functions/_shared ./supabase/functions/_shared
USER node
CMD ["node", "mcp/index.ts"]
