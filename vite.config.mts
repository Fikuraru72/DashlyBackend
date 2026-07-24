import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: ['dist/**', 'coverage/**', '.pi-subagents/**', 'AGENTS.md', 'index.html'],
    singleQuote: true,
    semi: true,
  },
  lint: {
    ignorePatterns: ['dist/**', 'coverage/**', '.pi-subagents/**', 'AGENTS.md', 'index.html'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*-spec.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
