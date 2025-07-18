/* eslint-disable @typescript-eslint/no-unused-vars */

/// <reference path="../shared/runtime-utils.ts" />
/// <reference path="../shared-node/base-externals-utils.ts" />
/// <reference path="../shared-node/node-externals-utils.ts" />
/// <reference path="../shared-node/node-wasm-utils.ts" />

enum SourceType {
  /**
   * The module was instantiated because it was included in an evaluated chunk's
   * runtime.
   */
  Runtime = 0,
  /**
   * The module was instantiated because a parent module imported it.
   */
  Parent = 1,
}

type SourceInfo =
  | {
      type: SourceType.Runtime
      chunkPath: ChunkPath
    }
  | {
      type: SourceType.Parent
      parentId: ModuleId
    }

process.env.TURBOPACK = '1'

function stringifySourceInfo(source: SourceInfo): string {
  switch (source.type) {
    case SourceType.Runtime:
      return `runtime for chunk ${source.chunkPath}`
    case SourceType.Parent:
      return `parent module ${source.parentId}`
    default:
      invariant(source, (source) => `Unknown source type: ${source?.type}`)
  }
}

type ExternalRequire = (
  id: ModuleId,
  thunk: () => any,
  esm?: boolean
) => Exports | EsmNamespaceObject
type ExternalImport = (id: ModuleId) => Promise<Exports | EsmNamespaceObject>

interface TurbopackNodeBuildContext extends TurbopackBaseContext<Module> {
  R: ResolvePathFromModule
  x: ExternalRequire
  y: ExternalImport
}

type ModuleFactory = (
  this: Module['exports'],
  context: TurbopackNodeBuildContext
) => unknown

const url = require('url') as typeof import('url')
const fs = require('fs/promises') as typeof import('fs/promises')

const moduleFactories: ModuleFactories = Object.create(null)
const moduleCache: ModuleCache<Module> = Object.create(null)

/**
 * Returns an absolute path to the given module's id.
 */
function createResolvePathFromModule(
  resolver: (moduleId: string) => Exports
): (moduleId: string) => string {
  return function resolvePathFromModule(moduleId: string): string {
    const exported = resolver(moduleId)
    const exportedPath = exported?.default ?? exported
    if (typeof exportedPath !== 'string') {
      return exported as any
    }

    const strippedAssetPrefix = exportedPath.slice(ASSET_PREFIX.length)
    const resolved = path.resolve(RUNTIME_ROOT, strippedAssetPrefix)

    return url.pathToFileURL(resolved).href
  }
}

function loadChunk(chunkData: ChunkData, source?: SourceInfo): void {
  if (typeof chunkData === 'string') {
    loadChunkPath(chunkData, source)
  } else {
    loadChunkPath(chunkData.path, source)
  }
}

const loadedChunks = new Set<ChunkPath>()
const unsupportedLoadChunk = Promise.resolve(undefined)
const loadedChunk: Promise<void> = Promise.resolve(undefined)
const chunkCache = new Map<ChunkPath, Promise<void>>()

function clearChunkCache() {
  chunkCache.clear()
}

function loadChunkPath(chunkPath: ChunkPath, source?: SourceInfo): void {
  if (!isJs(chunkPath)) {
    // We only support loading JS chunks in Node.js.
    // This branch can be hit when trying to load a CSS chunk.
    return
  }

  if (loadedChunks.has(chunkPath)) {
    return
  }

  try {
    const resolved = path.resolve(RUNTIME_ROOT, chunkPath)
    const chunkModules: CompressedModuleFactories = require(resolved)

    for (const [moduleId, moduleFactory] of Object.entries(chunkModules)) {
      if (!moduleFactories[moduleId]) {
        if (Array.isArray(moduleFactory)) {
          const [moduleFactoryFn, otherIds] = moduleFactory
          moduleFactories[moduleId] = moduleFactoryFn
          for (const otherModuleId of otherIds) {
            moduleFactories[otherModuleId] = moduleFactoryFn
          }
        } else {
          moduleFactories[moduleId] = moduleFactory
        }
      }
    }
    loadedChunks.add(chunkPath)
  } catch (e) {
    let errorMessage = `Failed to load chunk ${chunkPath}`

    if (source) {
      errorMessage += ` from ${stringifySourceInfo(source)}`
    }

    throw new Error(errorMessage, {
      cause: e,
    })
  }
}

function loadChunkUncached(chunkPath: ChunkPath) {
  // resolve to an absolute path to simplify `require` handling
  const resolved = path.resolve(RUNTIME_ROOT, chunkPath)

  // TODO: consider switching to `import()` to enable concurrent chunk loading and async file io
  // However this is incompatible with hot reloading (since `import` doesn't use the require cache)
  const chunkModules: CompressedModuleFactories = require(resolved)
  for (const [moduleId, moduleFactory] of Object.entries(chunkModules)) {
    if (!moduleFactories[moduleId]) {
      if (Array.isArray(moduleFactory)) {
        const [moduleFactoryFn, otherIds] = moduleFactory
        moduleFactories[moduleId] = moduleFactoryFn
        for (const otherModuleId of otherIds) {
          moduleFactories[otherModuleId] = moduleFactoryFn
        }
      } else {
        moduleFactories[moduleId] = moduleFactory
      }
    }
  }
}

