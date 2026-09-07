<script lang="ts">
  import PublicAccess from '$lib/components/public-access.svelte'
  import type { LayoutProps } from './$types'

  const { children }: LayoutProps = $props()
</script>

<PublicAccess setting="hideScoreboard" label="Scoreboard">
  {@render children()}
</PublicAccess>
