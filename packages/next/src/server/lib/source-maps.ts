import type { SourceMap } from 'module'

function noSourceMap(): SourceMap | undefined {
  return undefined
}

// Edge runtime does not implement `module`
const nativeFindSourceMap =
  process.env.NEXT_RUNTIME === 'edge'
    ? noSourceMap
    : (require('module') as typeof import('module')).findSourceMap

/**
 * https://tc39.es/source-map/#index-map
 */
interface IndexSourceMapSection {
  offset: {
    line: number
    column: number
  }
  map: BasicSourceMapPayload
}

// TODO(veil): Upstream types
/** https://tc39.es/ecma426/#sec-index-source-map */
interface IndexSourceMap {
  version: number
  file: string
  sections: IndexSourceMapSection[]
}

/** https://tc39.es/ecma426/#sec-source-map-format */
export interface BasicSourceMapPayload {
  version: number
  // TODO: Move to https://github.com/jridgewell/sourcemaps which is actively maintained
  /** WARNING: `file` is optional. */
  file: string
  sourceRoot?: string
  // TODO: Move to https://github.com/jridgewell/sourcemaps which is actively maintained
  /** WARNING: `sources[number]` can be `null`. */
  sources: Array<string>
  names: Array<string>
  mappings: string
  ignoreList?: number[]
}

export type ModernSourceMapPayload = BasicSourceMapPayload | IndexSourceMap

export function sourceMapIgnoreListsEverything(
  sourceMap: BasicSourceMapPayload
): boolean {
  return (
    sourceMap.ignoreList !== undefined &&
    sourceMap.sources.length === sourceMap.ignoreList.length
  )
}

/**
 * Finds the sourcemap payload applicable to a given frame.
 * Equal to the input unless an Index Source Map is used.
 * @param line0 - The line number of the frame, 0-based.
 * @param column0 - The column number of the frame, 0-based.
 */
export function findApplicableSourceMapPayload(
  line0: number,
  column0: number,
  payload: ModernSourceMapPayload
): BasicSourceMapPayload | undefined {
  if ('sections' in payload) {
    if (payload.sections.length === 0) {
      return undefined
    }

    // Sections must not overlap and must be sorted: https://tc39.es/source-map/#section-object
    // Therefore the last section that has an offset less than or equal to the frame is the applicable one.
    const sections = payload.sections
    let left = 0
    let right = sections.length - 1
    let result: IndexSourceMapSection | null = null

    while (left <= right) {
      // fast Math.floor
      const middle = ~~((left + right) / 2)
      const section = sections[middle]
      const offset = section.offset

      if (
        offset.line < line0 ||
        (offset.line === line0 && offset.column <= column0)
      ) {
        result = section
        left = middle + 1
      } else {
        right = middle - 1
      }
    }

    return result === null ? undefined : result.map
  } else {
    return payload
  }
}

const didWarnAboutInvalidSourceMapDEV = new Set<string>()

const findSourceMap: (scriptNameOrSourceURL: string) => SourceMap | undefined =
  process.env.NEXT_RUNTIME === 'nodejs' &&
  process.versions.node?.startsWith('18')
    ? // Node.js 18 has a horribly slow `findSourceMap` implementation
      noSourceMap
    : nativeFindSourceMap

