import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.spikes/**',
      'docs/tools/**',
      'layout.tmp.json'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }]
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts', '*.{ts,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'renderer 只能通过 window.noryth 访问能力' },
            { name: 'node:fs', message: 'renderer 没有文件权限' },
            { name: 'node:path', message: 'renderer 没有文件权限' },
            { name: 'better-sqlite3', message: 'renderer 没有数据库权限' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/main/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'better-sqlite3', message: '工具层只能通过 repos 访问数据（DEV-PLAN §6.10）' },
            { name: 'electron', message: '工具层不知道窗口与进程' },
            { name: 'node:fs', message: '工具层不得直接读文件' },
            { name: 'node:fs/promises', message: '工具层不得直接读文件' }
          ],
          patterns: [
            {
              group: ['node:fs/*', 'node:child_process', 'node:net', 'node:http', 'node:https', 'undici'],
              message: '工具层不得读文件、发网络、开子进程'
            }
          ]
        }
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '工具层不得发网络请求（DEV-PLAN §6.10）' }
      ]
    }
  }
)
