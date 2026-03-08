FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json ./
COPY types.ts merge.ts store.ts server.ts ./

EXPOSE 7171

CMD ["bun", "run", "server.ts"]
