# Example skills

Skills (Phase H of `PLAN-jarvis-master.md`) are markdown files with YAML
frontmatter, living in a folder on disk (default `~/JarvisSkills`, configurable
from the Skills page). Copy any of these into that folder - or paste their
contents into "New skill" on the Skills page - to try them.

A skill is a straight pipeline of steps: `shell` (run a local command),
`agent` (spawn a Claude/Gemini run), `brain` (one mini-Jarvis call), `notify`
(a push notification), and `phone` (a push that hands off to an iOS Shortcut).
Step outputs interpolate into later steps as `{stepN_output}` or
`{<type>_output}` (e.g. `{shell_output}`, `{brain_output}` - the last step of
that type wins if there's more than one).

`confirm` sets who may run it:

- `none` - anyone/anything: a tap, a voice command ("Hey Siri, Jarvis, run
  skill downloads cleanup"), a phone push, or its own `schedule`.
- `tap` - a human must tap Run in the Skills page (the default).
- `typed` - a human must retype the skill's name before it runs (use this for
  anything destructive).

Voice, phone, and scheduled triggers can **only** ever fire a `confirm: none`
skill - the server enforces this (`server/lib/skills/engine.js`), not just the
UI, so there's no way to accidentally wire a destructive skill to an
unattended trigger.

## The seed skills

- **`daily-briefing.md`** - `confirm: none`, scheduled at 7am daily. A `brain`
  step composes a short briefing, a `notify` step pushes it. This is what
  makes Phase J's morning briefing "just a skill."
- **`downloads-cleanup.md`** - `confirm: typed` (it deletes files) with a
  `shell` step. Not scheduled - a human runs this deliberately.
- **`spawn-project-run.md`** - `confirm: tap`, an `agent` step that spawns a
  headless Claude run against a project directory with a templated prompt
  (fill in the `{task}` param when you run it).
- **`subscription-renewals.md`** (Phase V) - `confirm: none`, scheduled at 9am
  daily. A `shell` step reads your `reference/subscriptions.md` ledger note, a
  `brain` step (simple tier) finds renewals due in the next `{days}` days, a
  `notify` step pushes them with exact amounts/dates. The ledger format is
  documented in the skill body.
- **`invoice-organizer.md`** (Phase V) - `confirm: typed` with a dry-run
  default: reports the invoice/receipt-looking files in `~/Downloads` it
  *would* move; set `dryRun=false` (plus the typed confirmation) to actually
  move them into `~/Documents/Invoices/<year>/` (`mv -n`, never overwrites).