export function filterStackFrameDEV(
  sourceURL: string,
  functionName: string,
  line1: number,
  column1: number
): boolean {
  if (sourceURL === '') {
    // The default implementation filters out <anonymous> stack frames
    // but we want to retain them because current Server Components and
    // built-in Components in parent stacks don't have source location.
    // Filter out frames that show up in Promises to get good names in React's
    // Server Request track until we come up with a better heuristic.
    return functionName !== 'new Promise'
  }
  if (sourceURL.startsWith('node:') || sourceURL.includes('node_modules')) {
    return false
  }
  try {
    // Node.js loads source maps eagerly so this call is cheap.
    // TODO: ESM sourcemaps are O(1) but CommonJS sourcemaps are O(Number of CJS modules).
    // Make sure this doesn't adversely affect performance when CJS is used by Next.js.
    const sourceMap = findSourceMap(sourceURL)
    if (sourceMap === undefined) {
      // No source map assoicated.
      // TODO: Node.js types should reflect that `findSourceMap` can return `undefined`.
      return true
    }
    const sourceMapPayload = findApplicableSourceMapPayload(
      line1 - 1,
      column1 - 1,
      sourceMap.payload
    )
    if (sourceMapPayload === undefined) {
      // No source map section applicable to the frame.
      return true
    }
    return !sourceMapIgnoreListsEverything(sourceMapPayload)
  } catch (cause) {
    if (process.env.NODE_ENV !== 'production') {
      // TODO: Share cache with patch-error-inspect
      if (!didWarnAboutInvalidSourceMapDEV.has(sourceURL)) {
        didWarnAboutInvalidSourceMapDEV.add(sourceURL)
        // We should not log an actual error instance here because that will re-enter
        // this codepath during error inspection and could lead to infinite recursion.
        console.error(
          `${sourceURL}: Invalid source map. Only conformant source maps can be used to filter stack frames. Cause: ${cause}`
        )
      }
    }

    return true
  }
}

export function devirtualizeReactServerURL(sourceURL: string): string {
  if (sourceURL.startsWith('rsc://React/')) {
    // rsc://React/Server/file://<filename>?42 => file://<filename>
    const envIdx = sourceURL.indexOf('/', 'rsc://React/'.length)
    const suffixIdx = sourceURL.lastIndexOf('?')
    if (envIdx > -1 && suffixIdx > -1) {
      return decodeURI(sourceURL.slice(envIdx + 1, suffixIdx))
    }
  }
  return sourceURL
}

function isAnonymousFrameLikelyJSNative(methodName: string): boolean {
  // Anonymous frames can also be produced in React parent stacks either from
  // host components or Server Components. We don't want to ignore those.
  // This could hide user-space methods that are named like native JS methods but
  // should you really do that?
  return (
    // e.g. JSON.parse
    methodName.startsWith('JSON.') ||
    // E.g. Promise.withResolves
    methodName.startsWith('Function.') ||
    // various JS built-ins
    methodName.startsWith('Promise.') ||
    methodName.startsWith('Array.') ||
    methodName.startsWith('Set.') ||
    methodName.startsWith('Map.')
  )
}

export function ignoreListAnonymousStackFramesIfSandwiched<Frame>(
  frames: Frame[],
  isAnonymousFrame: (frame: Frame) => boolean,
  isIgnoredFrame: (frame: Frame) => boolean,
  getMethodName: (frame: Frame) => string,
  /** only passes frames for which `isAnonymousFrame` and their method is a native JS method or `isIgnoredFrame` return true */
  ignoreFrame: (frame: Frame) => void
): void {
  for (let i = 1; i < frames.length; i++) {
    const currentFrame = frames[i]
    if (
      !(
        isAnonymousFrame(currentFrame) &&
        isAnonymousFrameLikelyJSNative(getMethodName(currentFrame))
      )
    ) {
      continue
    }

    const previousFrameIsIgnored = isIgnoredFrame(frames[i - 1])
    if (previousFrameIsIgnored && i < frames.length - 1) {
      let ignoreSandwich = false
      let j = i + 1
      for (j; j < frames.length; j++) {
        const nextFrame = frames[j]
        const nextFrameIsAnonymous =
          isAnonymousFrame(nextFrame) &&
          isAnonymousFrameLikelyJSNative(getMethodName(nextFrame))
        if (nextFrameIsAnonymous) {
          continue
        }

        const nextFrameIsIgnored = isIgnoredFrame(nextFrame)
        if (nextFrameIsIgnored) {
          ignoreSandwich = true
          break
        }
      }

      if (ignoreSandwich) {
        for (i; i < j; i++) {
          ignoreFrame(frames[i])
        }
      }
    }
  }
}
