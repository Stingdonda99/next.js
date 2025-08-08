import path from 'path'
import fs from 'fs/promises'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import * as Log from '../output/log'
import globOriginal from 'next/dist/compiled/glob'
import { interopDefault } from '../../lib/interop-default'
import type { AdapterOutputs, NextAdapter } from '../../server/config-shared'
import type {
  FunctionsConfigManifest,
  PrerenderManifest,
  RoutesManifest,
} from '..'
import type {
  EdgeFunctionDefinition,
  MiddlewareManifest,
} from '../webpack/plugins/middleware-plugin'
import { isMiddlewareFilename } from '../utils'
import { normalizePagePath } from '../../shared/lib/page-path/normalize-page-path'
import { normalizeAppPath } from '../../shared/lib/router/utils/app-paths'
import { AdapterOutputType } from '../../shared/lib/constants'
import { RenderingMode } from '../rendering-mode'

const glob = promisify(globOriginal)

export async function handleBuildComplete({
  // dir,
  distDir,
  tracingRoot,
  adapterPath,
  pageKeys,
  appPageKeys,
  hasNodeMiddleware,
  hasInstrumentationHook,
  requiredServerFiles,
  routesManifest,
  prerenderManifest,
  middlewareManifest,
  functionsConfigManifest,
}: {
  dir: string
  distDir: string
  adapterPath: string
  tracingRoot: string
  hasNodeMiddleware: boolean
  pageKeys: readonly string[]
  hasInstrumentationHook: boolean
  appPageKeys?: readonly string[] | undefined
  requiredServerFiles: string[]
  routesManifest: RoutesManifest
  prerenderManifest: PrerenderManifest
  middlewareManifest: MiddlewareManifest
  functionsConfigManifest: FunctionsConfigManifest
}) {
  const adapterMod = interopDefault(
    await import(pathToFileURL(require.resolve(adapterPath)).href)
  ) as NextAdapter

  if (typeof adapterMod.onBuildComplete === 'function') {
    Log.info(`Running onBuildComplete from ${adapterMod.name}`)

    try {
      const outputs: AdapterOutputs = []

      const staticFiles = await glob('**/*', {
        cwd: path.join(distDir, 'static'),
      })

      for (const file of staticFiles) {
        const pathname = path.posix.join('/_next/static', file)
        const filePath = path.join(distDir, 'static', file)
        outputs.push({
          type: AdapterOutputType.STATIC_FILE,
          id: path.join('static', file),
          pathname,
          filePath,
        })
      }

      const sharedNodeAssets: Record<string, string> = {}

      for (const file of requiredServerFiles) {
        // add to shared node assets
        const filePath = path.join(distDir, file)
        const fileOutputPath = path.relative(tracingRoot, filePath)
        sharedNodeAssets[fileOutputPath] = filePath
      }

      if (hasInstrumentationHook) {
        const assets = await handleTraceFiles(
          path.join(distDir, 'server', 'instrumentation.js.nft.json')
        )
        const fileOutputPath = path.relative(
          tracingRoot,
          path.join(distDir, 'server', 'instrumentation.js')
        )
        sharedNodeAssets[fileOutputPath] = path.join(
          distDir,
          'server',
          'instrumentation.js'
        )
        Object.assign(sharedNodeAssets, assets)
      }

      async function handleTraceFiles(
        traceFilePath: string
      ): Promise<Record<string, string>> {
        const assets: Record<string, string> = Object.assign(
          {},
          sharedNodeAssets
        )
        const traceData = JSON.parse(
          await fs.readFile(traceFilePath, 'utf8')
        ) as {
          files: string[]
        }
        const traceFileDir = path.dirname(traceFilePath)

        for (const relativeFile of traceData.files) {
          const tracedFilePath = path.join(traceFileDir, relativeFile)
          const fileOutputPath = path.relative(tracingRoot, tracedFilePath)
          assets[fileOutputPath] = tracedFilePath
        }
        return assets
      }

      async function handleEdgeFunction(
        page: EdgeFunctionDefinition,
        isMiddleware: boolean = false
      ) {
        let type = AdapterOutputType.PAGES
        const isAppPrefix = page.page.startsWith('app/')
        const isAppPage = isAppPrefix && page.page.endsWith('/page')
        const isAppRoute = isAppPrefix && page.page.endsWith('/route')

        if (isMiddleware) {
          type = AdapterOutputType.MIDDLEWARE
        } else if (isAppPage) {
          type = AdapterOutputType.APP_PAGE
        } else if (isAppRoute) {
          type = AdapterOutputType.APP_ROUTE
        } else if (page.page.startsWith('/api')) {
          type = AdapterOutputType.PAGES_API
        }

        const output: AdapterOutputs[0] = {
          id: page.name,
          runtime: 'edge',
          pathname: isAppPrefix ? normalizeAppPath(page.name) : page.name,
          filePath: path.join(
            distDir,
            'server',
            page.files.find(
              (item) =>
                item.startsWith('server/app') || item.startsWith('server/pages')
            ) || ''
          ),
          assets: {},
          type,
          config:
            type === AdapterOutputType.MIDDLEWARE
              ? {
                  matchers: page.matchers,
                }
              : {},
        }

        function handleFile(file: string) {
          const originalPath = path.join(distDir, file)
          const fileOutputPath = path.join(
            path.relative(tracingRoot, distDir),
            file
          )
          if (!output.assets) {
            output.assets = {}
          }
          output.assets[fileOutputPath] = originalPath
        }
        for (const file of page.files) {
          handleFile(file)
        }
        for (const item of [...(page.wasm || []), ...(page.assets || [])]) {
          handleFile(item.filePath)
        }
        outputs.push(output)
      }

      const edgeFunctionHandlers: Promise<any>[] = []

      for (const middleware of Object.values(middlewareManifest.middleware)) {
        if (isMiddlewareFilename(middleware.name)) {
          edgeFunctionHandlers.push(handleEdgeFunction(middleware, true))
        }
      }

      for (const page of Object.values(middlewareManifest.functions)) {
        edgeFunctionHandlers.push(handleEdgeFunction(page))
      }
      const pageOutputMap: Record<string, AdapterOutputs[0]> = {}

      for (const page of pageKeys) {
        if (middlewareManifest.functions.hasOwnProperty(page)) {
          continue
        }
        const route = normalizePagePath(page)

        const pageFile = path.join(
          distDir,
          'server',
          'pages',
          `${normalizePagePath(page)}.js`
        )
        const pageTraceFile = `${pageFile}.nft.json`
        const assets = await handleTraceFiles(pageTraceFile).catch((err) => {
          if (err.code !== 'ENOENT' || (page !== '/404' && page !== '/500')) {
            Log.warn(`Failed to locate traced assets for ${pageFile}`, err)
          }
          return {} as Record<string, string>
        })
        const functionConfig = functionsConfigManifest.functions[route] || {}

        const output: AdapterOutputs[0] = {
          id: route,
          type: page.startsWith('/api')
            ? AdapterOutputType.PAGES_API
            : AdapterOutputType.PAGES,
          filePath: pageTraceFile.replace(/\.nft\.json$/, ''),
          pathname: route,
          assets,
          runtime: 'nodejs',
          config: {
            maxDuration: functionConfig.maxDuration,
            preferredRegion: functionConfig.regions,
          },
        }
        pageOutputMap[page] = output
        outputs.push(output)
      }

      if (hasNodeMiddleware) {
        const middlewareFile = path.join(distDir, 'server', 'middleware.js')
        const middlewareTrace = `${middlewareFile}.nft.json`
        const assets = await handleTraceFiles(middlewareTrace)
        const functionConfig =
          functionsConfigManifest.functions['/_middleware'] || {}

        outputs.push({
          pathname: '/_middleware',
          id: '/_middleware',
          assets,
          type: AdapterOutputType.MIDDLEWARE,
          runtime: 'nodejs',
          filePath: middlewareFile,
          config: {
            matchers: functionConfig.matchers,
          },
        })
      }
      const appOutputMap: Record<string, AdapterOutputs[0]> = {}

      if (appPageKeys) {
        for (const page of appPageKeys) {
          if (middlewareManifest.functions.hasOwnProperty(page)) {
            continue
          }
          const normalizedPage = normalizeAppPath(page)
          const pageFile = path.join(distDir, 'server', 'app', `${page}.js`)
          const pageTraceFile = `${pageFile}.nft.json`
          const assets = await handleTraceFiles(pageTraceFile).catch((err) => {
            Log.warn(`Failed to copy traced files for ${pageFile}`, err)
            return {} as Record<string, string>
          })
          const functionConfig =
            functionsConfigManifest.functions[normalizedPage] || {}

          const output: AdapterOutputs[0] = {
            pathname: normalizedPage,
            id: normalizedPage,
            assets,
            type: page.endsWith('/route')
              ? AdapterOutputType.APP_ROUTE
              : AdapterOutputType.APP_PAGE,
            runtime: 'nodejs',
            filePath: pageFile,
            config: {
              maxDuration: functionConfig.maxDuration,
              preferredRegion: functionConfig.regions,
            },
          }
          appOutputMap[normalizedPage] = output
          outputs.push(output)
        }
      }

      const getParentOutput = (srcRoute: string, childRoute: string) => {
        const parentOutput = pageOutputMap[srcRoute] || appOutputMap[srcRoute]

        if (!parentOutput) {
          console.error({
            appOutputs: Object.keys(appOutputMap),
            pageOutputs: Object.keys(pageOutputMap),
          })
          throw new Error(
            `Invariant: failed to find source route ${srcRoute} for prerender ${childRoute}`
          )
        }
        return parentOutput
      }

      for (const route in prerenderManifest.routes) {
        const {
          initialExpireSeconds: initialExpiration,
          initialRevalidateSeconds: initialRevalidate,
          initialHeaders,
          initialStatus,
          prefetchDataRoute,
          dataRoute,
          renderingMode,
        } = prerenderManifest.routes[route]

        const srcRoute = prerenderManifest.routes[route].srcRoute || route
        const isAppPage = dataRoute?.endsWith('.rsc')

        const filePath = path.join(
          distDir,
          'server',
          isAppPage ? 'app' : 'pages',
          `${route}.html`
        )
        const initialOutput = {
          id: route,
          type: AdapterOutputType.PRERENDER,
          pathname: route,
          parentOutputId: getParentOutput(srcRoute, route).id,
          fallback: {
            filePath,
            initialStatus,
            initialHeaders,
            initialExpiration,
            initialRevalidate,
          },
          config: {
            renderingMode,
          },
        }
        outputs.push(initialOutput)

        if (dataRoute) {
          let dataFilePath = path.join(
            distDir,
            'server',
            'pages',
            `${route}.json`
          )

          if (isAppPage) {
            // When experimental PPR is enabled, we expect that the data
            // that should be served as a part of the prerender should
            // be from the prefetch data route. If this isn't enabled
            // for ppr, the only way to get the data is from the data
            // route.
            dataFilePath = path.join(
              distDir,
              'server',
              'app',
              prefetchDataRoute &&
                renderingMode === RenderingMode.PARTIALLY_STATIC
                ? prefetchDataRoute
                : dataRoute
            )
          }

          outputs.push({
            ...initialOutput,
            id: dataRoute,
            pathname: dataRoute,
            fallback: {
              ...initialOutput.fallback,
              filePath: dataFilePath,
            },
          })
        }
      }

      for (const dynamicRoute in prerenderManifest.dynamicRoutes) {
        const {
          fallback,
          fallbackExpire,
          fallbackRevalidate,
          fallbackHeaders,
          fallbackStatus,
          dataRoute,
        } = prerenderManifest.dynamicRoutes[dynamicRoute]

        const isAppPage = dataRoute?.endsWith('.rsc')

        const initialOutput = {
          id: dynamicRoute,
          type: AdapterOutputType.PRERENDER,
          pathname: dynamicRoute,
          parentOutputId: getParentOutput(dynamicRoute, dynamicRoute).id,
          fallback:
            typeof fallback === 'string'
              ? {
                  filePath: path.join(
                    distDir,
                    'server',
                    isAppPage ? 'app' : 'pages',
                    fallback
                  ),
                  initialStatus: fallbackStatus,
                  initialHeaders: fallbackHeaders,
                  initialExpiration: fallbackExpire,
                  initialRevalidate: fallbackRevalidate,
                }
              : undefined,
        }
        outputs.push(initialOutput)

        if (dataRoute) {
          outputs.push({
            ...initialOutput,
            id: dataRoute,
            pathname: dataRoute,
          })
        }
      }

      // TODO: should these be normal outputs or meta on associated routes?
      // for (const route of prerenderManifest.notFoundRoutes) {
      //   // The fallback here is the 404 page if statically generated
      //   // if it is not then the fallback is empty and it is generated
      //   // at runtime

      //   outputs.push({
      //     id: route,
      //     type: OutputType.PRERENDER,
      //     pathname: route,
      //     runtime: 'nodejs',
      //     fallback: {
      //       filePath: '',
      //       initialStatus: 404,
      //       initialHeaders: {},
      //     },
      //   })
      // }

      await adapterMod.onBuildComplete({
        routes: {
          dynamicRoutes: routesManifest.dynamicRoutes,
          rewrites: routesManifest.rewrites,
          redirects: routesManifest.redirects,
          headers: routesManifest.headers,
        },
        outputs,
      })
    } catch (err) {
      Log.error(`Failed to run onBuildComplete from ${adapterMod.name}`)
      throw err
    }
  }
}
