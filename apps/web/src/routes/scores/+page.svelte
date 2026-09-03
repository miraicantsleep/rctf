<script lang="ts">
  import { Permissions } from '@rctf/types'
  import CtfNotStarted from '$lib/components/ctf-not-started.svelte'
  import { IconFlagBanner, IconSearch, IconTrophy } from '$lib/icons'
  import { useClientConfig } from '$lib/query/config'
  import EmptyState from '$lib/ui/empty-state.svelte'
  import Spinner from '$lib/ui/spinner.svelte'
  import ScoresLeaderboard from './leaderboard/leaderboard.svelte'
  import { createScoresData } from './model/data.svelte'
  import { createScoresRouteState } from './model/url-state.svelte'
  import ScoresScreenshotContainer from './screenshot/screenshot-container.svelte'
  import ScoresToolbar from './toolbar/toolbar.svelte'
  import { hasPermissions } from '$lib/utils/permissions'

  const configQuery = useClientConfig()
  const ctfName = $derived(configQuery.data?.ctfName)
  const divisions = $derived(configQuery.data?.divisions ?? {})
  const startTime = $derived(configQuery.data?.startTime ?? 0)
  const freezeTime = $derived(configQuery.data?.freezeTime ?? null)

  let now = $state(Date.now())
  $effect(() => {
    const interval = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(interval)
  })

  const urlState = createScoresRouteState()

  const data = createScoresData({
    division: () => urlState.division,
    search: () => urlState.search,
    sortMode: () => urlState.sortMode,
    focusedChallengeId: () => urlState.focusedChallengeId,
    showTop3Context: () => urlState.showTop3Context,
    showSelfContext: () => urlState.showSelfContext,
  })

  const isFrozen = $derived(freezeTime !== null && now >= freezeTime)
  const seesLiveScoreboard = $derived(
    hasPermissions(data.currentUser, Permissions.leaderboardRead)
  )
  const formattedFreezeTime = $derived(
    freezeTime === null
      ? ''
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(freezeTime)
  )

  const revealAfterLoading = data.isLoading

  const endTime = $derived(configQuery.data?.endTime ?? null)

  let screenshotOpen = $state(false)

  const focusFetching = $derived(
    !!urlState.focusedChallengeId &&
      data.entries.length === 0 &&
      (data.hasNextPage || data.isFetchingNextPage)
  )
</script>

<svelte:head>
  {#if ctfName}
    <title>Scores | {ctfName}</title>
  {/if}
</svelte:head>

{#if data.isNotStarted}
  <CtfNotStarted />
{:else}
  <scores-page>
    <ScoresToolbar
      {data}
      {urlState}
      {divisions}
      onScreenshot={() => (screenshotOpen = true)}
    />

    {#if isFrozen}
      <freeze-notice role="status">
        <strong
          >{seesLiveScoreboard
            ? 'Public scoreboard frozen'
            : 'Scoreboard frozen'}</strong
        >
        <span>
          at <time datetime={new Date(freezeTime!).toISOString()}
            >{formattedFreezeTime}</time
          >.
          {seesLiveScoreboard
            ? ' You are viewing live scores because you have leaderboard access.'
            : data.currentUser
              ? ' Your own team score and solves remain live.'
              : ' Standings and challenge statistics are held at the freeze time.'}
        </span>
      </freeze-notice>
    {/if}

    {#if data.isLoading || focusFetching}
      <scores-leaderboard-slot>
        <Spinner />
      </scores-leaderboard-slot>
    {:else if data.loadError && data.entries.length === 0}
      <scores-leaderboard-slot>
        <EmptyState
          icon={IconTrophy}
          title="Couldn't load the scoreboard"
          subtitle={data.loadError.message}
        />
      </scores-leaderboard-slot>
    {:else if data.entries.length > 0}
      <scores-frame data-reveal={revealAfterLoading || undefined}>
        <ScoresLeaderboard {data} {urlState} {divisions} {startTime} />
      </scores-frame>
    {:else}
      <scores-leaderboard-slot>
        {#if urlState.focusedChallengeId}
          <EmptyState
            icon={IconFlagBanner}
            title="No solves"
            subtitle="No matching teams have solved this challenge."
          />
        {:else if urlState.search}
          <EmptyState
            icon={IconSearch}
            title="No teams found"
            subtitle="Try a different search term."
          />
        {:else}
          <EmptyState
            icon={IconTrophy}
            title="No scores yet"
            subtitle="Check back once teams start solving."
          />
        {/if}
      </scores-leaderboard-slot>
    {/if}

    {#if screenshotOpen}
      <ScoresScreenshotContainer
        open={screenshotOpen}
        onOpenChange={open => (screenshotOpen = open)}
        {urlState}
        ctfName={ctfName ?? ''}
        {startTime}
        {endTime}
      />
    {/if}
  </scores-page>
{/if}

<style>
  scores-page {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
    block-size: calc(100dvh - var(--header-height));
    max-block-size: calc(100dvh - var(--header-height));
    overflow: hidden;
    padding-block-end: 1rem;
  }

  scores-frame {
    display: flex;
    flex: 1;
    justify-content: center;
    min-block-size: 0;
    max-inline-size: 100%;
    padding-inline: 1rem;

    @media (width >= 48rem) {
      padding-inline: 2.25rem;
    }
  }

  freeze-notice {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0 1rem var(--space-xs);
    padding: 0.65rem 0.85rem;
    border: 2px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--background-l1);
    color: var(--foreground-l2);
    font-size: var(--step--1);

    strong {
      color: var(--foreground-l0);
    }

    @media (width >= 48rem) {
      margin-inline: 2.25rem;
    }
  }

  scores-leaderboard-slot {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-block-size: 0;
  }
</style>
