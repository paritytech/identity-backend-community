import { createOpenAPIHono } from '#root/lib/problem-details.js'
import { Effect } from 'effect'
import type { MiddlewareHandler } from 'hono'
import { except } from 'hono/combine'
import { cors } from 'hono/cors'
import { etag } from 'hono/etag'
import { makeCheckAvailabilityRoute } from './check-availability/routes.js'
import { makeGetUsernameRoute, makeListUsernamesRoute } from './get/mod.js'
import { makeRegisterUsernameRoute } from './register/mod.js'
import { makeSearchUsernamesRoute } from './search/username-search.routes.js'

export const makeUsernamesRoute = Effect.fn('v1.make_usernames_route')(function*(
  authMiddleware: MiddlewareHandler,
  rateLimit: { readonly authActions: MiddlewareHandler; readonly search: MiddlewareHandler },
) {
  const checkAvailability = yield* makeCheckAvailabilityRoute()
  const register = yield* makeRegisterUsernameRoute()
  const getUsername = yield* makeGetUsernameRoute()
  const listUsernames = yield* makeListUsernamesRoute()
  const search = yield* makeSearchUsernamesRoute()

  return createOpenAPIHono()
    .use('/', cors(), etag({ weak: true }))
    .use(
      '/',
      except(
        (c) => c.req.path.startsWith('/search'),
        authMiddleware,
      ),
    )
    .use(
      '/',
      except(
        (c) => c.req.path.startsWith('/search'),
        rateLimit.authActions,
      ),
    )
    .use(
      '/search',
      rateLimit.search,
    )
    .route('/available', checkAvailability)
    .route('/', register)
    .route('/', search)
    .route('/', getUsername)
    .route('/', listUsernames)
})