function loadChunkAsync(
  source: SourceInfo,
  chunkData: ChunkData
): Promise<void> {
  const chunkPath = typeof chunkData === 'string' ? chunkData : chunkData.path
  if (!isJs(chunkPath)) {
    // We only support loading JS chunks in Node.js.
    // This branch can be hit when trying to load a CSS chunk.
    return unsupportedLoadChunk
  }

  let entry = chunkCache.get(chunkPath)
  if (entry === undefined) {
    try {
      // Load the chunk synchronously
      loadChunkUncached(chunkPath)
      entry = loadedChunk
    } catch (e) {
      let errorMessage = `Failed to load chunk ${chunkPath}`
      if (source) {
        errorMessage += ` from ${stringifySourceInfo(source)}`
      }

      // Cache the failure promise, future requests will also get this same rejection
      entry = Promise.reject(
        new Error(errorMessage, {
          cause: e,
        })
      )
    }
    chunkCache.set(chunkPath, entry)
  }
  // TODO: Return an instrumented Promise that React can use instead of relying on referential equality.
  return entry
}

function loadChunkAsyncByUrl(source: SourceInfo, chunkUrl: string) {
  const path = url.fileURLToPath(new URL(chunkUrl, RUNTIME_ROOT)) as ChunkPath
  return loadChunkAsync(source, path)
}

function loadWebAssembly(
  chunkPath: ChunkPath,
  _edgeModule: () => WebAssembly.Module,
  imports: WebAssembly.Imports
) {
  const resolved = path.resolve(RUNTIME_ROOT, chunkPath)

  return instantiateWebAssemblyFromPath(resolved, imports)
}

function loadWebAssemblyModule(
  chunkPath: ChunkPath,
  _edgeModule: () => WebAssembly.Module
) {
  const resolved = path.resolve(RUNTIME_ROOT, chunkPath)

  return compileWebAssemblyFromPath(resolved)
}

function getWorkerBlobURL(_chunks: ChunkPath[]): string {
  throw new Error('Worker blobs are not implemented yet for Node.js')
}

function instantiateModule(id: ModuleId, source: SourceInfo): Module {
  const moduleFactory = moduleFactories[id]
  if (typeof moduleFactory !== 'function') {
    // This can happen if modules incorrectly handle HMR disposes/updates,
    // e.g. when they keep a `setTimeout` around which still executes old code
    // and contains e.g. a `require("something")` call.
    let instantiationReason
    switch (source.type) {
      case SourceType.Runtime:
        instantiationReason = `as a runtime entry of chunk ${source.chunkPath}`
        break
      case SourceType.Parent:
        instantiationReason = `because it was required from module ${source.parentId}`
        break
      default:
        invariant(source, (source) => `Unknown source type: ${source?.type}`)
    }
    throw new Error(
      `Module ${id} was instantiated ${instantiationReason}, but the module factory is not available. It might have been deleted in an HMR update.`
    )
  }

  const module: Module = {
    exports: {},
    error: undefined,
    loaded: false,
    id,
    namespaceObject: undefined,
  }
  moduleCache[id] = module

  // NOTE(alexkirsz) This can fail when the module encounters a runtime error.
  try {
    const r = commonJsRequire.bind(null, module)
    moduleFactory.call(module.exports, {
      a: asyncModule.bind(null, module),
      e: module.exports,
      r,
      t: runtimeRequire,
      x: externalRequire,
      y: externalImport,
      f: moduleContext,
      i: esmImport.bind(null, module),
      s: esmExport.bind(null, module, module.exports, moduleCache),
      j: dynamicExport.bind(null, module, module.exports, moduleCache),
      v: exportValue.bind(null, module, moduleCache),
      n: exportNamespace.bind(null, module, moduleCache),
      m: module,
      c: moduleCache,
      M: moduleFactories,
      l: loadChunkAsync.bind(null, { type: SourceType.Parent, parentId: id }),
      L: loadChunkAsyncByUrl.bind(null, {
        type: SourceType.Parent,
        parentId: id,
      }),
      C: clearChunkCache,
      w: loadWebAssembly,
      u: loadWebAssemblyModule,
      P: resolveAbsolutePath,
      U: relativeURL,
      R: createResolvePathFromModule(r),
      b: getWorkerBlobURL,
      z: requireStub,
    })
  } catch (error) {
    module.error = error as any
    throw error
  }

  module.loaded = true
  if (module.namespaceObject && module.exports !== module.namespaceObject) {
    // in case of a circular dependency: cjs1 -> esm2 -> cjs1
    interopEsm(module.exports, module.namespaceObject)
  }

  return module
}

/**
 * Retrieves a module from the cache, or instantiate it if it is not cached.
 */
// @ts-ignore
function getOrInstantiateModuleFromParent(
  id: ModuleId,
  sourceModule: Module
): Module {
  const module = moduleCache[id]

  if (module) {
    return module
  }

  return instantiateModule(id, {
    type: SourceType.Parent,
    parentId: sourceModule.id,
  })
}

/**
 * Instantiates a runtime module.
 */
function instantiateRuntimeModule(
  moduleId: ModuleId,
  chunkPath: ChunkPath
): Module {
  return instantiateModule(moduleId, { type: SourceType.Runtime, chunkPath })
}

/**
 * Retrieves a module from the cache, or instantiate it as a runtime module if it is not cached.
 */
// @ts-ignore TypeScript doesn't separate this module space from the browser runtime
function getOrInstantiateRuntimeModule(
  moduleId: ModuleId,
  chunkPath: ChunkPath
): Module {
  const module = moduleCache[moduleId]
  if (module) {
    if (module.error) {
      throw module.error
    }
    return module
  }

  return instantiateRuntimeModule(moduleId, chunkPath)
}

const regexJsUrl = /\.js(?:\?[^#]*)?(?:#.*)?$/
/**
 * Checks if a given path/URL ends with .js, optionally followed by ?query or #fragment.
 */
function isJs(chunkUrlOrPath: ChunkUrl | ChunkPath): boolean {
  return regexJsUrl.test(chunkUrlOrPath)
}

module.exports = {
  getOrInstantiateRuntimeModule,
  loadChunk,
}
