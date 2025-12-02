<script lang="ts">
	import { enhance } from "$app/forms"
	import { Popover, Portal } from "@skeletonlabs/skeleton-svelte"

	import ChevronDown from "@lucide/svelte/icons/chevron-down"
	import Palette from "@lucide/svelte/icons/palette"
	import X from "@lucide/svelte/icons/x"
	import { getCookie, setCookie } from "$lib/utils"
	import { onMount } from "svelte"

	const themesData = [
		{ label: "Cerberus", value: "cerberus" },
		{ label: "Concord", value: "concord" },
		{ label: "Fennec", value: "fennec" },
		{ label: "Wasp", value: "wasp" }
	]

	let theme = $state("wasp")
	let open = $state(false)
	onMount(() => {
		const cookie = getCookie("theme")
		if (cookie != "") theme = cookie
	})
</script>

<div class="my-auto input-group flex hover:preset-tonal">
	<Popover {open} onOpenChange={(e) => (open = e.open)}>
		<Popover.Trigger class="btn h-full hover:preset-tonal">
			<Palette size="16" />
			<span class="mx-4 my-auto flex lg:hidden xl:flex">{theme}</span>
			<ChevronDown size="16" />
		</Popover.Trigger>
		<Portal>
			<Popover.Positioner>
				<Popover.Content class="max-w-md space-y-2 card bg-surface-100-900 p-4 shadow-xl">
					<div class="w-52 card">
						<header class="flex justify-between">
							<p class="text-xl font-bold">Themes</p>
							<button class="btn-icon hover:preset-tonal" onclick={() => (open = false)}><X /></button>
						</header>
						<div class="my-4 flex flex-col">
							{#each themesData as entry (entry.value)}
								<button
									type="button"
									class="my-2 btn preset-outlined-surface-500 hover:border-primary-500"
									onclick={() => {
										theme = entry.value
										document.body.setAttribute("data-theme", theme)
										setCookie("theme", entry.value, 360)
									}}
								>
									{entry.label}
								</button>
							{/each}
						</div>
					</div>
				</Popover.Content>
			</Popover.Positioner>
		</Portal>
	</Popover>
</div>
