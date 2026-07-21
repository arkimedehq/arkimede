FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
# App name baked into index.html <title> and the UI at build time (Vite %VITE_APP_NAME%).
ARG VITE_APP_NAME=Arkimede
ENV VITE_APP_NAME=$VITE_APP_NAME
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Template processed by the nginx image's envsubst entrypoint at container
# start (→ /etc/nginx/conf.d/default.conf). MAX_UPLOAD_MB here is only the
# fallback: docker-compose overrides it from the root .env.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV MAX_UPLOAD_MB=50
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
