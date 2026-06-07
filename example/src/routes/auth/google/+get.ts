import "dotenv/config"
import { fromHono } from "@boon4681/giri/adapters/hono";
import { googleAuth } from '@hono/oauth-providers/google';
import { GET } from "./$types";

export const middleware = fromHono(googleAuth({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    scope: ['openid', 'email', 'profile'],
    redirect_uri: process.env.AUTH_REDIRECT,
}))

export const handle: GET = async (c) => {
    // Typed as `Partial<GoogleUser> | undefined` from @hono/oauth-providers' ContextVariableMap.
    const user = c.get("user-google")
    return c.json({ email: user?.email })
}