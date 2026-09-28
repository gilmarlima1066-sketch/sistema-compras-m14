import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Em desenvolvimento o frontend fala com a API pelo mesmo host,
      // evitando configuracao extra de CORS no navegador.
      '/api': { target: 'http://localhost:3333', changeOrigin: true },
      '/health': { target: 'http://localhost:3333', changeOrigin: true },
    },
  },
});
