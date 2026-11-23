import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Salida estatica: la Pi solo sirve archivos, sin proceso de Node para el
// frontend. Un `next build` en una Pi se queda sin memoria; esto no.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  // 5173 por defecto. Con PORT se puede levantar una segunda instancia sin
  // pisar a la primera; strictPort sigue
  // activo para que nunca se cambie de puerto a escondidas.
  server: { port: Number(process.env['PORT'] ?? 5173), strictPort: true },
});
