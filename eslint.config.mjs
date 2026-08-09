import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

// **Two rules, and deliberately nothing else.**
//
// There is no test suite here by design, and no style linting either — the house
// style is consistent, hand-maintained and documented in CLAUDE.md, so a
// stylistic ruleset would only fight it. What a type-checker genuinely cannot
// see is a stale closure in an effect, and this renderer is unusually
// effect-heavy: eager chat opens, retry timers, ResizeObservers, a native
// non-passive wheel listener, a layout effect re-measuring the composer. Those
// fail silently rather than loudly, which is exactly the failure mode worth
// spending a lint pass on.
//
// It also makes the two `// eslint-disable-next-line react-hooks/exhaustive-deps`
// comments in TerminalView and ChatView mean something. They were suppressing a
// rule that was never running — ESLint was not a dependency and there was no
// config — so they documented an intent nothing checked.
//
// `exhaustive-deps` is a warning, not an error: both existing suppressions are
// considered decisions, and a rule that fails the build would turn every future
// considered decision into an argument with the tool.
export default [
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
]
