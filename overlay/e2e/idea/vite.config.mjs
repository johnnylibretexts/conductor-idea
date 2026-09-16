import {defineConfig} from '../../client/node_modules/vite/dist/node/index.js';
import {fileURLToPath} from 'node:url';
const client=fileURLToPath(new URL('../../client/',import.meta.url));
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),esbuild:{jsx:"automatic"},resolve:{alias:{react:client+'node_modules/react', 'react-dom':client+'node_modules/react-dom','react-router-dom':client+'node_modules/react-router-dom','@tanstack/react-query':client+'node_modules/@tanstack/react-query',axios:client+'node_modules/axios'}},server:{host:'127.0.0.1',port:3199,strictPort:true,fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]},proxy:{'/api':'http://127.0.0.1:3200','/__idea-test':'http://127.0.0.1:3200'}}});
