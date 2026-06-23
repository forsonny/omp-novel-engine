FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json ./
RUN bun install --no-save
COPY src ./src
COPY schema.sql ./schema.sql
EXPOSE 7127
CMD ["bun", "run", "src/server.ts"]
