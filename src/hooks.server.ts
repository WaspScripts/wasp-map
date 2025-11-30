import { type Handle } from "@sveltejs/kit"
import { sequence } from "@sveltejs/kit/hooks"

const darkMode: Handle = async ({ event, resolve }) => {
	let dark = event.cookies.get("darkMode")

	if (!dark) {
		dark = "true"
		event.cookies.set("darkMode", dark, { path: "/", maxAge: 60 * 60 * 24 * 7 * 360 })
	}

	const darkMode = dark === "true"
	if (!darkMode) return await resolve(event)

	return await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('class=""', `class="dark"`)
	})
}

const theme: Handle = async ({ event, resolve }) => {
	const cookieTheme = event.cookies.get("theme")

	if (!cookieTheme) {
		event.cookies.set("theme", "wasp", { path: "/" })
	}

	return await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('data-theme=""', `data-theme="${cookieTheme ?? "wasp"}"`)
	})
}

const performanceCheck: Handle = async ({ event, resolve }) => {
	const start = performance.now()
	const { url } = event
	const response = await resolve(event)
	const loadTime = performance.now() - start
	console.log(`└🚀 ${url} took ${loadTime.toFixed(2)} ms to load!`)
	return response
}

export const handle: Handle = sequence(darkMode, theme, performanceCheck)
