FROM node:18-alpine
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci
COPY . .

RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 5000
CMD ["npm", "start"]