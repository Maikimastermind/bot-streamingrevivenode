# 1. Imagen base de Node.js
FROM node:20

# 2. Directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# 3. Instalar dependencias del sistema para Puppeteer/Chrome
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# 4. Copiar primero solo los package.json
COPY package*.json ./

# 5. Instalar dependencias de Node.js (incluye dotenv)
RUN npm install --production

# 6. Copiar el resto del proyecto
COPY . .

# 7. Puerto expuesto
EXPOSE 3000

# 8. Comando por defecto
CMD ["node", "index.js"]
