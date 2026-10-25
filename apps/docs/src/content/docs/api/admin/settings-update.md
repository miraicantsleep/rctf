---
title: "`<route>PUT</route>` Update settings"
description: "`<route>PUT /api/v2/admin/settings</route>`"
order: 21
---

:::aside

::::route-example{def="UpdateAdminSettingsRouteV2" extra="BadJson,BadBody"}

```json body
{
  "data": {
    "ctfName": "Example CTF",
    "homeContent": "# Welcome",
    "startTime": 1770000000000,
    "endTime": 1770100000000,
    "freezeTime": 1770090000000,
    "sponsors": [
      {
        "name": "Example",
        "icon": "https://example.com/icon.png",
        "description": "Sponsor",
        "url": "https://example.com"
      }
    ],
    "meta": {
      "description": "Example CTF",
      "imageUrl": "https://example.com/card.png"
    },
    "faviconUrl": null,
    "logoLightUrl": null,
    "logoDarkUrl": null
  }
}
```

::::

:::

::route-meta{def="UpdateAdminSettingsRouteV2"}

This route updates runtime setting overrides. A nullable field set to `null{:ts}` clears that override and lets the configured default take effect again.

Changing effective competition timing queues a leaderboard recalculation. An enabled freeze time must fall inside the competition window. Set `freezeEnabled` to `false` to disable freezing while retaining the schedule, including a schedule inherited from configuration. Setting either override to `null` restores its default.

Once reached, the freeze holds public standings, ranks, graphs, and challenge statistics at the cutoff. Teams retain their current personal score and solves; users with `leaderboardRead` retain live access. Blood announcements continue with anonymous solver identities.

::request-body{def="UpdateAdminSettingsRouteV2" title="Request body"}

::response-body{def="UpdateAdminSettingsRouteV2" response="goodAdminSettingsUpdate" title="Response fields"}
