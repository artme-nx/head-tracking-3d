import { defineConfig } from 'vite';

// Na GitHub Pages stranica živi pod /head-tracking-3d/, lokalno pod /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/head-tracking-3d/' : '/',
  server: { open: true, port: 5180 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
}));
