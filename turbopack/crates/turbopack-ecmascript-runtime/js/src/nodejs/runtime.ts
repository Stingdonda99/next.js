/* eslint-disable @typescript-eslint/no-unused-vars */

/// <reference path="../shared/runtime-utils.ts" />
/// <reference path="../shared-node/base-externals-utils.ts" />
/// <reference path="../shared-node/node-externals-utils.ts" />
/// <reference path="../shared-node/node-wasm-utils.ts" />

enum SourceType {
  /**
   * The module was instantiated because it was included in an evaluated chunk's
   * runtime.
   * SourceData is a ChunkPath.
   */
  Runtime = 0,
  /**
   * The module was instantiated because a parent module imported it.
   * SourceData is a ModuleId.
   */
  Parent = 1,
}

type SourceData = ChunkPath | ModuleId

process.env.TURBOPACK = '1'

function stringifySourceInfo(
  sourceType: SourceType,
  sourceData: SourceData
): string {
  switch (sourceType) {
    case SourceType.Runtime:
      return `runtime for chunk ${sourceData}`
    case SourceType.Parent:
      return `parent module ${sourceData}`
    default:
      invariant(
        sourceType,
        (sourceType) => `Unknown source type: ${sourceType}`
      )
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

function loadChunk(
  sourceType: SourceType,
  sourceData: SourceData,
  chunkData: ChunkData
): void {
  if (typeof chunkData === 'string') {
    loadChunkPath(sourceType, sourceData, chunkData)
  } else {
    loadChunkPath(sourceType, sourceData, chunkData.path)
  }
}

const loadedChunks = new Set<ChunkPath>()
const unsupportedLoadChunk = Promise.resolve(undefined)
const loadedChunk: Promise<void> = Promise.resolve(undefined)
const chunkCache = new Map<ChunkPath, Promise<void>>()

function clearChunkCache() {
  chunkCache.clear()
}

function loadChunkPath(
  sourceType: SourceType,
  sourceData: SourceData,
  chunkPath: ChunkPath
): void {
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

    if (sourceType !== undefined) {
      errorMessage += ` from ${stringifySourceInfo(sourceType, sourceData)}`
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
  sourceType: SourceType,
  sourceData: SourceData,
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
      if (sourceType !== undefined) {
        errorMessage += ` from ${stringifySourceInfo(sourceType, sourceData)}`
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

function loadChunkAsyncByUrl(
  sourceType: SourceType,
  sourceData: SourceData,
  chunkUrl: string
) {
  const path = url.fileURLToPath(new URL(chunkUrl, RUNTIME_ROOT)) as ChunkPath
  return loadChunkAsync(sourceType, sourceData, path)
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

function instantiateModule(
  id: ModuleId,
  sourceType: SourceType,
  sourceData: SourceData
): Module {
  const moduleFactory = moduleFactories[id]
  if (typeof moduleFactory !== 'function') {
    // This can happen if modules incorrectly handle HMR disposes/updates,
    // e.g. when they keep a `setTimeout` around which still executes old code
    // and contains e.g. a `require("something")` call.
    let instantiationReason
    switch (sourceType) {
      case SourceType.Runtime:
        instantiationReason = `as a runtime entry of chunk ${sourceData}`
        break
      case SourceType.Parent:
        instantiationReason = `because it was required from module ${sourceData}`
        break
      default:
        invariant(
          sourceType,
          (sourceType) => `Unknown source type: ${sourceType}`
        )
    }
    throw new Error(
      `Module ${id} was instantiated ${instantiationReason}, but the module factory is not available.`
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
      l: loadChunkAsync.bind(null, SourceType.Parent, id),
      L: loadChunkAsyncByUrl.bind(null, SourceType.Parent, id),
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

  return instantiateModule(id, SourceType.Parent, sourceModule.id)
}

/**
 * Instantiates a runtime module.
 */
function instantiateRuntimeModule(
  chunkPath: ChunkPath,
  moduleId: ModuleId
): Module {
  return instantiateModule(moduleId, SourceType.Runtime, chunkPath)
}

/**
 * Retrieves a module from the cache, or instantiate it as a runtime module if it is not cached.
 */
// @ts-ignore TypeScript doesn't separate this module space from the browser runtime
function getOrInstantiateRuntimeModule(
  chunkPath: ChunkPath,
  moduleId: ModuleId
): Module {
  const module = moduleCache[moduleId]
  if (module) {
    if (module.error) {
      throw module.error
    }
    return module
  }

  return instantiateRuntimeModule(chunkPath, moduleId)
}

const regexJsUrl = /\.js(?:\?[^#]*)?(?:#.*)?$/
/**
 * Checks if a given path/URL ends with .js, optionally followed by ?query or #fragment.
 */
function isJs(chunkUrlOrPath: ChunkUrl | ChunkPath): boolean {
  return regexJsUrl.test(chunkUrlOrPath)
}

module.exports = (sourcePath: ChunkPath) => ({
  m: (id: ModuleId) => getOrInstantiateRuntimeModule(sourcePath, id),
  c: (chunkData: ChunkData) =>
    loadChunk(SourceType.Runtime, sourcePath, chunkData),
})
