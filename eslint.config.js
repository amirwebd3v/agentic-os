import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', '.claude/**', 'sidecar/.venv/**', 'sidecar/.uv-cache/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ['web/**/*.{ts,vue}'],
    extends: [pluginVue.configs['flat/recommended']],
    languageOptions: { globals: globals.browser, parserOptions: { parser: tseslint.parser } },
    rules: {
      // Model output is untrusted. The single exception is MessageBubble.vue, which renders only renderMarkdown().
      'vue/no-v-html': 'error',
      // Formatting rules fight the existing code style; layout isn't what this config guards.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
    },
  },
);
