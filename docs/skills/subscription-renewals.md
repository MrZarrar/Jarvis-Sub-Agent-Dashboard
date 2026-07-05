---
name: Subscription Renewals
icon: bell
description: Scan the subscriptions ledger note and push renewals due in the next N days.
confirm: none
schedule: "0 9 * * *"
params:
  - name: ledger
    type: string
    label: "Ledger file"
    default: "~/JarvisNotes/reference/subscriptions.md"
  - name: days
    type: string
    label: "Look-ahead (days)"
    default: "14"
steps:
  - type: shell
    label: "Read today's date + the ledger"
    command: |
      date '+TODAY: %Y-%m-%d'
      cat {ledger} 2>/dev/null || echo "LEDGER MISSING: {ledger}"
    cwd: "~"
    timeout: 15
  - type: brain
    taskClass: simple
    prompt: |
      The first line below is today's date; the rest is my subscriptions
      ledger (markdown). List every subscription whose renewal date falls
      within the next {days} days, one line each, EXACT: service, amount,
      renewal date, and how many days away it is. Sort soonest first.
      If none are due in that window, reply exactly "No renewals in the
      next {days} days." If the ledger is missing or has no parseable
      entries, say so plainly. Never invent an entry. Plain text only.

      {shell_output}
  - type: notify
    category: skills
    title: Subscription renewals
    message: "{brain_output}"
---

Runs daily at 9am (`confirm: none` is required for a scheduled skill to fire
unattended). The push goes through the `skills` notification category, and
the same summary lands in the daily-briefing context via run history.

## The ledger

Keep a plain markdown list at `reference/subscriptions.md` in your notes/
vault dir (PARA `reference/` folder). One line per subscription - the brain
parses it, so the exact format is forgiving, but include the three facts:

```markdown
# Subscriptions

- Netflix - £10.99/mo - renews the 12th of each month
- iCloud+ 200GB - £2.99/mo - renews 2026-07-08
- Domain jarvis.dev - £12/yr - renews 2026-11-02
- Gym - £24/mo - renews the 1st
```

Change the `days` look-ahead or the ledger path when running it manually, or
edit the defaults above. Amounts/dates are pushed exactly as written in the
ledger - the skill never invents numbers (Phase O exactness rule).
