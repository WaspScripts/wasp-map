<script lang="ts">
	import "../app.css"
	import favicon from "$lib/assets/favicon.png"
	import Navigation from "./Navigation.svelte"

	let { children } = $props()
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Navigation></Navigation>
{@render children()}
