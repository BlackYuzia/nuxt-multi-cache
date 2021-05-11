import path from 'path'
import { Url } from 'url'
import { Context, Module } from '@nuxt/types'
import Cache from './Cache'
import serverMiddleware, { ServerAuthMethod, ServerAuthCredentials } from './serverMiddleware'
import NuxtSSRCacheHelper from './ssrContextHelper'
import { StoreConfig } from 'cache-manager'
import { Options as LRUOptions } from 'lru-cache'
import ComponentCache, {ComponentCacheEntry} from './ComponentCache'
import DataCache from './DataCache'

const PLUGIN_PATH = path.resolve(__dirname, 'plugin.js')

export type EnabledForRequestMethod = (req: any, route: string) => boolean
export type GetCacheKeyMethod = (
  route: string,
  context: Context
) => string | void

export interface CacheConfigFilesystem {
  /**
   * Enable filesystem caching.
   */
  enabled: boolean

  /**
   * The folder where the routes should be written.
   *
   * You can use a relative or absolute path. It's also possible to use Nuxt
   * path aliases: '~/cache'.
   */
  folder: string
}

export interface CacheConfig {
  /**
   * Enable the module globally.
   *
   * Even if disabled, the module will attach the helper plugin, but won't do
   * anything besides that.
   */
  enabled: boolean

  /**
   * Logs helpful debugging messages to the console.
   */
  debug: boolean

  /**
   * Enable the filesystem cache.
   *
   * This will save every cached page to the specified location, preserving URL
   * structure and mapping them to folders and file names. Use this to serve
   * cached routes directly from Apache, nginx or any web server.
   */
  filesystem: CacheConfigFilesystem|null|undefined

  /**
   * Authenticate a server request.
   *
   * Provide an object with username and password properties to authenticate
   * using basic auth.
   * If you provide a function, you can perform the authentication yourself.
   * The function receives the request as an argument and should return a
   * boolean.
   */
  serverAuth: ServerAuthMethod|ServerAuthCredentials

  /**
   * A method to decide if a request should be considered for caching.
   *
   * The default method returns true for every route.
   * For example, you are able to completely prevent any caching if the user is
   * logged in, by checking for the presence of a cookie.
   */
  enabledForRequest: EnabledForRequestMethod

  /**
   * Determine the unique cache key for a route.
   *
   * This can be used to rewrite how the route is identified in the caching
   * process. For example, if you rely on query parameters for a route, you can
   * rewrite them like this:
   * /search?query=foo%20bar  => /search--query=foo__bar
   * This will allow you to cache routes depending on the query parameter and
   * then serve these from your webserver, if configured properly.
   */
  getCacheKey?: GetCacheKeyMethod

  componentCache?: ComponentCacheConfig
}

export interface ComponentCacheConfig {
  enabled: boolean
  lruOptions?: LRUOptions<string, ComponentCacheEntry>
}

/**
 * Determine the cache key for a route.
 */
function getCacheKey(route: string, context: any) {
  const url = context.req._parsedUrl as Url
  const pathname = url.pathname

  if (!pathname) {
    return
  }

  return route
}

/**
 * Default method enables caching for every request.
 */
function enabledForRequest() {
  return true
}

/*
 * Attaches a custom renderRoute method.
 *
 * It will store the SSR result in a local cache, if it is deemed cacheable.
 * Only anonymous requests (using the backend "API" user) will receive a cached
 * response.
 */
const cacheModule: Module = function () {
  const nuxt: any = this.nuxt
  const provided = this.options.routeCache || {}

  // Map the configuration and add defaults.
  const config: CacheConfig = {
    enabled: !!provided.enabled,
    debug: !!provided.debug,
    filesystem: provided.filesystem,
    serverAuth: provided.serverAuth,
    enabledForRequest: provided.enabledForRequest || enabledForRequest,
    getCacheKey: provided.getCacheKey || getCacheKey,
    componentCache: provided.componentCache || { enabled: true }
  }

  if (config.filesystem?.folder) {
    const resolver = this.nuxt.resolver.resolveAlias
    config.filesystem.folder = resolver(config.filesystem.folder)
  }

  // Add the cache helper plugin.
  this.addPlugin({
    src: PLUGIN_PATH,
  })

  function logger(message: string, type: string = 'info') {
    if (!config.debug) {
      return
    }
    const output = '[Nuxt Route Cache] - ' + message
    if (type === 'info') {
      console.info(output)
    } else if (type === 'warn') {
      console.warn(output)
    }
  }

  // Disable caching if disabled or renderer not available.
  if (!config.enabled || !nuxt.renderer) {
    logger('Caching is disabled.')
    return
  }

  // Disable caching if no purge authorization if provided.
  if (typeof provided.serverAuth !== 'object' && typeof provided.serverAuth !== 'function') {
    logger(
      'No serverAuth function or basic auth config provided, caching is disabled.',
      'warn'
    )
    return
  }

  // Create component cache instance.
  const componentCache = new ComponentCache(config.componentCache as ComponentCacheConfig)

  // Create cache instance.
  const cache = new Cache(config, componentCache)

  // Create DataCache instance.
  const dataCache = new DataCache()

  if (this.options.render.bundleRenderer) {
    console.log('ADD COMPONENT CACHE')
    this.options.render.bundleRenderer.cache = componentCache
  }

  // Add the server middleware to manage the cache.
  this.addServerMiddleware({
    path: '/__route_cache',
    handler: serverMiddleware(cache, dataCache, componentCache, config.serverAuth),
  })

  // Inject the cache helper object into the SSR context.
  this.nuxt.hook('vue-renderer:ssr:prepareContext', (ssrContext: any) => {
    ssrContext.$dataCache = dataCache
    ssrContext.$cacheHelper = new NuxtSSRCacheHelper()
  })

  // Attach custom renderer.
  const renderer = nuxt.renderer
  const renderRoute = renderer.renderRoute.bind(renderer)

  renderer.renderRoute = function (route: string, context: any) {
    const cacheKey = getCacheKey(route, context)
    const cacheForRequest = config.enabledForRequest(context.req, route)

    if (!cacheKey || !cacheForRequest) {
      if (!cacheKey) {
        logger('No cache key returned for route: ' + route)
      }
      if (!cacheForRequest) {
        logger('Caching skipped for request.')
      }
      // Don't do any caching for this request.
      return renderRoute(route, context)
    }

    // Render the page and put it in the cache if cacheable.
    function renderSetCache() {
      return renderRoute(route, context).then((result: any) => {
        // Check if the route is set as cacheable.
        if (context.$cacheHelper && context.$cacheHelper.cacheable) {
          // console.log(context.$cacheHelper.componentTags)
          const tags = context.$cacheHelper.tags || []
          const cacheGroups = context.$cacheHelper.cacheGroups || []
          cacheGroups.forEach((group: any) => cache.addCacheGroup(group.name, group.tags))
          
          cache
            .set(cacheKey as string, tags, result.html)
            .then(() => {
              logger('Cached route: ' + route)
              logger('         key: ' + cacheKey)
            })
            .catch((e) => {
              logger('Failed to cache route: ' + route, 'warn')
            })
        }
        return result
      })
    }

    return renderSetCache().catch(() => {
      logger('Failed to cache route: ' + route, 'warn')
      return renderRoute(route, context)
    })
  }
}

export default cacheModule
