# 无广告免费版服务端镜像：构建上下文为 preXCX/ 目录。
# 小程序端不进入镜像；引擎与 MARD 色卡随 server/src 一起打包。
# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY server ./server
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
# 微信云托管默认转发到容器 80 端口；本地调试可覆盖 PORT 与映射端口。
ENV PORT=80
WORKDIR /app
# 分块打印 PDF 的页眉需要中文字体，否则中文会渲染成方框。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 80
CMD ["node", "dist/index.js"]
