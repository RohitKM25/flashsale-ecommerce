# Stage 1: Build Frontend SPA
FROM node:22-alpine AS builder

WORKDIR /build
COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# Stage 2: High Performance Nginx Ingress Proxy & Edge Cache
FROM nginx:alpine

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /build/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
