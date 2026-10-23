# Autopilot — standing instructions for scheduled build runs

Authorised by Shiva on 2026-10-24 ("self manage and take full control"). Every scheduled run reads this
file and `STATUS.md` first. Shiva can stop autopilot at any time by saying "stop autopilot".

## Order of work

After M0, M1, M7 (done), follow the spec order: **M2 → M3 → M4 → M5 → M6 → M8 → M9 → M10**.
Finish each milestone's Definition of Done (REQUIREMENTS.md §12) before starting the next.

## Each run

1. Read `STATUS.md`, `docs/AUTOPILOT.md`, the latest `docs/CHANGELOG.md` entry, and `git log -5`.
2. Make sure local infra is up (`colima start`, `pnpm infra:up`) if tests need it.
3. Do the next chunk of the current milestone: small, reviewable steps, each committed when
   lint + typecheck + tests pass.
4. Before ending the run: format, run the gates, commit, push to `origin main`, update `STATUS.md`
   (and CHANGELOG / DECISIONS / `docs/demos/M<n>.md` when a milestone finishes).
5. Refresh the pinned dashboard report: `show_widget` with name `datascribe-status`, `pin: true`,
   `size: lg` (metrics, a milestone % bar chart, a milestone table and a "Waiting on Shiva" table),
   built from STATUS.md.
6. Send Shiva a short Telegram report (channel telegram, target 1394929787): what changed, commits,
   test counts, anything blocked. Only send a report when something changed or something is blocked.

## Pre-approved (inside `~/projects/datascribe` only)

- Creating and editing files; deleting files this project created when replacing them.
- Installing npm packages that the REQUIREMENTS.md §2 tech stack names (or that it directly needs),
  with the reason in `docs/DECISIONS.md` when it isn't named.
- Database migrations on the Datascribe Docker Postgres (port 5433) and its `_test` / `_e2e` databases.
- Commits and pushes to the private GitHub repo.

## Never, even on autopilot (stop and ask Shiva)

- Listening on port **3000** (tunnelled publicly to crm.stayspot.app; Datascribe web dev uses 3010).
- Touching the Postgres on port **5432** (Shiva's existing CRM) or anything outside the project
  and the agent workspace.
- Real email, messages to anyone other than Shiva, deploying or publishing anything public, payments,
  live Stripe keys, or real PHI. Synthetic data only. Mailpit only.
- Calling real external medical APIs except the optional live smoke tests that the spec allows, with
  synthetic terms only.
- Changing OpenClaw config, installing skills or plugins, or system-wide (Homebrew/admin) installs.
- Choices that affect security, PHI handling, money or the data model in a hard-to-undo way (§0 rule 9).

## Limits

- Stop after 3 consecutive failures of the same step and report the exact error.
- Don't loop on a blocker: report it once, mark it in `STATUS.md` under "Waiting on Shiva", and move to
  other unblocked work in the same milestone if there is any.
- When M10 is done, or everything left is blocked on Shiva, report and pause (no further changes).
