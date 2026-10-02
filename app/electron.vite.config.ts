import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET come from app/.env.local (gitignored).
  const env = loadEnv(mode, __dirname, '');
  return {
    main: {
      // @vd/core ships as TypeScript source, so it has to be bundled, not required at runtime.
      plugins: [externalizeDepsPlugin({ exclude: ['@vd/core'] })],
      define: {
        __GOOGLE_CLIENT_ID__: JSON.stringify(env.GOOGLE_CLIENT_ID ?? ''),
        __GOOGLE_CLIENT_SECRET__: JSON.stringify(env.GOOGLE_CLIENT_SECRET ?? ''),
      },
      build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react()],
    },
  };
});
