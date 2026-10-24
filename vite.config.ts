import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import monkey from 'vite-plugin-monkey';

const SERVE_ROOT = 'http://127.0.0.1:8778';
const FILE_NAME = 'redgifsbooru.user.js';

export default defineConfig({
  plugins: [
    preact(),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        name: 'RedGIFSbooru',
        namespace: 'https://github.com/redgifsbooru',
        version: '0.5.1',
        description: 'An e621-style booru for RedGifs at /booru/posts. The rest of RedGifs is left alone.',
        author: 'RedGIFsbooru',
        license: 'GPL-3.0-or-later',
        match: ['https://www.redgifs.com/*', 'https://redgifs.com/*'],
        'run-at': 'document-start',
        grant: ['GM_xmlhttpRequest', 'GM_download'],
        connect: ['api.redgifs.com', 'media.redgifs.com'],
        updateURL: `${SERVE_ROOT}/${FILE_NAME}`,
        downloadURL: `${SERVE_ROOT}/${FILE_NAME}`,
        noframes: true,
      },
      build: {
        fileName: FILE_NAME,
        // The theme is injected by takeover.ts after the page is replaced, so
        // the plugin must not add a stylesheet of its own.
        cssSideEffects: () => {},
      },
    }),
  ],
  build: {
    minify: false,
  },
});
