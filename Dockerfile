FROM node:20-alpine
WORKDIR /app

# Instalar dependências (usa apenas package.json)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar o restante do código
COPY . .

# Porta padrão local (Render sobrepõe com $PORT)
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]