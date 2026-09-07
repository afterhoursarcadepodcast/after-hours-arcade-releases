# After Hours Arcade release feed

This repository refreshes `data/weekly-releases.json` every Monday at 8:00 AM
America/New_York. The public After Hours Arcade website reads that file directly,
so the release radar updates even when the studio computer is off.

## Required repository secrets

Add these under **Settings → Secrets and variables → Actions**:

- `IGDB_CLIENT_ID`
- `IGDB_CLIENT_SECRET`

Both values come from a Twitch developer application and are used only by the
scheduled GitHub runner to query IGDB's cross-platform game database.

The workflow can also be run manually from the Actions tab. Missing or delayed
records can be corrected in `data/manual-overrides.json`; those entries are merged
into the generated feed on every run.
