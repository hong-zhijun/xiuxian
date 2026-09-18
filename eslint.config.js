import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 关闭两条纯排版规则：本仓库未引入格式化器，缩进/换行风格由编辑器和下文保持一致，
    // 避免 lint 输出被格式告警淹没（后续引入格式化器时交给它统一处理）。
    files: ['**/*.vue'],
    rules: {
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
    },
  },
  {
    // 仓库自有的 Node 脚本（scripts/**/*.mjs 与 scripts/**/*.ts，例如受控账号工具）：
    // 只声明实际用到的全局，不引入 globals 包，避免为几个标识符增加依赖。
    files: ['scripts/**/*.{mjs,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
      },
    },
  },
  {
    // 前端源码跑在浏览器里：同样只声明实际用到的浏览器全局（不引入 globals 包）。
    files: ['apps/web/src/**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // 表单/事件处理里用到的 DOM 类型（复选框事件等）
        Event: 'readonly',
        HTMLElement: 'readonly',
        KeyboardEvent: 'readonly',
        HTMLInputElement: 'readonly',
      },
    },
  },
);
