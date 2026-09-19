FROM node:20-bookworm-slim

WORKDIR /app

# Dev deps included on purpose — tsx is the runtime (no compile step).
COPY package.json package-lock.json ./
RUN npm ci

COPY main.ts tsconfig.json ./
COPY api ./api/
COPY server ./server/
COPY public ./public/

ENV NODE_ENV=production
EXPOSE 8000

CMD ["npm", "start"]
