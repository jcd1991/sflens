import {defineConfig} from 'vite'; import react from '@vitejs/plugin-react'; import {resolve} from 'node:path';

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.GITHUB_ACTIONS && repositoryName ? `/${repositoryName}/` : '/sflens/';

export default defineConfig({base,plugins:[react()],resolve:{alias:{'@sflens/core':resolve(__dirname,'../../packages/core/src/index.ts')}}});
