import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({base:'./',build:{outDir:fileURLToPath(new URL('./dist',import.meta.url)),lib:{entry:{index:fileURLToPath(new URL('./src/index.ts',import.meta.url)),worker:fileURLToPath(new URL('./src/diff/worker.ts',import.meta.url))},formats:['es'],fileName:(_format,name)=>`${name}.js`},rollupOptions:{external:['monaco-editor']},target:'es2022'},worker:{format:'es'}});
