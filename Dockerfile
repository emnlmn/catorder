# docker build -t catorder .
# docker run -p 7860:7860 -e CATORDER_MOCK=1 catorder
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# ponytail: tsx runs the server from source, devDependencies stay in the image
RUN npm run build:ui
ENV PORT=7860
EXPOSE 7860
CMD ["npx", "tsx", "src/main.ts"]
