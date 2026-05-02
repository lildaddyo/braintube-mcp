FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --production

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

RUN chown -R 1000:1000 /app
USER 1000

CMD ["node", "dist/index.js"]
