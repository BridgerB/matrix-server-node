FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 8008
ENV STORAGE=sqlite
ENV DATABASE_PATH=/data/matrix.db
CMD ["node", "src/index.ts"]
