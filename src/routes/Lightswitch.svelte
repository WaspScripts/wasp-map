<script lang="ts">
	import { enhance } from "$app/forms"
	import { getCookie, setCookie } from "$lib/utils"
	import SunMoon from "@lucide/svelte/icons/sun-moon"
	import { onMount } from "svelte"

	let dark = $state(true)

	onMount(() => {
		const cookie = getCookie("darkMode")
		if (cookie != "") dark = cookie === "true"
	})
</script>

<div class="my-auto flex">
	<button
		id="lightswitch"
		class="my-auto btn hover:preset-tonal"
		title="Toggle dark mode."
		type="button"
		onclick={() => {
			dark = !dark
			document.documentElement.classList.toggle("dark", dark)
			setCookie("darkMode", dark.toString(), 360)
		}}
	>
		<SunMoon />
	</button>
</div>
