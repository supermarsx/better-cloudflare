FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
RUN npm run build
EXPOSE 8787 5173
CMD ["npm", "run", "dev:server"]
