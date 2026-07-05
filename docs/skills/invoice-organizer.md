---
name: Invoice Organizer
icon: folder
description: Find invoice/receipt files in ~/Downloads and move them into an organized folder. Dry-run by default.
confirm: typed
params:
  - name: dryRun
    type: string
    label: "Dry run (true = report only, false = actually move)"
    default: "true"
  - name: dest
    type: string
    label: "Destination folder"
    default: "$HOME/Documents/Invoices"
steps:
  - type: shell
    label: "Scan ~/Downloads (move when dryRun=false)"
    command: |
      matches=$(find "$HOME/Downloads" -maxdepth 1 -type f \( -iname '*invoice*' -o -iname '*receipt*' -o -iname '*bill*' -o -iname '*statement*' \))
      if [ -z "$matches" ]; then
        echo "No invoice-like files in ~/Downloads."
      elif [ "{dryRun}" = "false" ]; then
        year=$(date '+%Y')
        mkdir -p "{dest}/$year"
        echo "$matches" | while IFS= read -r f; do
          mv -n "$f" "{dest}/$year/" && echo "moved: $(basename "$f")"
        done
        echo "Done. Files are in {dest}/$year/"
      else
        echo "DRY RUN - would move these to {dest}/$(date '+%Y')/ (set dryRun=false to do it):"
        echo "$matches"
      fi
    cwd: "~"
    timeout: 60
  - type: notify
    category: skills
    title: Invoice organizer
    message: "{shell_output}"
---

`confirm: typed` because the non-dry run moves files: running it requires
retyping "Invoice Organizer" exactly, and voice/phone/scheduled triggers can
never fire it (the engine enforces this server-side). Two independent
safeties, both must be disarmed: the typed confirmation AND `dryRun=false` -
the default run only reports what it would do.

Matching is by filename pattern (invoice/receipt/bill/statement, any case),
top level of `~/Downloads` only, and `mv -n` never overwrites an existing
file at the destination.

<!-- ponytail: filename-pattern matching only; add a brain `simple` step to
classify ambiguous files if the pattern misses too much. -->
