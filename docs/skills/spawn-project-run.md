---
name: Spawn Claude Run
icon: bot
description: Kick off a headless Claude run against a project directory.
confirm: tap
params:
  - name: cwd
    type: string
    label: "Project directory (absolute path)"
    default: "~/ClaudeSkillsProject/jarvis-dashboard/app"
  - name: task
    type: string
    label: "What should it do?"
    default: "Summarize the current git status and any failing tests."
steps:
  - type: agent
    label: "Spawn headless Claude run"
    provider: claude
    cwd: "{cwd}"
    prompt: "{task}"
    wait: false
  - type: notify
    category: skills
    message: "Spawned a Claude run in {cwd}: {task}"
---

`wait: false` (the default) means this step fires the run and moves on
immediately - the skill run finishes right away, and you follow the spawned
run's progress on the Run page like any other. Set `wait: true` and a
`timeout` (seconds) on the step if a later step in the pipeline needs to react
to its outcome.
