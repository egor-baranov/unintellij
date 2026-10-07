import tseslint from 'typescript-eslint';
export default tseslint.config({ignores:['**/dist/**','release/**','node_modules/**','artifacts/**','test-results*/**','.idea/**','playwright-report/**']},...tseslint.configs.recommended, {rules:{'@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'@typescript-eslint/no-explicit-any':'error'}});
