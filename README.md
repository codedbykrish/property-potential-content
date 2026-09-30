# Property Potential content agent

Turns a UK property and **photos you own or have permission to use** into a fact-checked, 9:16 Reel draft that waits for your approval. Nothing is published automatically.

This repository is separate from the Property Potential app and never reads from, writes to, or deploys it.

```
brief (listing URL + your photos + your facts)
  → intake        read the listing's text only (never its photos), save a snapshot
  → photos        copy your photos, strip EXIF/GPS, label rooms and quality (Claude vision)
  → facts         extract facts with their sources (Claude)
  → verify        check them with code: listing snapshot, postcodes.io, Land Registry, EPC register
  → angle         3 angles with a worthiness score; weak properties stop here
  → script        hook, beats, close, CTA; every number must trace to a fact (claim gate)
  → visuals       Ken Burns on your photos; optional labelled AI stills / camera motion (Runway)
  → voice         ElevenLabs, one file per line, with word timings
  → render        Remotion: MP4 with captions and fact overlays, thumbnail, .srt
  → qc            format, duration, claim gate, photo rights, AI labels, captions, silences
  → review        local page: watch it, read the fact record, approve / request changes / reject
```

## Quick start

```bash
npm install
npm test

# Try the whole pipeline offline with placeholder photos (template script, silent voice):
npm run pp-content -- new examples/sample/brief.yaml --mock
npm run pp-content -- review          # http://127.0.0.1:4321
```

For a real Reel, copy `.env.example` to `.env`, add at least `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY`, then:

```bash
cp examples/brief.example.yaml my-property/brief.yaml   # add your photos to my-property/photos
npx tsx --env-file=.env src/cli.ts new my-property/brief.yaml
npx tsx --env-file=.env src/cli.ts review
```

After you approve on the review page, `npm run pp-content -- export <jobId>` copies `reel.mp4`, `thumbnail.jpg`, `captions.srt`, `caption.txt` and `fact-record.json` to `out/<jobId>/` for posting by hand.

## Commands

| Command | What it does |
| --- | --- |
| `new <brief.yaml> [--no-ai-visuals] [--force] [--mock]` | Make a new Reel. `--force` continues past a low worthiness score. |
| `rerun <jobId> --from <stage>` | Re-run from a stage, e.g. `--from script` after requesting changes. |
| `list`, `show <jobId>` | Jobs, stage costs, QC results, notes. |
| `review [--port]` | Local review page (binds to 127.0.0.1 only). |
| `decide <jobId> approve\|changes\|reject --note "..."` | Decide from the terminal. |
| `export <jobId>` | Files for posting, approved Reels only. |

## Rules the code enforces

- **Photos:** local files only, with `rights: owned` or `rights: permission` plus a note saying who agreed and when. Listing photos are never downloaded.
- **Portals:** Rightmove, Zoopla, OnTheMarket and PrimeLocation URLs are refused (their terms forbid automated access).
- **Facts:** statuses match the app's `field_provenance` (VERIFIED, ESTIMATE, AI_SUGGESTION, USER_SUPPLIED, UNKNOWN). Only VERIFIED and USER_SUPPLIED facts may be stated; ESTIMATE needs "around"/"about"; a listing claim is VERIFIED only "as advertised" and must be attributed ("listed at"). Conflicts are kept and shown.
- **AI visuals:** generic only (never the property itself), at most 2 per Reel, labelled "AI-generated" on screen. Camera motion on your photo is prompted to change nothing.
- **Approval:** only on the latest render, only if QC error checks pass, never for renders made with mock providers. The Supabase schema enforces the approval rule too.

## Storage

Jobs live in `data/jobs/<jobId>/` (`job.json` plus files). If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, every stage also mirrors the job into the content agent's own Supabase project. Apply `supabase/migrations/` to a **new** Supabase project first.

## Not built yet

Automatic publishing (Instagram, TikTok), analytics and learning, property discovery, and the Property Potential app as a source. The job record already carries what they need (`approved` status, caption, hashtags, fact record, angle and feature data).

## Costs

Roughly $0.40 to $1 per Reel without Runway (Claude about $0.30 to $0.80, ElevenLabs under $0.15) and $2.50 to $6 with it. Each stage logs its cost; see `show <jobId>`.
