<script lang="ts">
	import Logo from "./Logo.svelte"
	import Lightswitch from "./Lightswitch.svelte"
	import ThemeSwitcher from "./ThemeSwitcher.svelte"
	import Discord from "./Discord.svelte"
	import GitHub from "./GitHub.svelte"
	import YouTube from "./YouTube.svelte"
	import Menu from "@lucide/svelte/icons/menu"
	import X from "@lucide/svelte/icons/x"

	let showMenu = $state(false)
</script>

<nav class="flex flex-col lg:flex-row w-screen justify-between bg-surface-200/30 font-semibold backdrop-blur-md dark:bg-surface-800/30 lg:p-2 absolute top-0">
	<button
		name="Menu"
		aria-label="Open the navigation menu"
		class="justify-left my-auto flex h-full p-2 align-middle text-primary-500 lg:hidden"
		onclick={() => showMenu = !showMenu}
	>
		{#if showMenu}
			<X class="mx-2 my-auto text-surface-900-100" />
		{:else}
			<Menu class="mx-2 my-auto text-surface-900-100" />
		{/if}
		<a href="/" class="h-full place-content-center place-items-center text-primary-500 hover:text-primary-700-300 flex" aria-label="Navigate to home page">
			<Logo selected={false} />
		</a>
	</button>

	<a href="/" class="h-full place-content-center place-items-center text-primary-500 hover:text-primary-700-300 hidden lg:flex" aria-label="Navigate to home page">
		<Logo selected={false} />
	</a>

	<div class="hidden gap-1 lg:flex">
		<Lightswitch />
		<ThemeSwitcher />
		<GitHub />
		<Discord />
		<YouTube />
	</div>

	<div class="z-50 lg:hidden {showMenu ? 'flex flex-col' : 'hidden'}">
		<div class="flex w-full justify-evenly">
			<ThemeSwitcher />
			<div class="flex">
				<Lightswitch />
				<GitHub />
				<Discord />
				<YouTube />
			</div>
		</div>
	</div>
</nav>
