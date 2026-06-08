import { Scalar } from '@scalar/hono-api-reference'
import { GET, Handle } from './$types'
import { fromHono } from "@boon4681/giri/hono"

export const handle = fromHono(Scalar({ url: '/openapi.json' }))