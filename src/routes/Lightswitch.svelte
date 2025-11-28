<script lang="ts">
	import { enhance } from "$app/forms"
	import { page } from "$app/state"
	import SunMoon from "@lucide/svelte/icons/sun-moon"

	let dark = $state(page.data.darkMode)
</script>

<form
	id="dark-form"
	method="POST"
	action="/?/toggleDark"
	class="my-auto flex"
	use:enhance={() => {
		dark = !dark
		document.documentElement.classList.toggle("dark", dark)
	}}
>
	<button id="lightswitch" class="my-auto btn hover:preset-tonal" title="Toggle dark mode." type="submit">
		<SunMoon />
	</button>
</form>
