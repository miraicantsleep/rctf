<script lang="ts">
  import type { Snippet } from 'svelte'
  import { useClientConfig } from '$lib/query/config'
  import { useCurrentUser } from '$lib/query/user'
  import Button from '$lib/ui/button.svelte'
  import Card from '$lib/ui/card.svelte'
  import Spinner from '$lib/ui/spinner.svelte'

  const {
    setting,
    label,
    children,
  }: {
    setting: 'hideScoreboard' | 'hideChallenges'
    label: string
    children: Snippet
  } = $props()
  const configQuery = useClientConfig()
  const userQuery = useCurrentUser()
  const hidden = $derived(configQuery.data?.[setting] && !userQuery.data)
</script>

{#if configQuery.isPending || (hidden && userQuery.isPending)}
  <access-status><Spinner /></access-status>
{:else if hidden}
  <access-status>
    <Card title={label}>
      <p>Sign in to view the {label.toLowerCase()}.</p>
      <Button href="/login">Sign in</Button>
    </Card>
  </access-status>
{:else}
  {@render children()}
{/if}

<style>
  access-status {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    padding: var(--space-m);
  }
</style>
