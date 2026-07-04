---
name: Downloads Cleanup
icon: terminal
description: Delete files older than 30 days from ~/Downloads.
confirm: typed
params:
  - name: days
    type: string
    label: "Delete files older than (days)"
    default: "30"
steps:
  - type: shell
    label: "Find + delete old downloads"
    command: "find ~/Downloads -maxdepth 1 -type f -mtime +{days} -print -delete"
    cwd: "~"
    timeout: 60
  - type: notify
    category: skills
    message: "Downloads cleanup finished."
---

`confirm: typed` because this deletes files - running it (from the Skills
page or the API) requires retyping "Downloads Cleanup" exactly. Voice and
phone triggers can never fire this skill regardless of confirmation text: the
engine's safety model refuses any `voice`/`phone`/`schedule` trigger unless a
skill is `confirm: none`.
