# 1. Imagen base de Node.js
FROM node:20

# 2. Directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# 3. Copiar archivos necesarios
COPY package*.json ./

# 4. Instalar dependencias
RUN npm install

# 5. Copiar el resto del proyecto
COPY . .

# 6. Puerto expuesto (ajusta si usas otro)
EXPOSE 3000

# 7. Comando por defecto
CMD ["node", "index.js"]
