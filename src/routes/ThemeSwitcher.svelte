<script lang="ts">
	import { enhance } from "$app/forms"
	import { page } from "$app/state"
	import { Popover, Portal } from "@skeletonlabs/skeleton-svelte"

	import ChevronDown from "@lucide/svelte/icons/chevron-down"
	import Palette from "@lucide/svelte/icons/palette"
	import X from "@lucide/svelte/icons/x"

	const themesData = [
		{ label: "Cerberus", value: "cerberus" },
		{ label: "Concord", value: "concord" },
		{ label: "Fennec", value: "fennec" },
		{ label: "Wasp", value: "wasp" }
	]

	let theme = $state(page.data.theme)
	let open = $state(false)
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
					<form class="w-52 card" id="theme-form" method="POST" action="/?/setTheme" use:enhance>
						<header class="flex justify-between">
							<p class="text-xl font-bold">Themes</p>
							<button class="btn-icon hover:preset-tonal" onclick={() => (open = false)}><X /></button>
						</header>
						<div class="my-4 flex flex-col">
							{#each themesData as entry (entry.value)}
								<button
									type="submit"
									class="my-2 btn preset-outlined-surface-500 hover:border-primary-500"
									formaction="/?/setTheme={entry.value}"
									onclick={() => {
										theme = entry.value
										document.body.setAttribute("data-theme", theme)
									}}
								>
									{entry.label}
								</button>
							{/each}
						</div>
					</form>
				</Popover.Content>
			</Popover.Positioner>
		</Portal>
	</Popover>
</div>
