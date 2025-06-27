import { nextTestSetup } from 'e2e-utils'
import { assertNoErrorToast } from 'next-test-utils'
import { getPrerenderOutput } from './utils'

describe.each([
  { inDebugMode: true, name: 'With --prerender-debug' },
  { inDebugMode: false, name: 'Without --prerender-debug' },
])('Dynamic IO Errors - $name', ({ inDebugMode }) => {
  describe('Error Attribution with Sync IO - Guarded RSC with guarded Client sync IO', () => {
    const { next, isNextDev, skipped } = nextTestSetup({
      files:
        __dirname +
        '/fixtures/sync-attribution/guarded-async-guarded-clientsync',
      skipStart: true,
      skipDeployment: true,
      buildOptions: inDebugMode ? ['--debug-prerender'] : undefined,
    })

    if (skipped) {
      return
    }

    if (isNextDev) {
      it('does not show a validation error in the dev overlay', async () => {
        await next.start()
        const browser = await next.browser('/')
        await assertNoErrorToast(browser)
      })
    } else {
      it('should not error the build sync IO is used inside a Suspense Boundary in a client Component and nothing else is dynamic', async () => {
        try {
          await next.start()
        } catch {
          throw new Error('expected build not to fail')
        }
        expect(next.cliOutput).toContain('◐ / ')
      })
    }
  })

  describe('Error Attribution with Sync IO - Guarded RSC with unguarded Client sync IO', () => {
    const { next, isNextDev, isTurbopack, skipped } = nextTestSetup({
      files:
        __dirname +
        '/fixtures/sync-attribution/guarded-async-unguarded-clientsync',
      skipStart: true,
      skipDeployment: true,
      buildOptions: inDebugMode ? ['--debug-prerender'] : undefined,
    })

    if (skipped) {
      return
    }

    if (isNextDev) {
      it('does not run in dev', () => {})
      return
    }

    it('should error the build with a reason related to sync IO access', async () => {
      try {
        await next.start()
      } catch {
        // we expect the build to fail
      }

      const output = getPrerenderOutput(next.cliOutput, {
        isMinified: !inDebugMode,
      })

      if (isTurbopack) {
        if (inDebugMode) {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at SyncIO (turbopack:///[project]/app/client.tsx:5:15)
             3 | export function SyncIO() {
             4 |   // This is a sync IO access that should not cause an error
           > 5 |   const data = new Date().toISOString()
               |               ^
             6 |
             7 |   return (
             8 |     <main>
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error

           > Export encountered errors on following paths:
           	/page: /"
          `)
        } else {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at a (<next-dist-dir>)
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error
           Export encountered an error on /page: /, exiting the build."
          `)
        }
      } else {
        if (inDebugMode) {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at SyncIO (webpack:///app/client.tsx:5:15)
             3 | export function SyncIO() {
             4 |   // This is a sync IO access that should not cause an error
           > 5 |   const data = new Date().toISOString()
               |               ^
             6 |
             7 |   return (
             8 |     <main>
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error

           > Export encountered errors on following paths:
           	/page: /"
          `)
        } else {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at a (<next-dist-dir>)
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error
           Export encountered an error on /page: /, exiting the build."
          `)
        }
      }
    })
  })

  describe('Error Attribution with Sync IO - Unguarded RSC with guarded Client sync IO', () => {
    const { next, isNextDev, isTurbopack, skipped } = nextTestSetup({
      files:
        __dirname +
        '/fixtures/sync-attribution/unguarded-async-guarded-clientsync',
      skipStart: true,
      skipDeployment: true,
      buildOptions: inDebugMode ? ['--debug-prerender'] : undefined,
    })

    if (skipped) {
      return
    }

    if (isNextDev) {
      it('does not run in dev', () => {})
      return
    }

    it('should error the build with a reason related dynamic data', async () => {
      try {
        await next.start()
      } catch {
        // we expect the build to fail
      }

      const output = getPrerenderOutput(next.cliOutput, {
        isMinified: !inDebugMode,
      })

      if (isTurbopack) {
        if (inDebugMode) {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/": A component accessed data, headers, params, searchParams, or a short-lived cache without a Suspense boundary nor a "use cache" above it. We don't have the exact line number added to error messages yet but you can see which component in the stack below. See more info: https://nextjs.org/docs/messages/next-prerender-missing-suspense
               at section (<anonymous>)
               at main (<anonymous>)
               at RenderFromTemplateContext (<anonymous>)
               at main (<anonymous>)
               at body (<anonymous>)
               at html (<anonymous>)
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error

           > Export encountered errors on following paths:
           	/page: /"
          `)
        } else {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/": A component accessed data, headers, params, searchParams, or a short-lived cache without a Suspense boundary nor a "use cache" above it. We don't have the exact line number added to error messages yet but you can see which component in the stack below. See more info: https://nextjs.org/docs/messages/next-prerender-missing-suspense
               at a (<anonymous>)
               at main (<anonymous>)
               at b (<next-dist-dir>)
               at c (<next-dist-dir>)
               at d (<next-dist-dir>)
               at e (<next-dist-dir>)
               at f (<next-dist-dir>)
               at g (<next-dist-dir>)
               at h (<next-dist-dir>)
               at i (<next-dist-dir>)
               at j (<next-dist-dir>)
               at k (<anonymous>)
               at l (<next-dist-dir>)
               at main (<anonymous>)
               at body (<anonymous>)
               at html (<anonymous>)
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error
           Export encountered an error on /page: /, exiting the build."
          `)
        }
      } else {
        if (inDebugMode) {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/": A component accessed data, headers, params, searchParams, or a short-lived cache without a Suspense boundary nor a "use cache" above it. We don't have the exact line number added to error messages yet but you can see which component in the stack below. See more info: https://nextjs.org/docs/messages/next-prerender-missing-suspense
               at section (<anonymous>)
               at main (<anonymous>)
               at InnerLayoutRouter (webpack://<next-src>)
               at RedirectErrorBoundary (webpack://<next-src>)
               at RedirectBoundary (webpack://<next-src>)
               at HTTPAccessFallbackErrorBoundary (webpack://<next-src>)
               at HTTPAccessFallbackBoundary (webpack://<next-src>)
               at LoadingBoundary (webpack://<next-src>)
               at ErrorBoundary (webpack://<next-src>)
               at InnerScrollAndFocusHandler (webpack://<next-src>)
               at ScrollAndFocusHandler (webpack://<next-src>)
               at RenderFromTemplateContext (<anonymous>)
               at OuterLayoutRouter (webpack://<next-src>)
               at main (<anonymous>)
               at body (<anonymous>)
               at html (<anonymous>)
             332 |  */
             333 | function InnerLayoutRouter({
           > 334 |   tree,
                 |  ^
             335 |   segmentPath,
             336 |   cacheNode,
             337 |   url,
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error

           > Export encountered errors on following paths:
           	/page: /"
          `)
        } else {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/": A component accessed data, headers, params, searchParams, or a short-lived cache without a Suspense boundary nor a "use cache" above it. We don't have the exact line number added to error messages yet but you can see which component in the stack below. See more info: https://nextjs.org/docs/messages/next-prerender-missing-suspense
               at a (<anonymous>)
               at main (<anonymous>)
               at b (<next-dist-dir>)
               at c (<next-dist-dir>)
               at d (<next-dist-dir>)
               at e (<next-dist-dir>)
               at f (<next-dist-dir>)
               at g (<next-dist-dir>)
               at h (<next-dist-dir>)
               at i (<next-dist-dir>)
               at j (<next-dist-dir>)
               at k (<anonymous>)
               at l (<next-dist-dir>)
               at main (<anonymous>)
               at body (<anonymous>)
               at html (<anonymous>)
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error
           Export encountered an error on /page: /, exiting the build."
          `)
        }
      }
    })
  })

  describe('Error Attribution with Sync IO - unguarded RSC with unguarded Client sync IO', () => {
    const { next, isNextDev, isTurbopack, skipped } = nextTestSetup({
      files:
        __dirname +
        '/fixtures/sync-attribution/unguarded-async-unguarded-clientsync',
      skipStart: true,
      skipDeployment: true,
      buildOptions: inDebugMode ? ['--debug-prerender'] : undefined,
    })

    if (skipped) {
      return
    }

    if (isNextDev) {
      it('does not run in dev', () => {})
      return
    }

    it('should error the build with a reason related to sync IO access', async () => {
      try {
        await next.start()
      } catch {
        // we expect the build to fail
      }

      const output = getPrerenderOutput(next.cliOutput, {
        isMinified: !inDebugMode,
      })

      if (isTurbopack) {
        if (inDebugMode) {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at SyncIO (turbopack:///[project]/app/client.tsx:5:15)
             3 | export function SyncIO() {
             4 |   // This is a sync IO access that should not cause an error
           > 5 |   const data = new Date().toISOString()
               |               ^
             6 |
             7 |   return (
             8 |     <main>
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error

           > Export encountered errors on following paths:
           	/page: /"
          `)
        } else {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at a (<next-dist-dir>)
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error
           Export encountered an error on /page: /, exiting the build."
          `)
        }
      } else {
        if (inDebugMode) {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at SyncIO (webpack:///app/client.tsx:5:15)
             3 | export function SyncIO() {
             4 |   // This is a sync IO access that should not cause an error
           > 5 |   const data = new Date().toISOString()
               |               ^
             6 |
             7 |   return (
             8 |     <main>
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error

           > Export encountered errors on following paths:
           	/page: /"
          `)
        } else {
          expect(output).toMatchInlineSnapshot(`
           "Error: Route "/" used \`new Date()\` inside a Client Component without a Suspense boundary above it. See more info here: https://nextjs.org/docs/messages/next-prerender-current-time-client
               at a (<next-dist-dir>)
           Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error
           Export encountered an error on /page: /, exiting the build."
          `)
        }
      }
    })
  })
})
