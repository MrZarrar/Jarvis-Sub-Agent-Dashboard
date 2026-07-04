---
name: Daily Briefing
icon: sun
description: Compose a short morning briefing and push it.
confirm: none
schedule: "0 7 * * *"
steps:
  - type: brain
    taskClass: standard
    prompt: |
      Compose a short morning briefing (3-5 sentences, no markdown) for the
      user's Jarvis dashboard: what's likely worth their attention today.
      If you have no specific context, give an honest, brief "no notable
      overnight activity" briefing rather than inventing details.
  - type: notify
    category: briefings
    title: Morning briefing
    message: "{brain_output}"
---

Runs every morning at 7am (see `schedule` above — 5-field cron, minute hour
day-of-month month day-of-week). `confirm: none` is required for a scheduled
skill to fire unattended; the engine refuses to cron-fire anything else.
