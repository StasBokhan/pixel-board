import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built site works on GitHub Pages under /<repo-name>/.
  base: './',
  build: {
    target: 'es2022',
    // Two pages: the board and the one-time deploy page.
    rollupOptions: { input: { main: 'index.html', deploy: 'deploy.html' } },
  },
});
