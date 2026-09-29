import tseslint from 'typescript-eslint'

// Persistence is asynchronous (FeltDB). These rules exist to catch the one mistake that conversion invites:
// a repository call whose promise is neither awaited nor handled.
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'scripts/**', 'resources/**', 'patches/**', '**/*.d.ts', 'eslint.config.js', 'electron.vite.config.ts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['./tsconfig.node.json', './tsconfig.web.json'], tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'error'
    }
  }
)
