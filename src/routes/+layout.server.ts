export const load = async ({ cookies }) => {
	const darkMode = cookies.get("darkMode") === "true"
	const theme = cookies.get("theme") ?? "wasp"

	return {
		darkMode,
		theme,
		cookies: cookies.getAll()
	}
}
